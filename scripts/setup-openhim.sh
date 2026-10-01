#!/usr/bin/env bash
# Registers the eRegister, CDU and registry clients and the FHIR channels in
# OpenHIM. Safe to re-run: the metadata import upserts by name / clientID.
set -euo pipefail

cd "$(dirname "$0")/.."
./scripts/wait-for-hapi.sh
set -a; source .env; set +a

api() { curl -sk -u "$OPENHIM_ROOT_USER:$OPENHIM_ROOT_PASSWORD" "$@"; }

echo "Waiting for the OpenHIM API at $OPENHIM_API ..."
for _ in $(seq 1 60); do
  api -o /dev/null -w '%{http_code}' "$OPENHIM_API/heartbeat" | grep -q 200 && break
  sleep 3
done

# OpenHIM basic auth checks sha512(password + salt)
client() { # clientID name role password
  local salt hash
  salt=$(openssl rand -hex 16)
  hash=$(printf '%s%s' "$4" "$salt" | sha512sum | cut -d' ' -f1)
  jq -n --arg id "$1" --arg name "$2" --arg role "$3" --arg salt "$salt" --arg hash "$hash" \
    '{clientID:$id, name:$name, roles:[$role], passwordAlgorithm:"sha512", passwordSalt:$salt, passwordHash:$hash}'
}

clients=$(jq -s . \
  <(client eregister      "eRegister (Bahmni) - facility publisher"   eregister "$EREGISTER_PASSWORD") \
  <(client cdu            "Bonolo Health CDU (Odoo 16)"               cdu       "$CDU_PASSWORD") \
  <(client registry-admin "Registry services - reference data admin"  registry  "$REGISTRY_PASSWORD") \
  <(client portal         "Prescription Repository Portal (read-only)" portal    "$PORTAL_PASSWORD"))

jq -n --argjson clients "$clients" --slurpfile channels openhim/channels.json \
  '{Clients: $clients, Channels: $channels[0]}' > /tmp/openhim-metadata.$$.json

echo "Importing clients and channels ..."
api -X POST -H 'Content-Type: application/json' \
  --data @/tmp/openhim-metadata.$$.json "$OPENHIM_API/metadata" \
  | jq -r '.[] | "  \(.model)\t\(.record.name // .record.clientID)\t\(.status)\t\(.message // "")"'
rm -f /tmp/openhim-metadata.$$.json

# Read-only API user for the repository portal's integration-health pages.
echo "Configuring the portal's read-only OpenHIM user ..."
role=$(jq -n '{name: "portal-monitor", permissions: {
  "channel-view-all": true, "client-view-all": true, "mediator-view-all": true,
  "transaction-view-all": true, "transaction-view-body-all": true}}')
if [[ $(api -o /dev/null -w '%{http_code}' "$OPENHIM_API/roles/portal-monitor") == 200 ]]; then
  api -X PUT -H 'Content-Type: application/json' --data "$role" "$OPENHIM_API/roles/portal-monitor" >/dev/null
else
  api -X POST -H 'Content-Type: application/json' --data "$role" "$OPENHIM_API/roles" >/dev/null
fi
if [[ $(api -o /dev/null -w '%{http_code}' "$OPENHIM_API/users/$OPENHIM_PORTAL_USER") != 200 ]]; then
  api -X POST -H 'Content-Type: application/json' "$OPENHIM_API/users" \
    --data "$(jq -n --arg email "$OPENHIM_PORTAL_USER" \
      '{email: $email, firstname: "Repository", surname: "Portal", groups: ["portal-monitor"]}')" >/dev/null
fi
# Always set the password through an update: OpenHIM 8.5 stores a password
# given on POST /users without hashing it, so that one can never log in.
api -X PUT -H 'Content-Type: application/json' "$OPENHIM_API/users/$OPENHIM_PORTAL_USER" \
  --data "$(jq -n --arg email "$OPENHIM_PORTAL_USER" --arg password "$OPENHIM_PORTAL_USER_PASSWORD" \
    '{email: $email, groups: ["portal-monitor"], password: $password}')" >/dev/null
status=$(curl -sk -o /dev/null -w '%{http_code}' -u "$OPENHIM_PORTAL_USER:$OPENHIM_PORTAL_USER_PASSWORD" "$OPENHIM_API/transactions?filterLimit=1")
printf '  portal-monitor\t%s\tAPI read check: HTTP %s\n' "$OPENHIM_PORTAL_USER" "$status"

echo "Done. Router: http://localhost:5001/fhir  Console: http://localhost:9000"
