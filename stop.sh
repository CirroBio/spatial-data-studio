#!/usr/bin/env bash
# Stops the local dev servers started by run.sh.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PIDFILE="$PWD/.run.pids"
if [[ ! -f "$PIDFILE" ]]; then
  echo "no $PIDFILE found — nothing to stop (is run.sh running?)" >&2
  exit 1
fi

read -r BACKEND_PID FRONTEND_PID < "$PIDFILE"
for pid in "$BACKEND_PID" "$FRONTEND_PID"; do
  kill -- "-$pid" 2>/dev/null || true
done
rm -f "$PIDFILE"
echo "stopped backend (pid $BACKEND_PID) and frontend (pid $FRONTEND_PID)"
