#!/usr/bin/env bash
# Launches the backend (uvicorn) and frontend (vite) for local development.
# See "Run locally for development" in README.md. Stop with ./stop.sh or Ctrl-C.
set -euo pipefail
set -m  # each background job gets its own process group, so stop.sh can kill it (and any children) by group
cd "$(dirname "${BASH_SOURCE[0]}")"

DATA_SUBDIR="data"
for arg in "$@"; do
  if [[ "$arg" == "--test" ]]; then
    DATA_SUBDIR="test-data"
  fi
done

PIDFILE="$PWD/.run.pids"

VENV_BIN="$PWD/.venv-introspect/bin"
if [[ ! -x "$VENV_BIN/python" ]]; then
  echo "error: .venv-introspect not found. Create it per README.md:" >&2
  echo "  uv venv --python 3.11 .venv-introspect && . .venv-introspect/bin/activate && uv pip install -r backend/requirements.txt && uv pip uninstall leidenalg igraph" >&2
  exit 1
fi

if [[ ! -d frontend/node_modules ]]; then
  (cd frontend && npm install)
fi

# Docker compose auto-loads .env; local dev needs it sourced explicitly so
# CIRRO_* config reaches the uvicorn process below.
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

# Single data directory: inputs to import/load AND saved checkpoints/snapshots all
# live here (read-write). Defaults to data/ (or test-data/ with --test).
export SDS_DATA_DIR="${SDS_DATA_DIR:-$PWD/$DATA_SUBDIR}"
export SDS_CONTAINER_MEM_MB="${SDS_CONTAINER_MEM_MB:-16384}"
mkdir -p "$SDS_DATA_DIR"

# Transient working set (unpacked archives + per-session raster caches, each up to a
# few hundred MB) lives under WORK_DIR. The backend defaults it to the system temp dir,
# where killed/exited sessions used to leave the dirs behind and pile up into many GB.
# So own a dedicated WORK_DIR for this run and delete it on exit (see the cleanup trap).
# If SDS_WORK_DIR is preset (e.g. a sized tmpfs mount), respect it and don't touch it.
if [[ -z "${SDS_WORK_DIR:-}" ]]; then
  SDS_WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sds-work.XXXXXX")"
  OWN_WORK_DIR=1
fi
export SDS_WORK_DIR

# --reload is unusable here: the long-lived SSE stream (/api/events) never
# closes, so the reloader hangs on "Waiting for connections to close" on any
# backend edit. Restart this script manually after backend changes.
(cd backend && PYTHONPATH=. "$VENV_BIN/uvicorn" app.main:app --port 8000) &
BACKEND_PID=$!

(cd frontend && npm run dev) &
FRONTEND_PID=$!

echo "$BACKEND_PID $FRONTEND_PID" > "$PIDFILE"
# On exit (normal, Ctrl-C, or stop.sh's TERM to the process group): stop both servers
# and, if we own the WORK_DIR, delete it so a session's multi-GB temp dirs never leak.
cleanup() {
  rm -f "$PIDFILE"
  kill -- "-$BACKEND_PID" "-$FRONTEND_PID" 2>/dev/null || true
  if [[ -n "${OWN_WORK_DIR:-}" ]]; then rm -rf "$SDS_WORK_DIR"; fi
}
trap cleanup EXIT INT TERM
wait "$BACKEND_PID" "$FRONTEND_PID"
