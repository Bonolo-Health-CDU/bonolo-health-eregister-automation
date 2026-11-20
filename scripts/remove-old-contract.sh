#!/usr/bin/env bash
# After HAPI has installed a new contract version, remove the previous version's
# definitions (StructureDefinition, ValueSet, CodeSystem) so that every
# canonical URL resolves to exactly one definition. HAPI keeps both versions
# when it installs a new package; until the old one is removed, it validates
# against the most recently stored copy.
#
# Only Bonolo definitions of the given version are deleted, and only when the
# configured version has a replacement for each of them. Patient, prescription
# and Task data is never touched.
#
# usage: scripts/remove-old-contract.sh <old-version>            # dry run: lists what would go
#        scripts/remove-old-contract.sh <old-version> --delete   # deletes
set -euo pipefail
cd "$(dirname "$0")/.."

HAPI=${HAPI:-http://localhost:8095/fhir}   # HAPI directly, not OpenHIM
BASE=http://fhir.health.gov.ls/bonolo-cdu/
old=${1:?usage: $0 <old-version> [--delete]}
mode=${2:-}

new=$(awk '/implementationguides:/ {f=1} f && /version:/ {print $2; exit}' hapi/application-bonolo.yaml)
if [[ -z $new || $old == "$new" ]]; then
  echo "The configured contract version is '$new'. Give the version to remove, not the one in use." >&2
  exit 1
fi

definitions() { # version -> "Type/id url" lines
  for type in StructureDefinition ValueSet CodeSystem; do
    curl -sf -H 'Cache-Control: no-cache' "$HAPI/$type?_count=200&_elements=url,version" \
      | jq -r --arg type "$type" --arg v "$1" --arg base "$BASE" \
          '.entry[]?.resource | select(.version == $v and (.url | startswith($base))) | "\($type)/\(.id) \(.url)"'
  done
}

old_defs=$(definitions "$old")
new_urls=$(definitions "$new" | cut -d' ' -f2 | sort -u)

if [[ -z $old_defs ]]; then
  echo "No version $old definitions found. Nothing to do."
  exit 0
fi
if [[ -z $new_urls ]]; then
  echo "Version $new is not installed yet. Restart hapi-fhir and wait for 'Finished installation of package'." >&2
  exit 1
fi

missing=$(comm -23 <(cut -d' ' -f2 <<<"$old_defs" | sort -u) <(echo "$new_urls"))
if [[ -n $missing ]]; then
  echo "Version $new has no replacement for these, so nothing was deleted:" >&2
  echo "$missing" | sed 's/^/  /' >&2
  exit 1
fi

echo "Version $old definitions replaced by $new:"
echo "$old_defs" | sed 's/^/  /'

if [[ $mode != --delete ]]; then
  echo "Dry run. Run again with --delete to remove them."
  exit 0
fi

while read -r ref _; do
  curl -sf -o /dev/null -X DELETE "$HAPI/$ref"
  echo "  deleted $ref"
done <<<"$old_defs"

if [[ -n $(definitions "$old") ]]; then
  echo "Some version $old definitions are still present." >&2
  exit 1
fi
echo "Done: only version $new remains."
