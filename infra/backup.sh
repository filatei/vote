#!/usr/bin/env bash
# ============================================================================
# Nightly PostgreSQL backup for Torama Vote.
#
# Dumps the database from the vote_postgres container, gzips it into
# /opt/vote/backups, verifies it's non-empty, and prunes backups older than
# RETAIN_DAYS. Run it from cron (see --install-cron below).
#
#   sudo bash /opt/vote/infra/backup.sh                 # run a backup now
#   sudo bash /opt/vote/infra/backup.sh --install-cron  # schedule nightly @ 02:00
#
# Restore a dump:
#   gunzip -c /opt/vote/backups/votedb-YYYYMMDD-HHMMSS.sql.gz \
#     | docker compose -f /opt/vote/docker-compose.yml exec -T vote_postgres \
#       psql -U voteuser -d votedb
# ============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vote}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

if [[ "${1:-}" == "--install-cron" ]]; then
  [[ $EUID -eq 0 ]] || { echo "Run with sudo to install the cron job." >&2; exit 1; }
  cron_file=/etc/cron.d/vote-backup
  cat > "$cron_file" <<EOF
# Torama Vote nightly DB backup (02:00 server time)
0 2 * * * root $APP_DIR/infra/backup.sh >> /var/log/vote-backup.log 2>&1
EOF
  chmod 644 "$cron_file"
  echo "Installed $cron_file — nightly backup at 02:00. Logs: /var/log/vote-backup.log"
  exit 0
fi

# Read only the DB vars (don't source .env — it may contain spaces/special chars).
get() { grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true; }
DB_USER="$(get POSTGRES_USER)"; DB_USER="${DB_USER:-voteuser}"
DB_NAME="$(get POSTGRES_DB)";   DB_NAME="${DB_NAME:-votedb}"

mkdir -p "$BACKUP_DIR"
ts="$(date -u +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/votedb-$ts.sql.gz"

echo "[backup] $(date -u +%FT%TZ) dumping '$DB_NAME' -> $out"
cd "$APP_DIR"
docker compose exec -T vote_postgres pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$out"

if [[ ! -s "$out" ]]; then
  echo "[backup] ERROR: dump is empty — removing." >&2
  rm -f "$out"
  exit 1
fi

echo "[backup] pruning dumps older than ${RETAIN_DAYS} days"
find "$BACKUP_DIR" -name 'votedb-*.sql.gz' -mtime +"$RETAIN_DAYS" -delete

echo "[backup] done — $(du -h "$out" | cut -f1) ($(ls -1 "$BACKUP_DIR"/votedb-*.sql.gz | wc -l) kept)"
echo "[backup] TIP: copy backups off-box (e.g. rsync/scp) so they survive host loss."
