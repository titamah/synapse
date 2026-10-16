#!/usr/bin/env bash
# Nightly Postgres backup. Run from cron on the server:
#   0 3 * * * /home/ubuntu/synapse/scripts/backup.sh >> /home/ubuntu/backups/backup.log 2>&1
# Keeps the last KEEP_DAYS days of compressed dumps in ~/backups.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"

file="$BACKUP_DIR/synapse-$(date +%Y-%m-%d_%H%M).sql.gz"
# Runs pg_dump inside the db container, using the container's own credentials.
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' | gzip > "$file"

# A dump of an empty database is still a few hundred bytes; anything smaller means it failed.
if [ "$(stat -c %s "$file")" -lt 200 ]; then
  echo "$(date) backup FAILED: $file is too small" >&2
  exit 1
fi

find "$BACKUP_DIR" -name 'synapse-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date) backup ok: $file ($(du -h "$file" | cut -f1))"
