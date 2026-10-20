#!/usr/bin/env bash
# One-time setup for off-site backups to Cloudflare R2. Run it yourself on the server:
#   ~/synapse/scripts/setup-offsite-backup.sh
# Needs rclone 1.6x+ (the server has the official release; Ubuntu's 1.60 package is too old for R2).
# It asks for the R2 API token's keys (typed, not shown), makes an encryption passphrase,
# and saves both where only this user can read them. Safe to re-run to replace the keys.
set -euo pipefail

BUCKET="${BUCKET:-synapse-backups}"
CONF_DIR="$HOME/.config/synapse-backup"
RCLONE_CONF="$HOME/.config/rclone/rclone.conf"
umask 077
mkdir -p "$CONF_DIR" "$(dirname "$RCLONE_CONF")"

echo "Cloudflare R2 → Manage API tokens → your token's details."
read -rp  "Endpoint (https://<account-id>.r2.cloudflarestorage.com): " endpoint
read -rp  "Access Key ID: " key_id
read -rsp "Secret Access Key (hidden): " secret; echo
endpoint="${endpoint%/}"

# rclone remote "r2" (only this user can read the file).
touch "$RCLONE_CONF"; chmod 600 "$RCLONE_CONF"
tmp="$(mktemp)"
awk 'BEGIN{skip=0} /^\[r2\]$/{skip=1; next} /^\[/{skip=0} !skip' "$RCLONE_CONF" > "$tmp"
cat >> "$tmp" <<CONF
[r2]
type = s3
provider = Cloudflare
access_key_id = $key_id
secret_access_key = $secret
endpoint = $endpoint
acl = private
no_check_bucket = true
CONF
mv "$tmp" "$RCLONE_CONF"; chmod 600 "$RCLONE_CONF"
echo "BUCKET=$BUCKET" > "$CONF_DIR/env"

# Encryption passphrase: made once, reused on re-runs. Without it, the R2 backups can't be opened.
if [ ! -s "$CONF_DIR/passphrase" ]; then
  openssl rand -base64 33 > "$CONF_DIR/passphrase"
  echo
  echo "Backup encryption passphrase (save it in your password manager NOW; it's needed to restore"
  echo "from R2 if this server is ever lost):"
  echo
  echo "    $(cat "$CONF_DIR/passphrase")"
  echo
fi
chmod 600 "$CONF_DIR/passphrase" "$CONF_DIR/env"

echo "Checking R2…"
# A normal file upload, like the nightly backup (R2 doesn't support rclone's streamed "rcat").
probe="$(mktemp)"; echo ok > "$probe"
rclone copyto "$probe" "r2:$BUCKET/setup-check.txt" && rclone deletefile "r2:$BUCKET/setup-check.txt" && rm -f "$probe" \
  && echo "✅ R2 works. Nightly backups will now be encrypted and copied to r2:$BUCKET." \
  || { echo "❌ Couldn't write to r2:$BUCKET. Check the endpoint, keys and the token's bucket access, then re-run."; exit 1; }
