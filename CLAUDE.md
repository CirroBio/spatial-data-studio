# Spatial Data Studio — project rules

## Keep the docs current (always)

Documentation is split by audience, and **every change keeps the relevant file
accurate in the same commit** — a PR/commit that changes behavior but leaves a doc
stale is incomplete.

- `README.md` is the source of truth for the **user-facing** app: what it does and
  how a user runs it (the Docker quickstart). A change that adds, removes, or alters
  a user-facing capability, a user-facing panel/flow, or the run command updates
  `README.md`. If a UI change materially alters a panel shown in a README screenshot
  (`docs/images/*`), refresh that screenshot too.
- `DEVELOPMENT.md` is the source of truth for the **developer-facing** detail:
  architecture, repo layout / where-to-change-what, the local dev environment, and the
  test suite / offline CLI. A change to any of those updates `DEVELOPMENT.md` (and
  `DESIGN.md` / `docs/CONTRACT.md` where the design or API contract also moves) in
  the same commit.

When in doubt, skim both before committing and fix anything they now misstate. Do
not fold developer detail back into `README.md`, and do not leave user-facing feature
changes out of it.

The documentation site (`docs-site/`) publishes the files above **unmodified** — it
points VitePress at the repo root, so the markdown in the repo *is* the site. Never
copy or paraphrase `README.md`, `DEVELOPMENT.md`, `DESIGN.md` or any component README
into `docs-site/`; pages there may only add site-specific material (navigation, the
live-viewer demos). Adding, renaming or moving a published `.md` updates the sidebar in
`docs-site/.vitepress/config.mts` in the same commit — the build's dead-link check fails
otherwise. `<ViewerEmbed>` may appear only in pages under `docs-site/`, never in
published repo markdown, which has to stay readable on GitHub.

## Keep run.sh / stop.sh current (always)

`run.sh` is the local dev launcher (backend `uvicorn` + frontend `npm run dev`);
`stop.sh` stops what it started (reads `.run.pids`, kills each process group).
If a change alters how the app is launched, configured, or stopped — the venv
path/name, required env vars, the backend start command or port, the
data/checkpoint directories, how the frontend is started, or how the two
processes are tracked/killed — update `run.sh` and/or `stop.sh` (and the "Local
dev environment" section of `DEVELOPMENT.md`) in the same commit. A change
that leaves `run.sh` unable to boot the app, or `stop.sh` unable to stop it, is
incomplete.

## Nextflow code must pass the official linter (always)

Every `.nf` script and `nextflow.config` in the repo must lint clean with Nextflow's
own linter. Run it over the whole `nextflow/` tree before committing a change that
touches any of it:

```bash
nextflow lint nextflow/
```

A change that leaves an error is incomplete — fix the code, not the report. The linter
is also the formatter (`nextflow lint -format`), so it is the arbiter of layout too;
don't hand-argue with its indentation.

## Tag a release when the SPA changes (always)

The Nextflow workflow does not build the viewer. `nextflow.config`'s `viewer_dist`
defaults to the `viewer-dist.tar.gz` attached to the **latest GitHub release**, which
`.github/workflows/release.yml` builds and uploads on every `v*` tag push. That archive
is the only SPA a run launched from a fresh clone can obtain — `frontend/dist` is
gitignored — so **an SPA change that is merged but not tagged does not reach a workflow
run.** Cirro runs the workflow straight from the repository, so "merged to main" is not
the thing that ships it; the tag is.

A change that alters what the built SPA does needs a new `v*` tag to take effect:

- anything under `frontend/` or `packages/viewer/` that changes rendered behavior, and
- anything that changes what the SPA reads out of a checkpoint — the `viewer/` sidecar
  layout, `VIEWER_SIDECAR_VERSION`, the GeoParquet/CSC mirror shape, or the checkpoint
  schemas in `backend/app/schemas/checkpoint/`, since a viewer that predates the change
  will refuse or misread a store written after it.

Backend-only, docs-only, and `nextflow/`-only changes do not.

Tag from `main` once the change has landed there, and let the workflow attach the asset:

```bash
git tag v1.2.3 && git push origin v1.2.3
```

Two obligations that come with the tag. Bump the `version` in the root `package.json`,
`frontend/package.json` and `packages/viewer/package.json` to match it in the same
commit as the change — a tag whose name disagrees with the manifests makes the shipped
bundle unidentifiable. And when a checkpoint-format change is what forced the tag, say
so in the release notes: pinning `--viewer_dist` to an older asset is the documented
escape hatch (`nextflow/README.md`), and it only works if the incompatibility is
findable.

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
