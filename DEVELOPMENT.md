# Developing Spatial Data Studio

The developer's entry point. [`README.md`](README.md) introduces the app for
users; this file is the source of truth for **how the code is organized, how to
run it locally, how to test it, and where to make a change**. For the deep design
rationale see [`DESIGN.md`](DESIGN.md); for the wire protocol see
[`docs/CONTRACT.md`](docs/CONTRACT.md); to add an analysis without touching the
core, see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Architecture at a glance

- **Backend** — FastAPI + uvicorn (`backend/app`). Holds one in-memory
  `SpatialData` object per session, runs compute/plot jobs on a per-session FIFO
  worker thread, and serves field data as Apache Arrow IPC and image tiles as WebP
  (Arrow and JSON responses are gzip-encoded; see "Response compression" in `docs/CONTRACT.md`).
- **Frontend** — React + TypeScript + Vite + Tailwind + Radix + deck.gl
  (`frontend/src`), a single-page app that renders cell-scale data in WebGL and
  drives all interaction.
- **One process, sessions run concurrently.** *Mutating* jobs are serial within a
  session and concurrent across sessions. The heavy squidpy/scanpy/custom call runs in a
  subprocess pool on a pickled copy, so a long compute never holds the API process's
  GIL *or* the per-session write lock: the worker takes the write lock only for the
  brief commit (applying the child's result back onto the live object), so reads keep
  serving the last-committed object throughout a running job instead of stalling on it
  (see `session._run_call`; DESIGN §24). *Extracts* (`sc.get.*` — read a value out, write
  nothing back) skip the serial queue and run concurrently in a read lane
  (`session._run_read_lane`) on a cheap shallow snapshot of the active table. Plots stay on
  the serial mutation path (they persist a `uns` color cache), so they block behind a
  running compute and render the up-to-date object.
- **Execution is an audit log, not a replay graph.** Compute mutates the object in
  place; there is no undo and no reactive recomputation. App state persists in
  `sdata.attrs["app_state"]` and round-trips through the Zarr store.

**Foundational principle — zero hardcoded library functions.** No part of the app
names a specific library function. Operations are discovered by reflection at
startup: `squidpy` is wholesale-introspected, while `scanpy` and `spatialdata-io`
functions are opted in via `library_catalog.yaml`. Forms are generated from
function signatures; calls are stored and executed as declarative descriptors.
Upgrading a reflected library exposes new functions with **no app code changes**.
The only library-specific knowledge lives in the **Parameter Term Dictionary**
(`backend/app/registry/terms.yaml` + `dictionary.py`), keyed by *parameter term*
(never by function). See [`DESIGN.md`](DESIGN.md) §4 for the full model.

## Repo layout

```
backend/    FastAPI app
  app/registry/   base.py (abstract Function + contract envelope), library_fn.py (one reflection
                  executor for squidpy/scanpy/spatialdata-io), custom/ (non-squidpy functions),
                  library_catalog.yaml (opt-in library manifests), terms.yaml + dictionary.py
                  (Parameter Term Dictionary), introspect.py (Registry)
  app/manifest/   data manifest contributor registry + seed contributors
  app/sessions/   manager, session (queue/worker), adapter (routes to Function.execute), regions,
                  shape_annotations (arrows/lines/boxes/polygons/ellipses/text -> sdata.shapes["annotations"]),
                  appstate, transform (points->global affine)
  app/schemas/    pydantic request-body schemas (annotations.py, kept in sync with
                  frontend/src/schemas/annotations.ts's zod schema)
  app/transport/  arrow (field -> Arrow IPC), tables (element inventory + dataframe page JSON),
                  annotations (shape-annotation read/JSON conversion), sse, livelog
                  (streams a running reader's log to the client live during import)
  app/recipes/    curated analysis recipes — JSON bundle files, discovered at startup
  app/persistence/ store (.zarr / .zarr.zip)
  app/imaging.py  tiled image pyramid + channel compositing + coordinate reconciliation;
                  the /image/{element}/info manifest also advertises the client-compositing
                  path (raster_base_url, zarr_group_path, contrast_limits, is_rgb)
  app/rasters.py  ingest-time re-tiling into a tile-chunked sharded pyramid; the resulting
                  per-session on-disk zarr store is also served raw (see the raster route)
                  for client-side (Viv) GPU compositing, with WebP tiles as the fallback
  app/snapshots.py JSON snapshot-config write/list
  app/datasets.py saved-checkpoint scan for the load/upload pickers (prewarmed cache)
  app/prewarm.py  background async queue that warms slow first-open menu lists off the event loop
  app/cirro.py    Cirro dataset upload (client-credentials auth, symlink-based upload folder)
  cli.py          offline recipe runner — reuses the registry/session engine headlessly
frontend/   React + TS + Vite + Tailwind + deck.gl SPA
nextflow/   Nextflow workflow wrapping backend/cli.py (uv installs deps at runtime; no image build)
docker/     single-image build (multi-stage), nginx edge, supervisor
docs/       CONTRACT.md (REST/SSE/Arrow API), images/ (README screenshots)
scripts/    test-data prep: prepare_test_data.py (Visium H&E), prepare_xenium_data.py (Xenium),
            prepare_xenium_tma.py (Xenium TMA grid for the Identify TMAs detector)
sds-governance/  governance bundle: RULES.md + AGENTS.md + skills/ + checks/ executable gate
                 (`make check`) + license allowlist
```

Component-level notes: [`backend/README.md`](backend/README.md),
[`frontend/README.md`](frontend/README.md).

## Where to change what

| I want to… | Start in | See |
|---|---|---|
| Add a curated multi-step workflow | `backend/app/recipes/NN_*.json` (JSON, auto-discovered) | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Add a new analysis or plot method | `backend/app/registry/custom/*.py` (a `Function` subclass) | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Expose more of a library, or add a library | `backend/app/registry/library_catalog.yaml` + `library_meta.yaml` | [DESIGN.md](DESIGN.md) §4.3 |
| Improve a parameter's widget/binding everywhere it appears | `backend/app/registry/terms.yaml` | [DESIGN.md](DESIGN.md) §4.4 |
| Change the REST/SSE/Arrow API | `backend/app/main.py` + `backend/app/transport/` | [docs/CONTRACT.md](docs/CONTRACT.md) |
| Change what streams live during import | `backend/app/transport/livelog.py` (+ `capture_log` in `registry/base.py`) | below |
| Change session/queue/worker behavior | `backend/app/sessions/` | [DESIGN.md](DESIGN.md) §5–6 |
| Change the checkpoint/persistence format | `backend/app/persistence/store.py` | [DESIGN.md](DESIGN.md) §3 |
| Change the deck.gl canvas / rendering | `frontend/src/components/canvas/` | [frontend/README.md](frontend/README.md) |
| Change how the browser reads raw image data (client-side Viv compositing) | `backend/app/main.py` raster route + `/image/{element}/info` fields; `rasters.py` `raster_stores` map | [docs/CONTRACT.md](docs/CONTRACT.md) |
| Change the parameter-form UI | `frontend/src/components/forms/` | — |
| Change the snapshot viewer or its emitted schema | `backend/app/snapshots.py` + `frontend/src/components/SnapshotViewer.tsx` + `snapshot-viewer.json` | schema rule in [CLAUDE.md](CLAUDE.md) |
| Change Cirro upload | `backend/app/cirro.py` + `frontend/src/components/CirroUploadDialog.tsx` | — |

### Live import logging

A reader can run for minutes; `transport/livelog.py` streams its log to the client as
it runs so the import UI shows progress instead of a frozen spinner. The full log is
still captured and delivered at completion — this only adds a live tap.

The session worker sets an ambient sink (`livelog.job_target`) around a read-bootstrap
job; `capture_log` (`registry/base.py`) tees each captured write to it, published as
`job.log` (`{session_id, job_id, chunk}`). The custom `.zarr` reader runs in the worker
thread, so it publishes directly. Library readers (spatialdata-io Xenium/Visium/…) run
in the loky child, which can't reach the bus: `kernel.run_library_call` opens a
`livelog.child_log_stream` (a `multiprocessing.Manager` queue + a drainer thread) for
read calls, the child's `capture_log(sink=queue.put)` pushes lines onto it, and the
parent drainer forwards them to the bus. The checkpoint-load path (`manager.create_from_load`)
uses `forward_load_logs(load_id)`, routing lines onto the existing `session.loading`
channel (`log` field) since no session id exists yet. The frontend accumulates these in
per-job / per-load buffers (`sessionStore`) and renders them with `AnsiLog`.

## Local dev environment

```bash
./run.sh          # data/ is the data folder
./run.sh --test   # test-data/ is the data folder
```

`run.sh` launches the backend (`uvicorn`, no `--reload` — see below) and the
frontend (`npm run dev`; Vite proxies `/api` and `/snapshots` to :8000) together.
Stop with Ctrl-C or, from another shell, `./stop.sh` (it reads `.run.pids` and
kills each process group).

`SDS_DATA_DIR` is the single read-write data folder — inputs, saved checkpoints,
and snapshots all live there; `run.sh` sets it to `data/` (or `test-data/` with
`--test`) and it can be overridden to point at any other folder. When unset it
defaults to `$HOME` (the container image relies on this, running from `$HOME`
where the deployment environment mounts datasets, e.g. `$HOME/datasets`). If a `.env` file
exists at the repo root, `run.sh` sources it before launching uvicorn, so `CIRRO_*`
config set there reaches the backend the same way docker compose's auto-loaded
`.env` does.

Client-side (Viv) image compositing is **on by default** (disable with
`SDS_CLIENT_IMAGE_COMPOSITING=0`); `SDS_CLIENT_IMAGE_MAX_CHANNELS` (default `6`) caps the
channels the browser will composite before falling back to WebP tiles. `useVivImageLayer.ts`
streams full-resolution tiles: it reuses the WebP tile path's world-coordinate tile selection
(`useImageTiles`) and renders a Viv `XRLayer` per visible tile (raw channels from the pyramid
`PixelSource.getTile`, GPU-composited) over a coarse base `XRLayer` (from `getRaster` of the
coarsest single-texture level). Both use `[px0, py1, px1, py0]` bounds (row-0 side as
`bounds[3]`=top, matching the WebP tile `quad`): the world/OrthographicView is y-up, so image row 0
(world y=0) must land at the screen bottom to align with the points. Viv's tiled `MultiscaleImageLayer` is deliberately NOT
used: its deck.gl `TileLayer` never updates its tileset under our world-coordinate
`OrthographicView` + non-unit `pixel_to_world` scale, so it renders nothing. `run.sh`
requires no change. The raw-raster route
(`/api/sessions/{id}/raster/{element}/{key}`) serves the session's on-disk normalized
zarr store; because object-adoption, subset, and close `rmtree` that store under the
session write lock, the route resolves the path AND reads the file bytes into memory
while holding `sess.lock.reading()` (returning them with manual Range handling rather
than a lazily-streamed `FileResponse`), so a read can never race a store deletion.

It expects a `.venv-introspect/` virtualenv at the repo root (Python 3.11; squidpy
does not support 3.13+), created with [uv](https://docs.astral.sh/uv/) (`uv venv`
fetches Python 3.11 itself if it is not already on the machine):

```bash
uv venv --python 3.11 .venv-introspect && . .venv-introspect/bin/activate
uv pip install -r backend/requirements.txt
uv pip uninstall leidenalg igraph   # GPL Leiden backends; use custom.leiden instead
```

**Backend edits require restarting `run.sh` manually.** The long-lived SSE stream
(`/api/events`) never closes, so `--reload` hangs on "Waiting for connections to
close" instead of picking up the change. Frontend edits under `frontend/src/` are
picked up live by Vite. To run the backend alone (or hit it with `curl`), see
[`backend/README.md`](backend/README.md).

## Deploying with Docker

The single-image build (SPA + backend, `tini` → `supervisord` → {`nginx` edge,
`uvicorn`}) is the recommended production form and the researcher quickstart in the
[README](README.md#run-it). The build stages, the two-tier memory limit
(`mem_limit` / `SDS_CONTAINER_MEM_MB` / `SDS_ADMISSION_PCT`), the render-concurrency
cap, the manual `docker run` form, and the full environment contract are documented
in [`docker/README.md`](docker/README.md).

## Tests

- `cd backend && ./check-contribution.sh` — the contribution gate: builds the
  registry, runs the custom-function self-check (closed widget/`effect_class`/`role`
  vocab, the `bound_to` contract, unique custom `key`s, and that every
  `custom_doc(...)` anchor resolves in `registry/custom/README.md`), asserts every
  function carries `citation` + `documentation`, and confirms the recipes load.
  Prints `OK N functions M recipes`. Run this before opening a PR (see
  [CONTRIBUTING.md](CONTRIBUTING.md)).
- `cd backend && python test_e2e.py` — full in-process round trip (load → compute →
  Arrow → plot → save `.zarr.zip` → reload), asserting app state + computed fields
  survive. Also covers staged/pending recipe steps + preflight, region annotate and
  its persistence, the shape-annotation editor, the editable points-transform,
  content-hashed checkpoint naming, plot invalidation/redraw, the data-inspector
  endpoints, cross-session isolation, saving a session that ran
  `filter_rank_genes_groups` (whose `uns` record arrays carry NaN gene names), the
  eight spatial/multi-sample custom methods on `xenium_tma.zarr`, the
  cell-segmentation `/shapes/{element}/geoarrow` polygons on `xenium.zarr`, the
  client-compositing raster route + `/info` manifest (raw zarr served with Range
  206) on `xenium.zarr`, and that an image tile keeps its signal after a reshaping
  compute (filter_cells) — i.e. the per-session raster store isn't deleted while the
  adopted object still references it. The five Xenium-backed flows (zarr-import,
  custom methods, segmentation, raster, raster-survives-reshape) skip with a
  `[skip]` line when their fixture is absent, so CI runs only the Visium-backed
  subset (including the schema gate); regenerate the Xenium fixtures locally via
  `scripts/prepare_xenium_*.py` to exercise them.
- `cd backend && python test_cli.py` — offline CLI round trip: loads
  `visium_hne.zarr`, runs a compute + plot recipe headlessly, and asserts the output
  `.zarr.zip` and `plots/…/figure.{svg,pdf}` are written and reload with history
  intact.
- `cd backend && PYTHONPATH=. python test_schema_gate.py` — dataset-free snapshot
  schema gate (see the schema-versioning rule in [CLAUDE.md](CLAUDE.md)).
- `cd backend && PYTHONPATH=. python test_compression.py` — dataset-free unit test
  for `SelectiveGZipMiddleware`: which content types compress, round-trip/passthrough
  correctness, and the regression guard that gzip runs off the event loop (a
  concurrent request is not stalled for the whole compress on the single worker).
- `cd frontend && npx tsc --noEmit -p tsconfig.app.json && npm run build` — typecheck
  + build.
- `cd frontend && npm run check:tours` — static guard that every guided-tour anchor
  has a matching `data-tour="…"` attribute in the source.
- `cd frontend && npm run test:e2e` — Playwright browser e2e tests (`frontend/e2e/`).
  Boots the real backend (against `test-data/`) and the Vite dev server, drives the
  app in Chromium to open `visium_hne`, run a compute function end-to-end, browse the
  result, and walk the guided tour.

## Test datasets

`scripts/prepare_test_data.py` downloads squidpy's `visium_hne_sdata` (a mouse-brain
Visium H&E section: 2688 spots × 18078 genes, with `leiden`/`cluster` annotations)
and writes `test-data/visium_hne.zarr`. `scripts/prepare_xenium_data.py` builds
`test-data/xenium.zarr` (~70 MB) from the 10x "Human Lung (2 FOV)" Xenium demo —
11,898 cells × 289 genes of raw counts with cell/nucleus boundaries and a morphology
image (the target for the scanpy preprocessing recipes). `scripts/prepare_xenium_tma.py`
builds `test-data/xenium_tma.zarr`, a synthetic 3×4 tissue-microarray grid used to
validate the **Identify TMAs** detector and the multi-sample methods (Milo, LISI,
Pseudobulk DE). `test-data/` is gitignored — datasets are regenerated by these
scripts, never committed.

## Run offline (headless CLI + Nextflow)

`backend/cli.py` runs a recipe over a dataset without the server or frontend, reusing
the same introspected registry, session worker, and persistence the app uses (so
results match the UI). Run it from `backend/` with the dev venv:

```bash
cd backend
# load an existing SpatialData store and run a bundled recipe
../.venv-introspect/bin/python cli.py \
  --parser zarr --input ../test-data/visium_hne.zarr \
  --recipe app/recipes/07_neighborhood_enrichment.json --output ../out

# or parse a raw dataset with a spatialdata-io reader
../.venv-introspect/bin/python cli.py \
  --parser io.xenium --input /path/to/xenium_bundle \
  --recipe app/recipes/12_preprocess_cluster_raw_counts.json --output ../out

../.venv-introspect/bin/python cli.py --list-parsers   # available parsers
```

| Flag | Meaning |
|---|---|
| `--parser` | reader registry key (`io.xenium`), bare reader name (`xenium`), or `zarr`/`spatialdata` to load an existing `.zarr`/`.zarr.zip` |
| `--input` | raw data folder (reader mode) or the `.zarr`/`.zarr.zip` (zarr mode) |
| `--recipe` | path to a recipe JSON file, or a bundled recipe name |
| `--recipe-params` | JSON object of recipe-parameter overrides (fills the recipe's `$param` refs) |
| `--output` | output directory (created if absent) |
| `--reader-params` | JSON object of extra kwargs for the reader (reader mode) |
| `--name` | base name for the output `.zarr.zip` (default: from `--input`) |

The output folder holds `<name>.zarr.zip` (the full SpatialData + app state, reloadable
in the app) and `plots/<NN>_<namespace>.<function>/figure.{svg,pdf}` per plot step.

**Nextflow.** `nextflow/main.nf` wraps the CLI and exposes the same parameters; its
container installs the pinned Python deps at runtime with `uv`, so there is no image
to build. Quick run against the test dataset:

```bash
nextflow run nextflow/main.nf -profile test,docker
```

See [`nextflow/README.md`](nextflow/README.md) for the full parameter list.

## Snapshot viewer hosting

Saved snapshots don't carry any viewer code — each `.html` page loads a shared,
version-pinned viewer bundle over the network, built and published once per version
to GitHub Pages. Snapshots (in the app, in the data folder, and in Cirro bundles)
just point at it.

- **Single source of truth:** `snapshot-viewer.json` at the repo root
  (`{ "version", "pagesBaseUrl" }`). The backend reads it (`backend/app/config.py`),
  the frontend build imports it, and CI reads it with `jq`/node — never hardcode the
  pieces elsewhere.
- **Published URL:** `${pagesBaseUrl}/viewer/${version}/app.js`. Every snapshot HTML
  references this exact versioned path with a classic (non-module) `<script src>`,
  which loads cross-origin from GitHub Pages without CORS headers.
- **Immutable per version:** the CI workflow (`.github/workflows/deploy-viewer.yml`)
  publishes `viewer/<version>/` accumulatively and never deletes prior version dirs,
  so a snapshot saved against an older viewer keeps rendering forever. Changing the
  emitted schema means bumping `version` in `snapshot-viewer.json` and publishing a
  new versioned bundle — the exact, test-gated procedure is the **"Version the
  snapshot viewer schema"** rule in [`CLAUDE.md`](CLAUDE.md); follow it exactly.
- **Building it:** `cd frontend && npm run build:app` builds the single-file classic
  IIFE bundle to `frontend/dist-app/viewer/<version>/app.js`. This is what CI
  publishes to GitHub Pages — it is **not** bundled into Cirro uploads or served by
  the backend. `run.sh` does not build it, and local dev/Cirro testing does not
  require it. Rebuild and republish only when the viewer or schema version changes.

## Contributing

Two ways to add analysis capability, fully documented in
[`CONTRIBUTING.md`](CONTRIBUTING.md):

- **A recipe** (easy path) — one JSON file in `backend/app/recipes/`, no Python.
- **A custom function** (fuller path) — one `Function` subclass in
  `backend/app/registry/custom/`, plus its provenance and README section.

Every contribution must keep the docs current (per [`CLAUDE.md`](CLAUDE.md)), declare
provenance (`citation` + `documentation`), and pass `./check-contribution.sh`. Open a
PR against `main`.

## Governance

Repo invariants (RULES.md R1–R16) are enforced by `sds-governance/` (`make check`).
Read [`sds-governance/AGENTS.md`](sds-governance/AGENTS.md) before changing the
function catalog, the term dictionary, or the license allowlist.
