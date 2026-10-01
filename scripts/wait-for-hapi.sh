#!/usr/bin/env bash
# HAPI's distroless image has no curl for an in-container healthcheck.
set -euo pipefail
url=http://localhost:8095/fhir/metadata
echo "Waiting for HAPI at $url ..."
for _ in $(seq 1 120); do
  status=$(curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "$url") || status=000
  if [[ "$status" == 200 ]]; then
    echo "HAPI ready (HTTP 200)."
    exit 0
  fi
  sleep 3
done
echo "HAPI did not become ready; last HTTP status: $status" >&2
exit 1
