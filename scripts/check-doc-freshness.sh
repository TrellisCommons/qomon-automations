#!/usr/bin/env bash
# List memory docs whose scheduled review is overdue.
#
# A doc opts in to freshness tracking with YAML frontmatter:
#   ---
#   last-reviewed: YYYY-MM-DD
#   review-interval-days: N
#   ---
# Reviews are performed with the doc-review skill (.claude/skills/doc-review),
# which bumps last-reviewed. See docs/README.md for the full system.
#
# Output: one overdue doc per line (tab-separated: path, last reviewed, days
# overdue). Exit 0 when everything is fresh, 1 when anything is overdue or a
# doc's frontmatter is malformed.
set -uo pipefail
cd "$(dirname "$0")/.."

today=$(date -u +%s)
stale=0

# frontmatter <file> <key>: value of <key> inside the leading --- block, if any.
frontmatter() {
  awk -F': *' -v key="$2" '
    NR==1 && $0 != "---" { exit }
    /^---[[:space:]]*$/ { fences++; if (fences == 2) exit; next }
    fences == 1 && $1 == key { print $2; exit }
  ' "$1"
}

while IFS= read -r doc; do
  reviewed=$(frontmatter "$doc" "last-reviewed")
  interval=$(frontmatter "$doc" "review-interval-days")
  [ -n "$reviewed" ] || continue
  reviewed_epoch=$(date -u -d "$reviewed" +%s 2>/dev/null) || {
    printf '%s\tmalformed last-reviewed: %s\n' "$doc" "$reviewed"
    stale=1
    continue
  }
  case "$interval" in
    ''|*[!0-9]*)
      printf '%s\tmalformed review-interval-days: %s\n' "$doc" "${interval:-missing}"
      stale=1
      continue
      ;;
  esac
  due=$((reviewed_epoch + interval * 86400))
  if [ "$due" -lt "$today" ]; then
    printf '%s\tlast reviewed %s\t%d days overdue\n' \
      "$doc" "$reviewed" "$(((today - due) / 86400))"
    stale=1
  fi
done < <(grep -rl --include='*.md' '^last-reviewed:' CLAUDE.md docs 2>/dev/null)

exit "$stale"
