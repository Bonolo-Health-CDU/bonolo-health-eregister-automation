#!/usr/bin/env bash
# Backs up the repository's data: the FHIR (HAPI) and Keycloak databases and
# OpenHIM's MongoDB (clients, channels, users, transaction log). Each run
# writes a dated folder; folders older than BACKUP_KEEP_DAYS (14) are removed.
# Restoring is described in DEPLOYMENT.md.
#
#   ./scripts/backup.sh [backup-root]      (default /var/backups/cdu-fhir-repo)
set -euo pipefail

cd "$(dirname "$0")/.."

root=${1:-/var/backups/cdu-fhir-repo}
keep_days=${BACKUP_KEEP_DAYS:-14}
dest="$root/$(date +%Y-%m-%d_%H%M%S)"

umask 077
mkdir -p "$dest.partial"
docker compose exec -T hapi-db pg_dump -U hapi -Fc hapi > "$dest.partial/hapi.dump"
docker compose exec -T keycloak-db pg_dump -U keycloak -Fc keycloak > "$dest.partial/keycloak.dump"
docker compose exec -T mongo mongodump --quiet --archive --gzip --db openhim > "$dest.partial/openhim.archive.gz"
# Only a complete backup gets its final name.
mv "$dest.partial" "$dest"

find "$root" -mindepth 1 -maxdepth 1 -type d -mtime +"$keep_days" -exec rm -rf {} +
echo "Backed up to $dest ($(du -sh "$dest" | cut -f1))"
