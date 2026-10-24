#!/usr/bin/env bash
# Replaces the Instagram access token and restarts the bot. Run it yourself on the server:
#   ssh -t synapse '~/synapse/scripts/set-ig-token.sh'
# The token is typed (hidden), never shown or logged. The bot notices the new token and starts from it.
set -euo pipefail
cd "$(dirname "$0")/.."
read -rsp "New Instagram access token (hidden): " token; echo
token="$(printf '%s' "$token" | tr -d '[:space:]')"
[ ${#token} -ge 50 ] || { echo "❌ That doesn't look like a token (too short). Nothing changed."; exit 1; }
umask 077
tmp="$(mktemp)"
grep -v '^IG_ACCESS_TOKEN=' .env > "$tmp" || true
printf 'IG_ACCESS_TOKEN=%s\n' "$token" >> "$tmp"
cat "$tmp" > .env && rm -f "$tmp"
docker compose up -d --force-recreate bot >/dev/null 2>&1
echo "✅ Token saved and the bot restarted. Tell Claude so it can check Instagram."
