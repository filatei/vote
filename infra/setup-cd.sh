#!/usr/bin/env bash
# ============================================================================
# One-time CD authorization (run ON THE SERVER as the admin user, with sudo).
#
# Authorizes a GitHub Actions deploy key to trigger ONLY infra/deploy.sh — it
# cannot get a shell or run anything else — and grants a single scoped NOPASSWD
# sudo rule for that script. After this, every push to main that passes CI
# redeploys automatically.
#
# Usage:
#   sudo bash /opt/vote/infra/setup-cd.sh "ssh-ed25519 AAAA...== vote-cd@github"
#
# The argument is the PUBLIC key whose PRIVATE half you stored in the GitHub
# repo secret DEPLOY_SSH_KEY (see infra/CD-SETUP.md step 1–2).
# ============================================================================
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }

PUBKEY="${1:?Usage: sudo bash setup-cd.sh \"<cd public key line>\"}"
ADMIN="${SUDO_USER:-root}"
APP_DIR="/opt/vote"
DEPLOY="$APP_DIR/infra/deploy.sh"

[[ "$PUBKEY" == ssh-* ]] || { echo "That doesn't look like an SSH public key line." >&2; exit 1; }

echo "==> Making sure the repo + deploy script are present"
sudo -u vote -H git -C "$APP_DIR" pull --ff-only origin main || true
[[ -f "$DEPLOY" ]] || { echo "ERROR: $DEPLOY missing — pull the latest main first." >&2; exit 1; }
chmod +x "$DEPLOY"

echo "==> Authorizing the CD key for '$ADMIN' (locked to the deploy command)"
SSH_DIR="/home/$ADMIN/.ssh"
[[ "$ADMIN" == "root" ]] && SSH_DIR="/root/.ssh"
install -d -m 700 -o "$ADMIN" -g "$ADMIN" "$SSH_DIR"
AK="$SSH_DIR/authorized_keys"
touch "$AK"
# drop any prior entry for this exact key, then add the locked-down line
grep -vF "$PUBKEY" "$AK" > "$AK.tmp" 2>/dev/null || true
mv "$AK.tmp" "$AK"
printf '%s %s\n' \
  'command="sudo '"$DEPLOY"'",no-agent-forwarding,no-port-forwarding,no-x11-forwarding,no-pty' \
  "$PUBKEY" >> "$AK"
chmod 600 "$AK"; chown "$ADMIN:$ADMIN" "$AK"

echo "==> Granting scoped passwordless sudo for just the deploy script"
echo "$ADMIN ALL=(root) NOPASSWD: $DEPLOY" > /etc/sudoers.d/vote-deploy
chmod 440 /etc/sudoers.d/vote-deploy
visudo -c >/dev/null

echo
echo "CD authorized. Quick local test:"
echo "  sudo $DEPLOY"
echo "Then push to main and watch: https://github.com/filatei/vote/actions"
