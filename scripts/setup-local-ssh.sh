#!/usr/bin/env bash
# ============================================================================
# Torama Vote — local SSH setup (run this ON YOUR MAC)
#
# What it does:
#   1. Finds the existing SSH public key you want to reuse.
#   2. Adds a `vote` host alias to ~/.ssh/config so you can just `ssh vote`.
#   3. Uploads your public key + the server bootstrap script to user1@server
#      and runs the bootstrap with sudo (creates the `vote` user, installs your
#      key, sets up a GitHub deploy key, prepares /opt/vote).
#
# Usage:
#   bash scripts/setup-local-ssh.sh [path/to/your_key.pub]
#
# If no key path is given it auto-detects ~/.ssh/id_ed25519.pub then id_rsa.pub.
# Override the server / admin user with env vars if needed:
#   SERVER=vote.torama.money ADMIN_USER=user1 bash scripts/setup-local-ssh.sh
# ============================================================================
set -euo pipefail

SERVER="${SERVER:-vote.torama.money}"
ADMIN_USER="${ADMIN_USER:-user1}"
VOTE_USER="vote"
PUBKEY="${1:-}"

# --- 1. locate the public key to reuse -------------------------------------
if [[ -z "$PUBKEY" ]]; then
  for cand in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub" "$HOME/.ssh/id_ecdsa.pub"; do
    if [[ -f "$cand" ]]; then PUBKEY="$cand"; break; fi
  done
fi
if [[ -z "$PUBKEY" || ! -f "$PUBKEY" ]]; then
  echo "ERROR: No SSH public key found." >&2
  echo "  Pass one explicitly:  bash scripts/setup-local-ssh.sh ~/.ssh/your_key.pub" >&2
  echo "  Or create one first:  ssh-keygen -t ed25519 -C \"you@torama\"" >&2
  exit 1
fi
IDFILE="${PUBKEY%.pub}"   # private key = public key path without .pub
echo "Using key: $PUBKEY"

# --- 2. add ~/.ssh/config host alias 'vote' --------------------------------
SSH_CONFIG="$HOME/.ssh/config"
mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
touch "$SSH_CONFIG"; chmod 600 "$SSH_CONFIG"
if grep -qE "^[[:space:]]*Host[[:space:]]+vote([[:space:]]|$)" "$SSH_CONFIG"; then
  echo "Host alias 'vote' already in $SSH_CONFIG (left unchanged)."
else
  cat >> "$SSH_CONFIG" <<EOF

# Torama Vote production server (added by setup-local-ssh.sh)
Host vote
    HostName $SERVER
    User $VOTE_USER
    IdentityFile $IDFILE
    IdentitiesOnly yes
EOF
  echo "Added 'vote' host alias to $SSH_CONFIG"
fi

# --- 3. upload + run the bootstrap on the server ---------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOOTSTRAP="$SCRIPT_DIR/server-bootstrap.sh"
if [[ ! -f "$BOOTSTRAP" ]]; then
  echo "ERROR: $BOOTSTRAP not found (run from the repo root)." >&2
  exit 1
fi

echo
echo "Uploading your public key + bootstrap to ${ADMIN_USER}@${SERVER} ..."
scp "$PUBKEY" "$BOOTSTRAP" "${ADMIN_USER}@${SERVER}:/tmp/"

PUB_BASENAME="$(basename "$PUBKEY")"
echo
echo "Running bootstrap on the server (you may be prompted for ${ADMIN_USER}'s sudo password)..."
ssh -t "${ADMIN_USER}@${SERVER}" "sudo bash /tmp/server-bootstrap.sh /tmp/${PUB_BASENAME}"

echo
echo "----------------------------------------------------------------------"
echo "Local setup done. Once you've added the deploy key to GitHub (the server"
echo "printed it above), test your connection with:"
echo
echo "    ssh vote"
echo "----------------------------------------------------------------------"
