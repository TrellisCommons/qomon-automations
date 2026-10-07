#!/usr/bin/env bash
# Check that docs were updated alongside the code areas they cover.
#
# Rules live in docs/doc-map.tsv: a rule arms when a changed file matches any
# of its code globs, and is satisfied when a changed file matches the doc path
# or glob. Prints one line per unsatisfied rule; exit 1 when any rule is
# unsatisfied. See docs/README.md for the system this belongs to.
#
# Usage: scripts/check-doc-sync.sh [<base>]
# Compares <base>...HEAD (merge-base diff); <base> defaults to origin/main.
# Run by the Doc Sync workflow on every PR; runnable locally before pushing.
set -uo pipefail
cd "$(dirname "$0")/.."

base="${1:-origin/main}"
map=docs/doc-map.tsv
[ -f "$map" ] || exit 0

CHANGED=()
while IFS= read -r f; do [ -n "$f" ] && CHANGED+=("$f"); done \
  < <(git diff --name-only "$base"...HEAD)
[ "${#CHANGED[@]}" -eq 0 ] && exit 0

# matches <glob>: true if any changed file matches the glob (case-pattern).
matches() {
  local p="$1" f
  for f in "${CHANGED[@]}"; do
    case "$f" in $p) return 0 ;; esac
  done
  return 1
}

status=0
while IFS=$'\t' read -r globs doc hint; do
  case "$globs" in ''|'#'*) continue ;; esac
  for g in $globs; do
    if matches "$g" && ! matches "$doc"; then
      printf '%s changed but %s did not: update %s.\n' "$globs" "$doc" "$hint"
      status=1
      break
    fi
  done
done < "$map"

exit "$status"
