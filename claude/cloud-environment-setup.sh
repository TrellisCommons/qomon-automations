#!/usr/bin/env bash
# Setup Script for this repo's Claude Code cloud environment, versioned here
# so changes to it are reviewed. Paste it into the environment's Setup Script
# field; it runs as root before the session starts.
#
# It never fails the session: each step that fails is appended to
# ~/.cloud-setup-errors.log, which a session checks before doing anything else.
#
# Docker does not work in cloud sessions, so tests use the image's
# preinstalled Postgres 16 cluster. CI and the droplet run Postgres 17.
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

# Matches DATABASE_URL in the environment settings:
#   postgresql://qomon:qomon@localhost:5432/qomon_automations
setup_postgres() {
  pg_ctlcluster 16 main start 2>&1 | grep -v 'already running' || true
  su postgres -c "psql -v ON_ERROR_STOP=1 -q" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'qomon') THEN
    CREATE ROLE qomon LOGIN PASSWORD 'qomon' CREATEDB;
  END IF;
END
$$;
SQL
  if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname = 'qomon_automations'\"" | grep -q 1; then
    su postgres -c "createdb -O qomon qomon_automations"
  fi
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
step 'Postgres role and database' setup_postgres
step 'gpo-monolith reference download' download_reference

[ -s "$ERRORS" ] || rm -f "$ERRORS"
exit 0
