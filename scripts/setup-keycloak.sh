#!/usr/bin/env bash
# Configures the repository portal's user-management access in Keycloak.
# Safe to re-run. Needed on stacks whose realm was imported before this
# client existed (the realm JSON is only imported on first start).
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; source .env; set +a

realm=bonolo-repository
client=repository-portal-admin
kc() { docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@"; }

echo "Signing in to Keycloak as the bootstrap admin ..."
kc config credentials --server http://localhost:8080 --realm master \
  --user admin --password "$KEYCLOAK_ADMIN_PASSWORD" >/dev/null 2>&1

id=$(kc get clients -r "$realm" -q clientId="$client" --fields id --format csv --noquotes | tr -d '\r')
settings=(-s enabled=true -s publicClient=false -s serviceAccountsEnabled=true
  -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -s implicitFlowEnabled=false
  -s "name=Prescription Repository Portal - user management"
  -s "secret=$PORTAL_ADMIN_CLIENT_SECRET")
if [[ -z "$id" ]]; then
  kc create clients -r "$realm" -s clientId="$client" "${settings[@]}" >/dev/null 2>&1
  echo "  created client $client"
else
  kc update "clients/$id" -r "$realm" "${settings[@]}"
  echo "  updated client $client"
fi

# Only what managing portal users needs; no realm or client configuration.
kc add-roles -r "$realm" --uusername "service-account-$client" --cclientid realm-management \
  --rolename view-users --rolename query-users --rolename manage-users
echo "  service account roles: view-users, query-users, manage-users"

# Keycloak's own record of administrative changes (the portal also logs who
# acted), and the login theme with the Ministry of Health logo.
kc update "realms/$realm" -s adminEventsEnabled=true -s adminEventsDetailsEnabled=true -s loginTheme=bonolo
echo "  admin events enabled, login theme: bonolo"
echo "Done."
