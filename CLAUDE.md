# Spatial Data Studio — project rules

## Keep the README current (always)

`README.md` is the source of truth for what this app does and how to run it.
**Every change keeps it accurate in the same commit.** If a change adds, removes,
or alters a feature, an API endpoint, a run/build command, an environment
variable, the directory layout, or a user-facing panel/flow, update `README.md`
as part of that change — not later. A PR/commit that changes behavior but leaves
the README stale is incomplete. When in doubt, skim the README before committing
and fix anything it now misstates.

## Keep run.sh / stop.sh current (always)

`run.sh` is the local dev launcher (backend `uvicorn` + frontend `npm run dev`);
`stop.sh` stops what it started (reads `.run.pids`, kills each process group).
If a change alters how the app is launched, configured, or stopped — the venv
path/name, required env vars, the backend start command or port, the
data/checkpoint directories, how the frontend is started, or how the two
processes are tracked/killed — update `run.sh` and/or `stop.sh` (and the "Run
locally for development" section of `README.md`) in the same commit. A change
that leaves `run.sh` unable to boot the app, or `stop.sh` unable to stop it, is
incomplete.

## Reuse code elements (always)

Before adding a new function, class, component, hook, endpoint, or other
distinct code element — backend or frontend — search for an existing element
that already does something similar and adapt it (e.g. a new parameter or
flag) instead of writing a new one. A new element is justified only when the
behavior is substantively different, not merely a variant of an existing one.
Example: the obs column picker (`ObsFieldSelect`) is shared by Color By, Draw
Label, and Promote, with `creatable`/`categoricalOnly` props covering their
differences.

## Orientation

- Backend: FastAPI (`backend/app`). Operations are discovered by introspecting
  `squidpy`; never hardcode a squidpy function name. Parameter knowledge lives in
  the Parameter Term Dictionary (`backend/app/registry/terms.yaml` + `dictionary.py`),
  keyed by parameter term, not by function.
- Frontend: React + TS + Vite + Tailwind + Radix + deck.gl (`frontend/src`).
- App state persists in `sdata.attrs["app_state"]`; compute mutates the object in
  place under a per-session write lock (audit-log model, no undo).
- Verify changes empirically: `backend/test_e2e.py` for the backend round trip;
  `npx tsc --noEmit -p tsconfig.app.json && npm run build` for the frontend; and
  drive the live UI in a browser for UI changes.
