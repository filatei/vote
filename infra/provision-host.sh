#!/usr/bin/env bash
# ============================================================================
# One-time host provisioning for the shared Linode box.
# Installs Docker, Apache and certbot, enables the Apache modules the
# reverse-proxy vhosts need, creates the app/port registry, and (by default)
# hardens SSH to key-only + no root login.
#
# Run once as root:  sudo bash infra/provision-host.sh
# Skip the SSH hardening:  sudo bash infra/provision-host.sh --no-harden
# Only run the hardening (e.g. after setting up your key):
#                          sudo bash infra/provision-host.sh --harden-only
# Safe to re-run (idempotent).
# ============================================================================
set -euo pipefail

case "${1:-}" in -h|--help) sed -n '2,12p' "$0"; exit 0;; esac
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }

DO_HARDEN=1
HARDEN_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-harden)   DO_HARDEN=0;;
    --harden-only) HARDEN_ONLY=1;;
    -h|--help)     sed -n '2,12p' "$0"; exit 0;;
    *) echo "Unknown option: $arg" >&2; exit 1;;
  esac
done

REGISTRY_DIR="/opt/.app-registry"
PORTS_FILE="$REGISTRY_DIR/ports.tsv"

# ---------------------------------------------------------------------------
# SSH hardening — key-only auth, no root login. Guarded against lockout: it
# will NOT disable password auth unless the invoking admin user already has a
# non-empty authorized_keys file (i.e. key login is proven to be set up).
# ---------------------------------------------------------------------------
harden_ssh() {
  local admin="${SUDO_USER:-root}"
  local akf="/root/.ssh/authorized_keys"
  [[ "$admin" != "root" ]] && akf="/home/$admin/.ssh/authorized_keys"

  echo "==> Hardening SSH (admin user: $admin)"
  if [[ ! -s "$akf" ]]; then
    cat >&2 <<EOF
   !! SKIPPED — no SSH key found for '$admin' at:
        $akf
      Disabling password auth now would risk locking you out.
      Set up key login for '$admin' first, e.g. from your Mac:
        ssh-copy-id $admin@<this-host>
      then re-run:  sudo bash infra/provision-host.sh --harden-only
EOF
    return 0
  fi

  local dropin=/etc/ssh/sshd_config.d/00-hardening.conf
  cat > "$dropin" <<'EOF'
# Managed by provision-host.sh — SSH hardening (key-only, no root login).
# Drop-in files load before the rest of sshd_config and first value wins,
# so the 00- prefix makes these settings authoritative over cloud defaults.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
EOF
  chmod 644 "$dropin"

  if sshd -t 2>/dev/null; then
    # reload (not restart) so the current session is never dropped
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    echo "   SSH hardened: root login + password auth disabled (key-only)."
    echo "   Keep this session open and confirm a NEW 'ssh' login works before"
    echo "   closing it. To revert: sudo rm $dropin && sudo systemctl reload ssh"
  else
    echo "   !! sshd config test failed — removing drop-in to stay safe." >&2
    rm -f "$dropin"
    return 1
  fi
}

if [[ $HARDEN_ONLY -eq 1 ]]; then
  harden_ssh
  exit 0
fi

echo "==> Installing packages"
apt-get update -qq
apt-get install -y -qq \
  docker.io docker-compose-plugin \
  apache2 certbot python3-certbot-apache \
  git

echo "==> Enabling services"
systemctl enable --now docker apache2

echo "==> Enabling Apache modules for reverse proxying + TLS"
a2enmod proxy proxy_http headers ssl rewrite >/dev/null
systemctl reload apache2

echo "==> Creating app/port registry at $PORTS_FILE"
install -d -m 755 "$REGISTRY_DIR"
if [[ ! -f "$PORTS_FILE" ]]; then
  printf "app\tsubdomain\tport\n" > "$PORTS_FILE"
fi

if [[ $DO_HARDEN -eq 1 ]]; then
  harden_ssh
fi

echo
echo "Host provisioned."
echo
echo "STRONGLY RECOMMENDED — add a wildcard DNS record so new subdomains need"
echo "zero DNS work:    *.torama.money   A   <this server's IP>"
echo "Then every new app is a single new-app.sh call (HTTP-01 certs just work)."
