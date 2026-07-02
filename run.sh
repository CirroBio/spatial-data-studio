#!/usr/bin/env bash
# Launches the backend (uvicorn) and frontend (vite) for local development.
# See "Run locally for development" in README.md. Stop with ./stop.sh or Ctrl-C.
set -euo pipefail
set -m  # each background job gets its own process group, so stop.sh can kill it (and any children) by group
cd "$(dirname "${BASH_SOURCE[0]}")"

PIDFILE="$PWD/.run.pids"

VENV_BIN="$PWD/.venv-introspect/bin"
if [[ ! -x "$VENV_BIN/python" ]]; then
  echo "error: .venv-introspect not found. Create it per README.md:" >&2
  echo "  python3.11 -m venv .venv-introspect && . .venv-introspect/bin/activate && pip install -r backend/requirements.txt" >&2
  exit 1
fi

if [[ ! -d frontend/node_modules ]]; then
  (cd frontend && npm install)
fi

export SQV_DATA_DIR="${SQV_DATA_DIR:-$PWD/test-data}"
export SQV_CHECKPOINT_DIR="${SQV_CHECKPOINT_DIR:-$PWD/checkpoints}"
export SQV_CONTAINER_MEM_MB="${SQV_CONTAINER_MEM_MB:-16384}"
mkdir -p "$SQV_CHECKPOINT_DIR"

# --reload is unusable here: the long-lived SSE stream (/api/events) never
# closes, so the reloader hangs on "Waiting for connections to close" on any
# backend edit. Restart this script manually after backend changes.
(cd backend && PYTHONPATH=. "$VENV_BIN/uvicorn" app.main:app --port 8000) &
BACKEND_PID=$!

(cd frontend && npm run dev) &
FRONTEND_PID=$!

echo "$BACKEND_PID $FRONTEND_PID" > "$PIDFILE"
trap 'rm -f "$PIDFILE"; kill -- "-$BACKEND_PID" "-$FRONTEND_PID" 2>/dev/null' EXIT INT TERM
wait "$BACKEND_PID" "$FRONTEND_PID"
