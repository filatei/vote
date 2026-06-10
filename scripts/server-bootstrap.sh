#!/usr/bin/env bash
# ============================================================================
# Torama Vote — server bootstrap (run ON THE SERVER as root, via sudo)
#
# Creates the `vote` deploy user, installs your SSH public key, adds it to the
# docker group, prepares /opt/vote, and generates a GitHub deploy key so the
# vote user can pull filatei/vote.
#
# This is normally invoked for you by scripts/setup-local-ssh.sh, but you can
# also run it by hand:
#   sudo bash server-bootstrap.sh /tmp/your_key.pub
# ============================================================================
set -euo pipefail

PUBKEY_FILE="${1:?Usage: sudo bash server-bootstrap.sh <path-to-your-public-key.pub>}"
VOTE_USER="vote"
REPO="git@github.com:filatei/vote.git"
APP_DIR="/opt/vote"

[[ $EUID -eq 0 ]] || { echo "ERROR: run as root (use sudo)." >&2; exit 1; }
[[ -f "$PUBKEY_FILE" ]] || { echo "ERROR: public key not found: $PUBKEY_FILE" >&2; exit 1; }

echo "==> Ensuring git is installed"
if ! command -v git >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq git
fi

echo "==> Creating user '$VOTE_USER' (key-only, no password login)"
if ! id -u "$VOTE_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "Torama Vote deploy" "$VOTE_USER"
fi

echo "==> Installing your SSH key for '$VOTE_USER'"
install -d -m 700 -o "$VOTE_USER" -g "$VOTE_USER" "/home/$VOTE_USER/.ssh"
AUTHKEYS="/home/$VOTE_USER/.ssh/authorized_keys"
touch "$AUTHKEYS"
KEYCONTENT="$(cat "$PUBKEY_FILE")"
if ! grep -qxF "$KEYCONTENT" "$AUTHKEYS" 2>/dev/null; then
  echo "$KEYCONTENT" >> "$AUTHKEYS"
fi
chmod 600 "$AUTHKEYS"
chown "$VOTE_USER:$VOTE_USER" "$AUTHKEYS"

echo "==> Adding '$VOTE_USER' to the docker group"
getent group docker >/dev/null 2>&1 || groupadd docker
usermod -aG docker "$VOTE_USER"

echo "==> Preparing $APP_DIR (owned by $VOTE_USER)"
install -d -o "$VOTE_USER" -g "$VOTE_USER" "$APP_DIR"

echo "==> Generating a GitHub deploy key for '$VOTE_USER'"
DEPLOY_KEY="/home/$VOTE_USER/.ssh/github_deploy"
if [[ ! -f "$DEPLOY_KEY" ]]; then
  sudo -u "$VOTE_USER" ssh-keygen -t ed25519 -N "" -C "vote-deploy@torama.money" -f "$DEPLOY_KEY"
fi
SSHCFG="/home/$VOTE_USER/.ssh/config"
if ! grep -q "Host github.com" "$SSHCFG" 2>/dev/null; then
  cat >> "$SSHCFG" <<EOF
Host github.com
    HostName github.com
    User git
    IdentityFile $DEPLOY_KEY
    IdentitiesOnly yes
EOF
fi
chown "$VOTE_USER:$VOTE_USER" "$SSHCFG"; chmod 600 "$SSHCFG"
# Trust GitHub's host key so the first clone isn't interactive.
sudo -u "$VOTE_USER" bash -c \
  "ssh-keyscan -t rsa,ed25519 github.com >> /home/$VOTE_USER/.ssh/known_hosts 2>/dev/null" || true
chown "$VOTE_USER:$VOTE_USER" "/home/$VOTE_USER/.ssh/known_hosts" 2>/dev/null || true

echo
echo "================  ADD THIS DEPLOY KEY TO GITHUB  ================"
echo "  Open:  https://github.com/filatei/vote/settings/keys/new"
echo "  Title: vote.torama.money"
echo "  (Tick 'Allow write access' only if you'll push from the server.)"
echo
echo "  Public key:"
echo
cat "$DEPLOY_KEY.pub"
echo
echo "================================================================"
echo
echo "Then clone the repo as the vote user:"
echo "  sudo -u $VOTE_USER -H git clone $REPO $APP_DIR"
echo
echo "Bootstrap complete. From your Mac you can now:  ssh vote"
echo "(group membership for docker takes effect on the next login)"
