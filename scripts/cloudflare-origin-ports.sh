#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Create/maintain Cloudflare ORIGIN RULES that send each app's hostname to its
# own origin port (so each app's Caddy ingress is reached instead of the shared
# Apache on :443). Idempotent and non-destructive: it preserves any origin rules
# you created by hand and only manages rows tagged "torama-ingress:<host>".
#
# DRY-RUN BY DEFAULT — prints the payload it would PUT. Set CONFIRM=1 to apply.
#
# Token: a Cloudflare API token with **Zone : Config Rules : Edit** (Origin
# Rules) and **Zone : Zone : Read**, scoped to torama.money.
#   export CF_API_TOKEN=xxxxxxxx
#   bash scripts/cloudflare-origin-ports.sh            # dry-run (shows payload)
#   CONFIRM=1 bash scripts/cloudflare-origin-ports.sh  # apply
#
# Port map (Cloudflare proxy-compatible HTTPS origin ports only):
#   neflo 8443 · vote 2053 · daybook 2083 · otuburu 2087   (2096 spare)
# ---------------------------------------------------------------------------
set -euo pipefail

ZONE="${ZONE:-torama.money}"
API="https://api.cloudflare.com/client/v4"
PHASE="http_request_origin"

# host:port pairs this script manages.
MAP=(
  "neflo.torama.money:8443"
  "vote.torama.money:2053"
  "daybook.torama.money:2083"
  "otuburu.torama.money:2087"
)

: "${CF_API_TOKEN:?Set CF_API_TOKEN (Zone:Config Rules:Edit + Zone:Read)}"
command -v jq >/dev/null || { echo "jq is required (brew install jq)"; exit 1; }
auth=(-H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json")

zone_id="$(curl -fsS "${API}/zones?name=${ZONE}" "${auth[@]}" | jq -r '.result[0].id // empty')"
[[ -n "$zone_id" ]] || { echo "✗ zone ${ZONE} not found on this token"; exit 1; }
echo "zone ${ZONE} → ${zone_id}"

# Existing rules in the origin phase entrypoint (empty if the ruleset doesn't
# exist yet). Drop our previously-managed rows so re-runs don't duplicate.
existing="$(curl -fsS "${API}/zones/${zone_id}/rulesets/phases/${PHASE}/entrypoint" "${auth[@]}" 2>/dev/null \
  | jq -c '[.result.rules[]? | select((.description // "") | startswith("torama-ingress:") | not)]' 2>/dev/null || echo '[]')"
[[ -n "$existing" ]] || existing='[]'

# Build our managed rules.
managed='[]'
for pair in "${MAP[@]}"; do
  host="${pair%:*}"; port="${pair##*:}"
  rule="$(jq -nc --arg h "$host" --argjson p "$port" '{
    expression: ("(http.host eq \"" + $h + "\")"),
    description: ("torama-ingress:" + $h),
    action: "route",
    action_parameters: { origin: { port: $p } },
    enabled: true
  }')"
  managed="$(jq -c ". + [${rule}]" <<<"$managed")"
done

payload="$(jq -nc --argjson keep "$existing" --argjson mine "$managed" '{rules: ($keep + $mine)}')"

echo "── origin-rule payload (${PHASE} entrypoint) ──"
jq . <<<"$payload"

if [[ "${CONFIRM:-0}" != "1" ]]; then
  echo
  echo "DRY-RUN. Re-run with CONFIRM=1 to apply."
  exit 0
fi

echo "▶ applying…"
curl -fsS -X PUT "${API}/zones/${zone_id}/rulesets/phases/${PHASE}/entrypoint" \
  "${auth[@]}" --data "$payload" | jq -e '.success == true' >/dev/null \
  && echo "✓ origin rules updated" \
  || { echo "✗ update failed"; exit 1; }
