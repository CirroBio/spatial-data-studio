---
name: launch-app
description: Launch or relaunch the Spatial Data Studio local dev environment — the backend (uvicorn on :8000) and the frontend (vite dev server) started together by `./run.sh`. Use whenever the user wants to start, boot, restart, relaunch, or "bring up" the app for local development, or after a backend edit that requires a manual restart (uvicorn runs without `--reload` by design; see below).
---

# Launch / relaunch the app dev environment

The repo ships two shell scripts at its root that fully manage local dev:

- `./run.sh` — starts backend (`uvicorn` on port 8000, no `--reload`) and frontend (`npm run dev`, Vite proxies `/api` and `/snapshots` to :8000). Blocks until both exit. Writes `.run.pids` while running.
- `./run.sh --test` — same, but points `SQV_DATA_DIR` at `test-data/` instead of `data/`.
- `./stop.sh` — reads `.run.pids` and kills each process group.

Never invoke `uvicorn` or `npm run dev` directly, and never pass `--reload` — the long-lived `/api/events` SSE stream never closes, so `--reload` hangs on "Waiting for connections to close" on every backend edit. Backend changes require a manual relaunch.

## Steps

1. **Check current state.** From the repo root:

   ```bash
   [ -f .run.pids ] && cat .run.pids || echo "not running"
   curl -sf -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/api/readyz || echo "no backend"
   ```

   If `.run.pids` exists and `readyz` is 200, it's already up — tell the user and stop unless they asked to *relaunch*.

2. **Stop first if relaunching (or if `.run.pids` is stale).** Run `./stop.sh` from the repo root. If `stop.sh` errors because `.run.pids` is missing but a stray `uvicorn app.main:app` or `vite` process is still bound to a port, kill them explicitly (`pkill -f 'uvicorn app.main:app'`, `pkill -f 'vite'`) before continuing — a leftover backend on :8000 will make the new run's frontend proxy to the wrong process.

3. **Launch in the background.** `run.sh` blocks in the foreground, so run it with `run_in_background: true` and redirect output to a log file the user can tail:

   ```bash
   ./run.sh > .run.log 2>&1   # add `--test` to serve from test-data/
   ```

   Use `--test` when the user is working against the bundled test datasets (`visium_hne.zarr`, `xenium.zarr`, `xenium_tma.zarr`) — those live under `test-data/`, not `data/`.

4. **Wait for readiness before reporting success.** The backend takes a few seconds to import `squidpy` and build the function registry; the frontend takes a moment to bind its Vite port. Poll:

   ```bash
   for i in $(seq 1 60); do
     code=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/api/readyz || echo 000)
     [ "$code" = "200" ] && break
     sleep 1
   done
   ```

   Then check the Vite log for the port it chose (5173 is the default; it picks the next free one if taken):

   ```bash
   grep -Eo 'http://localhost:[0-9]+' .run.log | head -1
   ```

5. **Report** the frontend URL, the backend URL (`http://127.0.0.1:8000`), and where the log is (`.run.log`). If the app was already up and no restart was asked for, say so instead of relaunching.

## Prerequisites (only check if launch fails)

`run.sh` self-checks these and prints a fix — don't re-verify them proactively. If launch does fail, the likely causes are:

- `.venv-introspect/` missing. Create it per the README:
  `python3.11 -m venv .venv-introspect && . .venv-introspect/bin/activate && pip install -r backend/requirements.txt && pip uninstall -y leidenalg igraph`
- `frontend/node_modules/` missing. `run.sh` auto-runs `npm install` if it's absent — a fresh install just makes the first launch slow, not broken.
- Port 8000 already bound. `lsof -i :8000` — kill the squatter or ask the user which process it is.

## When to relaunch

- After any backend edit (`backend/**/*.py`, `backend/app/registry/*.yaml`, `backend/app/recipes/*.json`). The frontend hot-reloads on its own; the backend does not.
- After changing `.env` (Cirro credentials, `SQV_*` env vars) — `run.sh` sources it once at start.
- After rebuilding the standalone snapshot viewer (`cd frontend && npm run build:viewer`) if you need the fresh bundle to be served — the backend picks up `frontend/dist-viewer/` at request time, so a soft-refresh in the browser is often enough; a full relaunch is only needed if the backend can't find the directory at all.

Frontend-only edits (anything under `frontend/src/`) are picked up live by Vite — no relaunch.
