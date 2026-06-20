#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Put vote + otuburu behind Cloudflare's proxy and set safe TLS defaults, via
# the Cloudflare API. Idempotent — re-running just re-asserts the same state.
#
# The connected Cloudflare MCP only covers compute/storage (Workers/KV/R2/D1),
# not DNS/zone settings, so we use the REST API with a scoped token.
#
# Create a token at https://dash.cloudflare.com/profile/api-tokens with:
#   Zone : DNS            : Edit
#   Zone : Zone Settings  : Edit
#   Zone : Zone           : Read
#   (Zone Resources → Include → Specific zone → torama.money)
#
# Usage:
#   export CF_API_TOKEN=xxxxxxxx
#   bash scripts/cloudflare-setup.sh            # defaults: torama.money, vote+otuburu
#   ZONE=torama.money HOSTS="vote.torama.money otuburu.torama.money" \
#     bash scripts/cloudflare-setup.sh
# ---------------------------------------------------------------------------
set -euo pipefail

ZONE="${ZONE:-torama.money}"
HOSTS="${HOSTS:-vote.torama.money otuburu.torama.money}"
API="https://api.cloudflare.com/client/v4"

: "${CF_API_TOKEN:?Set CF_API_TOKEN (scoped: DNS Edit + Zone Settings Edit + Zone Read)}"
command -v jq >/dev/null || { echo "jq is required (brew install jq)"; exit 1; }

auth=(-H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json")

api() { # METHOD PATH [JSON]
  local method="$1" path="$2" data="${3:-}"
  if [[ -n "$data" ]]; then
    curl -fsS -X "$method" "${API}${path}" "${auth[@]}" --data "$data"
  else
    curl -fsS -X "$method" "${API}${path}" "${auth[@]}"
  fi
}

ok() { jq -e '.success == true' >/dev/null; }

echo "▶ Resolving zone '${ZONE}'…"
zone_id="$(api GET "/zones?name=${ZONE}&status=active" | jq -r '.result[0].id // empty')"
[[ -n "$zone_id" ]] || { echo "✗ zone ${ZONE} not found on this token"; exit 1; }
echo "  zone id ${zone_id}"

# ── 1. Proxy each host's A/AAAA records (orange cloud) ─────────────────────
for host in $HOSTS; do
  echo "▶ Proxying ${host}…"
  recs="$(api GET "/zones/${zone_id}/dns_records?name=${host}&type=A")"
  recs6="$(api GET "/zones/${zone_id}/dns_records?name=${host}&type=AAAA")"
  ids="$(jq -r '.result[].id' <<<"$recs"; jq -r '.result[].id' <<<"$recs6")"
  [[ -n "${ids// /}" ]] || { echo "  ⚠ no A/AAAA record for ${host} — skipping"; continue; }
  for id in $ids; do
    api PATCH "/zones/${zone_id}/dns_records/${id}" '{"proxied":true}' | ok \
      && echo "  ✓ ${host} (${id}) → proxied" \
      || echo "  ✗ ${host} (${id}) patch failed"
  done
done

# ── 2. Zone TLS settings ───────────────────────────────────────────────────
set_setting() { # KEY VALUE
  printf '  %-22s' "$1=$2"
  if api PATCH "/zones/${zone_id}/settings/$1" "{\"value\":\"$2\"}" | ok; then
    echo "✓"
  else
    echo "✗ (check token has Zone Settings:Edit)"
  fi
}
# SSL mode is ZONE-WIDE (affects neflo + vote + otuburu together). Default to
# "full" so a not-yet-ready proxied origin (e.g. neflo before its Origin CA cert)
# isn't broken. Set SSL_MODE=strict once every proxied origin has a valid cert.
SSL_MODE="${SSL_MODE:-full}"
echo "▶ TLS settings…"
set_setting ssl "$SSL_MODE"         # full | strict (see CLOUDFLARE.md)
set_setting always_use_https on
set_setting min_tls_version 1.2
set_setting automatic_https_rewrites on

cat <<'NOTE'

Done. Reminders:
  • Cert renewal: with the proxy on, certbot HTTP-01 on :80 is 301'd by
    Cloudflare. Fix once by installing a Cloudflare Origin CA cert (15-yr, no
    renewal) on the origin, OR switch certbot to DNS-01. See CLOUDFLARE.md.
  • On the server, enable real-IP: sudo a2enmod remoteip && sudo systemctl reload apache2
  • Webhooks (POST /webhooks/squad-hub, /payments/squad/webhook) and the
    otuburu /ws WebSocket pass through the proxy unchanged.
NOTE
