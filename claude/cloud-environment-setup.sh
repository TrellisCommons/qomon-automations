#!/usr/bin/env bash
# Setup Script for this repo's Claude Code cloud environment, versioned here
# so changes to it are reviewed. Paste it into the environment's Setup Script
# field; it runs as root before the session starts.
#
# It never fails the session: each step that fails is appended to
# ~/.cloud-setup-errors.log, which a session checks before doing anything else.
#
# The test database is the SessionStart hook's job
# (.claude/hooks/start-postgres.sh), so a session in any environment has it.
set -uo pipefail

ERRORS=~/.cloud-setup-errors.log
: > "$ERRORS"

step() {
  local name="$1"
  shift
  if ! out=$("$@" 2>&1); then
    printf '[%s] %s failed:\n%s\n\n' "$(date -u +%FT%TZ)" "$name" "$out" >> "$ERRORS"
  fi
}

install_pnpm() {
  corepack enable && corepack prepare pnpm@9.15.9 --activate
}

# A read-only copy of gpo/gpo-monolith main, outside the repo, for porting
# patterns. Its docs/qomon/ holds vendor specs shared in confidence: never
# copy anything from it into this repo.
download_reference() {
  local dest=/home/user/reference/gpo-monolith
  rm -rf "$dest" && mkdir -p "$dest"
  curl -fsSL https://codeload.github.com/gpo/gpo-monolith/tar.gz/refs/heads/main \
    | tar -xz -C "$dest" --strip-components=1
}

step 'pnpm 9.15.9 via corepack' install_pnpm
step 'gpo-monolith reference download' download_reference

[ -s "$ERRORS" ] || rm -f "$ERRORS"
exit 0
