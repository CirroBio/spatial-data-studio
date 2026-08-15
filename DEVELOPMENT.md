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
  running compute and render the up-to-date object. Ingest-time raster re-tiling
  (`rasters._child_rebuild`) goes to the same subprocess pool for the same reason —
  it is the other multi-minute CPU burn, and in-process it stalled every *other*
  viewer while one user opened a checkpoint.
- **Execution is an audit log, not a replay graph.** Compute mutates the object in
  place; there is no undo and no reactive recomputation. App state persists in
  `sdata.attrs["app_state"]` and round-trips through the Zarr store.
- **One editor per session.** Since every viewer shares one in-memory object, a
  per-session *edit lock* decides who may mutate it: viewers heartbeat
  `POST /api/presence`, attaching to an unlocked session takes its lock, and every
  mutating route refuses a request from anyone else (423). Presence and locks are
  process-memory only, keyed by a client-minted id — no accounts, no auth (DESIGN §16.5).
- **An MCP assistant surface** (`app/mcp/`, mounted at `POST /api/mcp`) lets an AI
  agent drive the same machinery: its tools are thin wrappers over the functions the
  REST routes call, so agent mutations flow through the ordinary job queue + SSE bus
  and appear live in every browser. The agent is a first-class presence viewer
  ("Claude (assistant)") that can take a watched session's lock explicitly and
  releases it when done. `view_display` renders a display through the snapshot core
  with a world-labeled grid and a pixel→world affine, so the agent can act (annotate/
  subset) on exactly what it saw (DESIGN §29).

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
  app/main.py     FastAPI app + lifespan; the core session/job/staging/plot/display/subset/
                  annotation/points-transform/data-path/SSE routes. Self-contained route
                  groups live in app/routers/.
  app/routers/    APIRouter modules mounted by main.py: imaging (image tiles + raw raster
                  zarr), cirro (device-code login, projects/folders, background uploads),
                  snapshots (figure save/preview/list/delete + checkpoint serving), recipes
  app/deps.py     shared FastAPI helpers used by main.py and every router: the MANAGER
                  holder, session lookup (_session/_writable_session — the read-only + edit-lock
                  guard every mutating route goes through), the per-request client id
                  (bind_client_id/CLIENT_ID), the read-lock/executor wrappers, and the
                  image-render admission semaphore
  app/registry/   base.py (abstract Function + contract envelope), library_fn.py (one reflection
                  executor for squidpy/scanpy/spatialdata-io), custom/ (non-squidpy functions),
                  library_catalog.yaml (opt-in library manifests), terms.yaml + dictionary.py
                  (Parameter Term Dictionary), introspect.py (Registry)
  app/mcp/        the MCP assistant surface: server.py (FastMCP tool definitions),
                  vision.py (display render + pixel->world coordinate contract + overlays +
                  selection membership), agent.py (the assistant's presence identity/lock),
                  guides/ (domain + app guidance served to the connecting agent)
  app/sessions/   manager, session (queue/worker), presence (viewer list + per-session edit lock),
                  adapter (routes to Function.execute), regions,
                  shape_annotations (arrows/lines/boxes/polygons/ellipses/text -> sdata.shapes["annotations"]),
                  appstate, transform (points->global affine)
  app/schemas/    pydantic request-body schemas (annotations.py, kept in sync with
                  frontend/src/schemas/annotations.ts's zod schema)
  app/transport/  arrow (field -> Arrow IPC), tables (element inventory + dataframe page JSON),
                  annotations (shape-annotation read/JSON conversion), sse, livelog
                  (streams a running reader's log to the client live during import)
  app/recipes/    curated analysis recipes — JSON bundle files, discovered at startup
  app/persistence/ store (.zarr / .zarr.zip; also the raster sharding + `viewer/` sidecar
                  that make a checkpoint readable by the serverless viewer)
  app/imaging.py  tiled image pyramid + channel compositing + coordinate reconciliation;
                  the /image/{element}/info manifest also advertises the client-compositing
                  path (raster_base_url, zarr_group_path, contrast_limits, is_rgb)
  app/rasters.py  ingest-time re-tiling into a tile-chunked pyramid; the resulting
                  per-session on-disk zarr store is also served raw (see the raster route)
                  for client-side (Viv) GPU compositing, with WebP tiles as the fallback
  app/snapshots.py matplotlib figure render (vector PDF/raster PNG) + gallery list/delete
  app/datasets.py saved-checkpoint scan for the load/upload pickers (prewarmed cache)
  app/prewarm.py  background async queue that warms slow first-open menu lists off the event loop
  app/cirro.py    Cirro dataset upload (per-browser device-code auth, symlink-based upload folder)
  cli.py          offline recipe runner — reuses the registry/session engine headlessly
frontend/   React + TS + Vite + Tailwind + deck.gl SPA
  src/data/       the DataSource abstraction the canvas renders through: apiSource (live
                  session over HTTP) and checkpointSource (a .zarr.zip read directly with
                  zarrita over HTTP Range — the serverless viewer, DESIGN §14.2), plus
                  checkpointIndex (the index.json deployment manifest, §14.3)
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
| Change the REST/SSE/Arrow API | `backend/app/main.py` (core routes) or `backend/app/routers/` (imaging/cirro/snapshots/recipes) + `backend/app/transport/` | [docs/CONTRACT.md](docs/CONTRACT.md) |
| Change what streams live during import | `backend/app/transport/livelog.py` (+ `capture_log` in `registry/base.py`) | below |
| Change session/queue/worker behavior | `backend/app/sessions/` | [DESIGN.md](DESIGN.md) §5–6 |
| Change who may edit a session (presence, the edit lock, viewer names) | `backend/app/sessions/presence.py` + `deps.py` (`_claim_lock`) + `frontend/src/lib/presence.ts` (identity + gate) + `hooks/usePresence.ts` (heartbeat) + `components/LockBadge.tsx` | [DESIGN.md](DESIGN.md) §16.5 |
| Change the MCP assistant surface (tools, vision render, agent guidance) | `backend/app/mcp/server.py` (tools) + `vision.py` (render/coords/membership) + `agent.py` (presence/lock) + `guides/*.md` (guidance text); mounted in `main.py` | [DESIGN.md](DESIGN.md) §29 |
| Change the checkpoint/persistence format | `backend/app/persistence/store.py` | [DESIGN.md](DESIGN.md) §3, §14.1, [docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md) |
| Change what the serverless viewer can read from a checkpoint | `backend/app/persistence/store.py` (`_write_viewer_sidecar`, the writer half) + `frontend/src/data/checkpointSource.ts` (the reader half) — the two must move together | [DESIGN.md](DESIGN.md) §14.1–14.2, [docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md) §4 |
| Change the shape of `app_state`, the `viewer/` sidecar, `X_csc`, or `index.json` | `backend/app/schemas/checkpoint/*.schema.json` (the JSON Schema is validated against on every write) + [docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md) in the same commit — `sds-governance/checks/check_checkpoint_schema_docs.py` fails the build otherwise | [docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md) |
| Add a render-path call the canvas makes | `frontend/src/data/types.ts` (the `DataSource` interface), then **both** `apiSource.ts` and `checkpointSource.ts` | [DESIGN.md](DESIGN.md) §14.2 |
| Change what the serverless viewer shows (collapsed-by-default sidebar with the analysis history only, PNG export) | `frontend/src/components/Sidebar.tsx` (the serverless branch), `store/sessionStore.ts` (`leftMenuOpen` default), `lib/canvasCapture.ts` | [DESIGN.md](DESIGN.md) §14.2 |
| Change the `index.json` deployment manifest or the checkpoint switcher | `frontend/src/data/checkpointIndex.ts` (format + navigation), `components/CheckpointIndexPage.tsx` (landing), `components/CheckpointPicker.tsx` (header), `backend/app/cirro.py` (`_write_viewer_index`) | [DESIGN.md](DESIGN.md) §14.3, [docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md) §8 |
| Change the deck.gl canvas / rendering | `frontend/src/components/canvas/` | [frontend/README.md](frontend/README.md) |
| Retune the palette, theme tokens, fonts, or the Cirro mark | `frontend/src/index.css` (tokens) + `frontend/tailwind.config.js` (names) + `frontend/src/components/CirroMark.tsx` / `public/favicon.svg` (logo) | [frontend/README.md](frontend/README.md) |
| Change the canvas minimap (overview inset) | `frontend/src/components/canvas/Minimap.tsx` (overlay + navigation) + `SpatialCanvas.tsx` (extent/thumbnail wiring) + `backend/app/snapshots.py` `_draw_minimap` (figure inset) | [DESIGN.md](DESIGN.md) §9.11 |
| Change how the browser reads raw image data (client-side Viv compositing) | `backend/app/routers/imaging.py` raster route + `/image/{element}/info` fields; `rasters.py` `raster_stores` map | [docs/CONTRACT.md](docs/CONTRACT.md) |
| Change the parameter-form UI | `frontend/src/components/forms/` (`FunctionFields` renders the widgets incl. the `FsPicker` filesystem picker; `FunctionForm` adds the submit footer; the New Session dialog reuses `FunctionFields` as the reader's input form) | — |
| Change how a reader param is classified as a folder/file/value input | `backend/app/registry/reader_paths.py` (`path_kind` + the absolute/relative path sets, shared with `sessions/manager.py` validation) | [docs/CONTRACT.md](docs/CONTRACT.md) |
| Change how a snapshot figure renders or what it embeds | `backend/app/snapshots.py` (render + metadata) + `frontend/src/components/SnapshotExportModal.tsx` (framing/output) + `frontend/src/components/SnapshotBrowser.tsx` (gallery) | [DESIGN.md](DESIGN.md) §14 |
| Change Cirro upload | `backend/app/cirro.py` (client + bundle) + `backend/app/routers/cirro.py` (routes + upload queue) + `frontend/src/components/CirroUploadDialog.tsx` | [DESIGN.md](DESIGN.md) §15 |
| Change Cirro login (device code, credential scoping, expiry) | `backend/app/cirro.py` (`CredentialStore`, `start_login`) + `backend/app/routers/cirro.py` (`/api/cirro/auth`) + `frontend/src/components/CirroConnectDialog.tsx` + the token helpers in `frontend/src/api.ts` | [DESIGN.md](DESIGN.md) §15 |

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
parent drainer forwards them to the bus. Opening a saved checkpoint runs as the session's
first worker job too: `manager.create_from_load` returns a `loading` shell immediately and
enqueues `Session._run_load`, which does the slow unzip/read/re-tile and adopts the object
under the write lock (like a read bootstrap), so a large load never blocks the POST past a
fronting proxy's origin timeout (the 504 fix). It uses `forward_load_logs(load_id)`, routing
lines — plus milestone progress and a terminal `done`/`hash_check` event — onto the
`session.loading` channel keyed by the client-minted `load_id`. The frontend accumulates
these in per-job / per-load buffers (`sessionStore`) and renders them with `AnsiLog`.

## Local dev environment

```bash
./run.sh          # data/ is the data folder
./run.sh --test   # test-data/ is the data folder
```

`run.sh` launches the backend (`uvicorn`, no `--reload` — see below) and the
frontend (`npm run dev`; Vite proxies `/api` to :8000) together.
Stop with Ctrl-C or, from another shell, `./stop.sh` (it reads `.run.pids` and
kills each process group).

`SDS_DATA_DIR` is the single read-write data folder — inputs, saved checkpoints,
and snapshots all live there; `run.sh` sets it to `data/` (or `test-data/` with
`--test`) and it can be overridden to point at any other folder. When unset it
defaults to `$HOME` (the container image relies on this, running from `$HOME`
where the deployment environment mounts datasets, e.g. `$HOME/datasets`).

`SDS_APP_URL` is the URL a *person* opens the app at; the MCP assistant quotes it
when directing the user to a session. `run.sh` defaults it to the Vite dev server
(`http://localhost:5173`); docker-compose sets it to the published port. The MCP
endpoint itself rides the backend (`POST /api/mcp` on :8000 in dev) — the repo's
`.mcp.json` points a Claude Code session started in this repo at it, and
`SDS_MCP_IDLE_RELEASE_S` (default 900) is how long the assistant's presence (and any
edit lock it holds) survives without a tool call.

The *working set* — the unpacked `.zarr.zip` extract dir and per-session normalized
raster caches (each up to a few hundred MB) — lives separately under `SDS_WORK_DIR`,
kept out of `DATA_DIR` so a transient `*.zarr` extract never shows up in the dataset
picker. For local dev, `run.sh` creates a dedicated `sds-work.XXXXXX` dir under the
system temp dir and **deletes it on exit** (its cleanup trap fires on normal exit,
Ctrl-C, or `stop.sh`'s TERM) — so a killed/exited dev server never leaves multi-GB
raster temp dirs piling up in the system temp dir. Preset `SDS_WORK_DIR` yourself
(e.g. at a sized tmpfs mount) and `run.sh` respects it and won't delete it. In Docker
it is a `/work` tmpfs with `SDS_WORK_DIR_IN_RAM=1`, so the working set is held in RAM
and its usage is folded into the admission accounting (see DESIGN §23.4). If a `.env` file
exists at the repo root, `run.sh` sources it before launching uvicorn, so `CIRRO_*`
config set there reaches the backend the same way docker compose's auto-loaded
`.env` does.

Cirro upload works in local dev — each browser signs in with its own account — and
carries the full serverless bundle: `run.sh` builds the SPA into `frontend/dist`
(skipped when the build is already newer than the frontend sources) and sets
`SDS_STATIC_DIR` to it, so uploads include `index.html` + `assets/` alongside the
checkpoints and `index.json`. If the build fails, `run.sh` still launches but leaves
`SDS_STATIC_DIR` unset — uploads then omit the viewer and the upload dialog says so.
Starting uvicorn by hand without `SDS_STATIC_DIR` behaves the same way.

### Driving the serverless viewer locally

`?checkpoint=<url>` opens a `.zarr.zip` directly with no backend (DESIGN §14.2). For a
local round trip, save a checkpoint into `SDS_DATA_DIR` and point the running app at
the existing checkpoint route, which already serves Range + HEAD:

```bash
open 'http://localhost:5173/?checkpoint=/api/checkpoints/<name>.sdata.zarr.zip'
```

That still runs the backend, but only as a static byte server — nothing under
`/api/sessions` is touched, which you can confirm in the network panel.

To test the genuinely serverless case, assemble a deployment and serve it with no
backend at all. `vite preview` works because it honors Range:

```bash
cd frontend && npm run build && cp /path/to/*.sdata.zarr.zip dist/ && npx vite preview --port 5190
```

with a `dist/index.json` listing them (DESIGN §14.3):

```json
{ "title": "Demo checkpoints",
  "checkpoints": [{ "path": "my-run.sdata.zarr.zip", "label": "Visium H&E" }] }
```

Opening `/` then shows the collection; picking one opens it, and the header switcher
moves between them. A host qualifies if it honors HTTP **Range on GET** and returns
`Content-Range` (no HEAD is ever issued — see `RangeGetReader`); cross-origin
additionally needs CORS exposing `Content-Range`.

Only checkpoints written by the current code carry the `viewer/` sidecar, and the
viewer **requires** it: a Zarr v3 store has no child index, so without the sidecar (and
the consolidated metadata written with it) the reader can't even name the table. An
older checkpoint is rejected on open with a message saying to re-save it, rather than
opening to an empty session. Re-saving through the app is the fix.

Client-side (Viv) image compositing is the sole canvas image path, **on by default**
(disable with the `sds:disableClientCompositing` localStorage key, which turns the canvas
image off — there is no server-composited fallback); `SDS_CLIENT_IMAGE_MAX_CHANNELS`
(default `6`) caps how many channels the browser composites in one shader pass.
`useVivImageLayer.ts` builds a single Viv `MultiscaleImageLayer` whose deck.gl `TileLayer`
selects and streams pyramid tiles natively: when a display has an image the canvas
`OrthographicView` works in that image's own level-0 pixel space (the image sits at
`[0,0,W,H]` with no modelMatrix; the cell points and every world-space overlay carry the
`world→pixel` modelMatrix instead — see DESIGN §9.4), which is the case Viv is built for.
(This supersedes the earlier hand-rolled per-tile `XRLayer` scheme, which existed only
because a scaled `pixel_to_world` affine on the image stopped deck's `TileLayer` from ever
updating its tileset.) Channel color/visibility/contrast are shader uniforms (instant, no
refetch). Two deck `TileLayer` props are forwarded through Viv for smoothness: a
memory-budgeted `maxCacheSize` (so pan/zoom back over a level just visited is a cache hit,
not a re-fetch) and a `debounceTime` (so a continuous gesture doesn't fire — then drop —
tile requests for every level it sweeps through). `useImageTilePrefetch.ts` additionally
warms the next-finer pyramid level (plus a current-level pan ring) through `loader.getTile`
while the camera is idle, so a subsequent zoom-in reads warmed tiles from the browser cache
(304-revalidated against the raster route's ETag) instead of stalling. `useTileLoadProgress.ts`
wraps each pyramid level's `getTile` (both paths call it; deck exposes no request-start
callback) to track a loading *session* — completed vs. requested tiles from the first fetch
until none are in flight, held open a minimum of 1s — surfaced as the `ImageTileStatus`
corner progress bar so the user sees image data streaming in even while the canvas otherwise
looks settled. `run.sh`
requires no change. The raw-raster route
(`/api/sessions/{id}/raster/{element}/{key}`) serves the session's normalized zarr store
(on disk, or in RAM when `WORK_DIR` is a tmpfs); because object-adoption, subset, and
close `rmtree` that store under the session write lock, the route resolves the path AND
reads the file bytes into memory while holding `sess.lock.reading()` (returning them with
manual Range handling rather than a lazily-streamed `FileResponse`), so a read can never
race a store deletion. A byte-budgeted server-side LRU of the raw chunk bytes
(`SDS_RASTER_CHUNK_CACHE_MB`, default 256; `imaging._raster_chunk_cache`, evicted by
`evict_caches` on the same adoption/close boundary as the tile cache) short-circuits the
re-read when a pan returns over already-seen tiles.

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

The single-image build (SPA + backend, `tini` → `work-tmpfs.sh` → `supervisord` →
{`nginx` edge, `uvicorn`}) is the recommended production form and the researcher
quickstart in the [README](README.md#run-it). The build stages, the two-tier memory limit
(`mem_limit` / `SDS_CONTAINER_MEM_MB` / `SDS_ADMISSION_PCT`), the render-concurrency
cap, the manual `docker run` form, and the full environment contract are documented
in [`docker/README.md`](docker/README.md). The `work-tmpfs.sh` entrypoint sizes the
`/work` tmpfs to `SDS_WORK_TMPFS_PCT` of the detected memory limit at startup so the
RAM working set autoscales with `mem_limit`; it needs `cap_add: SYS_ADMIN` (compose)
and fails open to the mount-time `size=` otherwise.

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
  survive. Every checkpoint write along the way is validated against
  `backend/app/schemas/checkpoint/*.schema.json` (see
  [docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md)) — a save that produces a
  structure the schema doesn't allow fails the job rather than writing a
  non-conformant file. Also covers staged/pending recipe steps + preflight, region annotate and
  its persistence, the shape-annotation editor, the editable points-transform,
  content-hashed checkpoint naming, plot invalidation/redraw, the data-inspector
  endpoints, cross-session isolation, saving a session that ran
  `filter_rank_genes_groups` (whose `uns` record arrays carry NaN gene names), the
  eight spatial/multi-sample custom methods on `xenium_tma.zarr`, the
  cell-segmentation `/shapes/{element}/geoarrow` polygons on `xenium.zarr`, viewer
  presence + the per-session edit lock (auto-lock on attach, 423 for everyone else,
  release → take, and the heartbeat timeout freeing a lock — `run_session_lock_flow`),
  the MCP assistant surface over the real `/api/mcp` transport (`run_mcp_flow`:
  initialize/tools, reader-backed create_session, lock takeover etiquette,
  compute+plot+`view_plot` PNG, and the vision coordinate contract — the
  `view_display` pixel→world affine is proven by mapping a pixel rectangle to world
  polygons whose `inspect_region`/`annotate_region` membership equals an independent
  numpy count, plus embedding-space selection, shape annotations, save, figure
  export, and a subset that evicts the parent), the
  client-compositing raster route + `/info` manifest (raw zarr served with Range
  206) on `xenium.zarr`, an image tile keeping its signal after a reshaping compute
  (filter_cells) — i.e. the per-session raster store isn't deleted while the
  adopted object still references it — and rendering a snapshot figure end to end
  (preview, PDF+PNG render with the minimap inset, gallery list, download, embedded
  metadata, delete — `run_snapshot_flow`). The five Xenium-backed
  flows (zarr-import, custom methods, segmentation, raster, raster-survives-reshape)
  skip with a `[skip]` line when their fixture is absent, so CI runs only the
  Visium-backed subset; regenerate the Xenium fixtures locally via
  `scripts/prepare_xenium_*.py` to exercise them.
- `cd backend && python test_cli.py` — offline CLI round trip: loads
  `visium_hne.zarr`, runs a compute + plot recipe headlessly, and asserts the output
  `.zarr.zip` and `plots/…/figure.{svg,pdf}` are written and reload with history
  intact.
- `cd backend && PYTHONPATH=. python test_compression.py` — dataset-free unit test
  for `SelectiveGZipMiddleware`: which content types compress, round-trip/passthrough
  correctness, and the regression guard that gzip runs off the event loop (a
  concurrent request is not stalled for the whole compress on the single worker).
- `cd frontend && npx tsc --noEmit -p tsconfig.app.json && npm run build` — typecheck
  + build.
- `cd frontend && npm run check:tours` — static guard that every guided-tour anchor
  reaches the DOM: as a `data-tour="…"` attribute placed directly, or as the prop a
  shared component renders that attribute from (`dataTour` in `PanelTabs`) — the check
  resolves those forwarding props itself. A component that instead re-spreads props
  onto `data-tour` hides the anchor from it, so name the prop.
- `cd frontend && npm run test:e2e` — Playwright browser e2e tests (`frontend/e2e/`).
  Boots the real backend (against `test-data/`) and the Vite dev server, drives the
  app in Chromium to import `visium_hne` through the New Session reader form, run a
  compute function end-to-end, browse the result, and walk the guided tour. The
  webServer entries reuse whatever already listens on 5173/8000, so make sure those
  are this app's servers and not another project's.

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

## Snapshots

A snapshot is a **rendered figure**, not a re-openable view. `backend/app/snapshots.py`
renders a display server-side with matplotlib into a vector PDF and/or raster PNG:
the microscopy image (when shown) is rasterized as an image layer (reusing
`imaging`'s per-channel compositing), cell points are emitted as vector markers
colored by the same palette/colormap the frontend uses (ported in `snapshots.py` so a
figure matches the canvas without shipping a per-cell buffer). When the display is in
`render_mode: 'points+shapes'` and zoomed in past the same gate the canvas applies
(`SHAPES_MIN_CELL_PX`, and a `POLYGON_LIMIT` cells-in-view cap), the point markers are
replaced by the actual cell-boundary polygons — the viewport-clipped world-space
geometry from `transport/geometry.clipped_polygons` (shared with the GeoArrow
endpoint), drawn as vector paths, filled or stroked per `boundary_style` and colored per
cell — so a snapshot of a segmentation view captures the outlines, not circles. Above
`POINT_VECTOR_CAP` features in view the point/polygon layer is rasterized to keep the
PDF small. Colors/styling come from the display's persisted encoding; the render request
carries only framing (`viewport`) + output settings (`width_px`, `height_px`, `dpi`,
`formats`).

Each snapshot is a set of sibling files under `DATA_DIR` sharing a `<base>` name:
`<base>.figure.pdf`/`.png` (the deliverables), `<base>.figure.thumb.png` (gallery
thumbnail), and `<base>.figure.json` (the provenance sidecar the gallery lists from).
Provenance — dataset, viewport, output settings, full display encoding, and the analysis
recipe — is embedded in every output file (PDF `/Info` + PNG `tEXt`) as well as the
sidecar. Endpoints: `POST /api/sessions/{sid}/snapshot` (render + save),
`POST /api/sessions/{sid}/snapshot/preview` (low-res PNG for the export modal),
`GET /api/snapshots` (gallery list), `GET /api/snapshots/{name}/file?fmt=pdf|png`,
`GET /api/snapshots/{name}/thumbnail`, `DELETE /api/snapshots/{name}`. Frontend:
`SnapshotExportModal.tsx` (framing + output + preview) and `SnapshotBrowser.tsx` (the
gallery); the active canvas registers the handler that seeds the modal with the live
viewport. See [DESIGN.md](DESIGN.md) §14.

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

Repo invariants (RULES.md R1–R17) are enforced by `sds-governance/` (`make check`).
Read [`sds-governance/AGENTS.md`](sds-governance/AGENTS.md) before changing the
function catalog, the term dictionary, or the license allowlist. R17 (a checkpoint
JSON Schema and [docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md) change
together) also runs as a local pre-commit hook — `pip install pre-commit &&
pre-commit install` once per clone (`.pre-commit-config.yaml`).
