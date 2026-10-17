#!/usr/bin/env bash
# Weekly Docker cleanup on the server. Run from cron:
#   0 4 * * 0 /home/ubuntu/synapse/scripts/cleanup.sh >> /home/ubuntu/backups/cleanup.log 2>&1
# Removes leftover build files and images no container uses. Running containers,
# their images and the database volume are never touched.
set -euo pipefail

docker builder prune --force --filter "until=168h" >/dev/null
docker image prune --force >/dev/null
echo "$(date) cleanup ok: $(df -h / | awk 'NR==2 {print $4}') free"
