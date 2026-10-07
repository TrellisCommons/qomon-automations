#!/usr/bin/env bash
# SessionStart hook: the cloud image's Postgres 16 cluster is stopped when a
# session starts. Tests need it (DATABASE_URL in the environment settings).
# Local machines and CI bring their own database, so do nothing there.
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

if ! out=$(pg_ctlcluster 16 main start 2>&1); then
  case "$out" in
    *"already running"*) ;;
    *)
      echo "start-postgres: $out" >&2
      exit 1
      ;;
  esac
fi
