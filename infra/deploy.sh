#!/usr/bin/env bash
# ============================================================================
# Pull latest main and (re)deploy the vote stack.
#
# Invoked as root by CI via a forced-command SSH key + a scoped NOPASSWD
# sudoers rule — see infra/CD-SETUP.md. You can also run it by hand:
#   sudo /opt/vote/infra/deploy.sh
# ============================================================================
set -euo pipefail

APP_DIR="/opt/vote"
APP_USER="vote"
cd "$APP_DIR"

echo "[deploy] $(date -u +%FT%TZ) pulling latest main"
# Pull as the app user so the GitHub deploy key + repo ownership are correct.
sudo -u "$APP_USER" -H git -C "$APP_DIR" pull --ff-only origin main

echo "[deploy] building + starting containers"
docker compose up -d --build

echo "[deploy] pruning dangling images"
docker image prune -f

echo "[deploy] status:"
docker compose ps
echo "[deploy] done"
