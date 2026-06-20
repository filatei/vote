#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Install a Cloudflare Origin CA cert on this host and point one or more Apache
# vhosts at it. Safe: backs up each vhost, runs `apache2ctl configtest`, and
# rolls back + aborts if the config is invalid (so it never leaves Apache down).
#
# All torama.money apps share ONE host + ONE Apache, so the cert is installed
# once and every vhost can reference it.
#
# Usage (run on the server, as root):
#   sudo bash install-origin-cert.sh <origin-cert.pem> <origin-key.pem> [vhost.conf ...]
#
# Examples:
#   # install the cert and repoint all three vhosts in one go
#   sudo bash install-origin-cert.sh ./origin.pem ./origin.key \
#     /etc/apache2/sites-available/vote.torama.money.conf \
#     /etc/apache2/sites-available/otuburu.conf \
#     /etc/apache2/sites-available/neflo.torama.money-le-ssl.conf
#
#   # just (re)install the cert + reload (vhosts already reference the paths)
#   sudo bash install-origin-cert.sh ./origin.pem ./origin.key
#
# Prerequisite: the host(s) must already be PROXIED in Cloudflare — an Origin CA
# cert is only trusted by Cloudflare, so direct (DNS-only) HTTPS would be
# untrusted. See CLOUDFLARE.md.
# ---------------------------------------------------------------------------
set -euo pipefail

CERT_SRC="${1:?usage: install-origin-cert.sh <cert.pem> <key.pem> [vhost.conf ...]}"
KEY_SRC="${2:?missing key path}"
shift 2

[ "$(id -u)" -eq 0 ] || { echo "✗ run with sudo/root"; exit 1; }
[ -f "$CERT_SRC" ] || { echo "✗ cert not found: $CERT_SRC"; exit 1; }
[ -f "$KEY_SRC" ]  || { echo "✗ key not found: $KEY_SRC"; exit 1; }

DEST_DIR=/etc/ssl/cloudflare
CERT="$DEST_DIR/torama.money.pem"
KEY="$DEST_DIR/torama.money.key"

mkdir -p "$DEST_DIR"
install -m 644 "$CERT_SRC" "$CERT"
install -m 600 "$KEY_SRC"  "$KEY"
echo "✓ installed $CERT"
echo "✓ installed $KEY (0600)"

backups=()
restore() {
  [ ${#backups[@]} -gt 0 ] || return 0
  echo "↩ restoring vhost backups…"
  for b in "${backups[@]}"; do cp -a "$b" "${b%.bak.*}"; done
}

for vh in "$@"; do
  [ -f "$vh" ] || { echo "✗ vhost not found: $vh"; restore; exit 1; }
  bak="$vh.bak.$(date +%s)"
  cp -a "$vh" "$bak"
  backups+=("$bak")
  # Repoint the single cert pair in this vhost to the Origin CA paths.
  sed -ri \
    -e "s#^([[:space:]]*SSLCertificateFile[[:space:]]+).*#\1$CERT#" \
    -e "s#^([[:space:]]*SSLCertificateKeyFile[[:space:]]+).*#\1$KEY#" \
    "$vh"
  echo "✓ repointed $vh  (backup: $bak)"
done

echo "▶ apache2ctl configtest"
if apache2ctl configtest; then
  systemctl reload apache2
  echo "✓ apache reloaded — Origin CA cert live"
else
  echo "✗ configtest FAILED — rolling back, Apache left untouched"
  restore
  apache2ctl configtest || true
  exit 1
fi
