#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Lock the Docker-published Caddy ingress ports so they're reachable ONLY from
# Cloudflare — preventing anyone from hitting the origin port directly and
# bypassing Cloudflare's WAF/rate-limiting.
#
# IMPORTANT: UFW does NOT filter Docker-published ports — Docker installs its
# own iptables rules ahead of UFW's. So we filter in the DOCKER-USER chain,
# which Docker explicitly leaves for operators and honours. (UFW is still fine
# for host processes like Apache on :443 — just not for container ports.)
#
# Idempotent: uses a dedicated CLOUDFLARE-INGRESS chain that is flushed and
# rebuilt each run.
#
# Usage (on the server, as root):
#   sudo bash firewall-cloudflare-ports.sh
#   sudo PORTS=8443,2053,2083,2087,2096 bash firewall-cloudflare-ports.sh   # custom set
#
# Default ports: neflo 8443 · vote 2053 · daybook 2083 · otuburu 2087.
# ---------------------------------------------------------------------------
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "✗ run with sudo/root"; exit 1; }
command -v curl >/dev/null || { echo "✗ curl required"; exit 1; }

PORTS="${PORTS:-8443,2053,2083,2087}"
CHAIN=CLOUDFLARE-INGRESS

apply() { # <iptables|ip6tables> <cloudflare-ips-url>
  local IPT="$1" URL="$2"
  if ! $IPT -L DOCKER-USER -n >/dev/null 2>&1; then
    echo "  ⚠ $IPT: no DOCKER-USER chain (Docker not managing $IPT?) — skipping"
    return 0
  fi
  # Build the allow/deny chain fresh.
  $IPT -N "$CHAIN" 2>/dev/null || $IPT -F "$CHAIN"
  local n=0
  while read -r cidr; do
    [ -n "$cidr" ] || continue
    $IPT -A "$CHAIN" -s "$cidr" -j RETURN
    n=$((n+1))
  done < <(curl -fsS "$URL")
  [ "$n" -gt 0 ] || { echo "✗ $IPT: fetched 0 Cloudflare ranges from $URL"; return 1; }
  $IPT -A "$CHAIN" -j DROP
  # Send our ports through the chain (insert once, at the top of DOCKER-USER).
  if ! $IPT -C DOCKER-USER -p tcp -m multiport --dports "$PORTS" -j "$CHAIN" 2>/dev/null; then
    $IPT -I DOCKER-USER -p tcp -m multiport --dports "$PORTS" -j "$CHAIN"
  fi
  echo "  ✓ $IPT: $n Cloudflare ranges → ports $PORTS (rest dropped)"
}

echo "▶ locking ports $PORTS to Cloudflare in DOCKER-USER…"
apply iptables  https://www.cloudflare.com/ips-v4
apply ip6tables https://www.cloudflare.com/ips-v6   # best-effort (skips if no IPv6 Docker)

cat <<'NOTE'

✓ done. These iptables rules do NOT survive a reboot or a Docker daemon
  restart on their own. Persist them with one of:
    apt-get install -y iptables-persistent && netfilter-persistent save
  or re-run this script from a systemd unit ordered After=docker.service.
NOTE
