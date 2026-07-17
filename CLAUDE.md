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
Example: the obs column picker (`ObsFieldSelect`) is shared by Color By and Draw
Label, with the `creatable` prop covering their difference.

## Every function declares its provenance (always)

Every function the app exposes must define two attributes — `citation` (a text
reference) and `documentation` (a URL) — surfaced in the picker and enforced by
`backend/test_e2e.py` (the registry round-trip asserts both are non-empty for
every entry). Populate them by *source*, never by hardcoding per introspected
function:

- **External (library) functions** — squidpy, scanpy, spatialdata-io, and any
  future reflected library. Do **not** set these per function. Add/keep the
  library's entry in `backend/app/registry/library_meta.yaml`: `citation` is the
  library's own reference (appropriate for the library as a whole); `doc_url` is a
  template whose `{path}` is filled with each function's dotted path, so the link
  lands on *that function's* page in the library's docs. Every reflected function
  from the library then inherits both automatically. Adding a new library to
  `library_catalog.yaml`/`introspect.py` means adding one `library_meta.yaml`
  entry — nothing per function.
- **Custom functions** (`registry/custom/`) — set both on the class: `citation`
  points to where the method came from (a paper, online post, or tutorial; for
  an original method, say so), and `documentation = custom_doc("<anchor>")`
  (from `custom/_docs.py`) points to that method's section in
  `backend/app/registry/custom/README.md`. That README section must be written to
  explain what the method does in terms a user understands; keep its heading's
  GitHub anchor in sync with the `custom_doc(...)` anchor.

## Orientation

- Backend: FastAPI (`backend/app`). Operations are discovered by reflecting the
  supported libraries (squidpy wholesale; scanpy/spatialdata-io via
  `library_catalog.yaml`); never hardcode a library function name. Parameter knowledge lives in
  the Parameter Term Dictionary (`backend/app/registry/terms.yaml` + `dictionary.py`),
  keyed by parameter term, not by function.
- Frontend: React + TS + Vite + Tailwind + Radix + deck.gl (`frontend/src`).
- App state persists in `sdata.attrs["app_state"]`; compute mutates the object in
  place under a per-session write lock (audit-log model, no undo).
- Verify changes empirically: `backend/test_e2e.py` for the backend round trip;
  `npx tsc --noEmit -p tsconfig.app.json && npm run build` for the frontend; and
  drive the live UI in a browser for UI changes.
