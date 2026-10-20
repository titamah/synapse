#!/usr/bin/env bash
# Downloads and decrypts a backup from Cloudflare R2 into ~/restore/ (the newest, or the one named).
#   scripts/fetch-offsite-backup.sh                         # newest
#   scripts/fetch-offsite-backup.sh synapse-2026-10-20_0300.sql.gz.gpg
# On a new server: run setup-offsite-backup.sh first, and paste the saved passphrase into
# ~/.config/synapse-backup/passphrase (chmod 600) before running this.
# Restoring into the database is deliberately manual; see the last lines it prints.
set -euo pipefail
CONF_DIR="$HOME/.config/synapse-backup"
. "$CONF_DIR/env"
name="${1:-$(rclone lsf "r2:$BUCKET" --include 'synapse-*.sql.gz.gpg' | sort | tail -1)}"
[ -n "$name" ] || { echo "No backups found in r2:$BUCKET"; exit 1; }
mkdir -p "$HOME/restore"
out="$HOME/restore/${name%.gpg}"
rclone copyto "r2:$BUCKET/$name" "$out.gpg"
gpg --batch --yes --quiet --decrypt --passphrase-file "$CONF_DIR/passphrase" -o "$out" "$out.gpg"
rm -f "$out.gpg"
gzip -t "$out"
echo "✅ $out ($(du -h "$out" | cut -f1))"
echo "To restore (replaces the current database; take a backup first):"
echo "  cd ~/synapse && docker compose stop bot"
echo "  gunzip -c $out | docker compose exec -T db sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"'"
echo "  docker compose start bot"
