#!/usr/bin/env bash
# SessionStart hook: tests need Postgres, and Docker does not work in cloud
# sessions, so they use the image's Postgres 16 cluster (CI and the droplet
# run 17). The cluster is stopped when a session starts, and the role and
# database exist only once a session has made them, so this works in any
# environment. Local machines and CI bring their own database.
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

TEST_DATABASE_URL=postgresql://qomon:qomon@localhost:5432/qomon_automations

fail() {
  echo "start-postgres: $1" >&2
  exit 1
}

if ! out=$(pg_ctlcluster 16 main start 2>&1); then
  case "$out" in
    *"already running"*) ;;
    *) fail "$out" ;;
  esac
fi

create_role() {
  su postgres -c "psql -v ON_ERROR_STOP=1 -q" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'qomon') THEN
    CREATE ROLE qomon LOGIN PASSWORD 'qomon' CREATEDB;
  END IF;
END
$$;
SQL
}
out=$(create_role 2>&1) || fail "creating the role failed: $out"
if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname = 'qomon_automations'\"" | grep -q 1; then
  out=$(su postgres -c "createdb --owner=qomon qomon_automations" 2>&1) || fail "creating the database failed: $out"
fi

# DATABASE_URL is set by the qomon-automations environment; its absence means
# the session started in another one, without that environment's Qomon
# variables or network allowlist.
if [ -z "${DATABASE_URL:-}" ]; then
  [ -n "${CLAUDE_ENV_FILE:-}" ] && echo "export DATABASE_URL=$TEST_DATABASE_URL" >> "$CLAUDE_ENV_FILE"
  echo "start-postgres: this session is not in the qomon-automations cloud environment, so its Qomon variables and network allowlist are missing. DATABASE_URL is set for the test database."
fi
