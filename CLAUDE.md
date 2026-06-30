# squidpy-viewer — project rules

## Keep the README current (always)

`README.md` is the source of truth for what this app does and how to run it.
**Every change keeps it accurate in the same commit.** If a change adds, removes,
or alters a feature, an API endpoint, a run/build command, an environment
variable, the directory layout, or a user-facing panel/flow, update `README.md`
as part of that change — not later. A PR/commit that changes behavior but leaves
the README stale is incomplete. When in doubt, skim the README before committing
and fix anything it now misstates.

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
