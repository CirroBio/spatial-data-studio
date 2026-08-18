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
                  (bind_client_id/CLIENT_ID), the read-lock/executor wrappers, the
                  image-render admission semaphore, and the business helpers shared by a
                  route and the MCP surface (default checkpoint path, var-name search)
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
                  packages/viewer/src/schemas/annotations.ts's zod schema)
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
  app/datasets.py saved-checkpoint scan for the load/upload pickers (prewarmed cache) +
                  the one-level data-dir browse behind /api/fs/browse and browse_data_dir
  app/prewarm.py  background async queue that warms slow first-open menu lists off the event loop
  app/cirro.py    Cirro dataset upload (per-browser device-code auth, symlink-based upload folder)
  cli.py          offline recipe runner — reuses the registry/session engine headlessly
packages/viewer/  @cirrobio/spatial-viewer — the deck.gl canvases and the checkpoint
                  reader as a library, so a Cirro dashboard can render the same canvas
                  natively instead of embedding the app in an iframe. See
                  packages/viewer/README.md
  src/canvas/     the canvases and their layers, legends, minimap, lasso and shape
                  editing, plus canvas-host.tsx (the CanvasHost contract) and the
                  palettes/view-fit helpers a host's own controls need
  src/data/       the DataSource contract the canvas renders through, the DataSourceProvider,
                  and checkpointSource (a .zarr.zip read directly with zarrita over HTTP
                  Range — the serverless viewer, DESIGN §14.2). parquetShapes.ts +
                  wkbGeoArrow.ts are the boundary half: the shape file is GeoParquet, not
                  zarr, so it is range-queried with hyparquet against its covering index
  src/types.ts    the display model (DisplaySpec/DisplayEncoding/SessionFields/ImageInfo)
  src/defaults.ts the fallbacks the canvases apply for absent encoding fields, exported so
                  a host that authors a display agrees with what will actually render
frontend/   React + TS + Vite + Tailwind SPA around that canvas (an npm workspace
            sibling of packages/viewer; one `npm install` at the repo root covers both)
  src/data/       apiSource (the live-session DataSource over HTTP) + checkpointIndex
                  (the index.json deployment manifest, §14.3) + embedBridge (embed mode)
  src/components/canvas/  what stays app-side: the Tailwind-styled in-canvas settings
                  panels (CanvasControls / EmbeddingControls and their fields), and the
                  StudioSpatialCanvas / StudioEmbeddingCanvas adapters that drop them
                  into the library canvas' `controls` slot
nextflow/   The workflow (one entrypoint), wrapping backend/cli.py; uv installs deps at
            runtime, so there is no image build
  main.nf           discover datasets under an input -> per-type recipes -> mirrored
                    checkpoints + MultiQC report + a serverless viewer
  data_types.json   the catalog: recognition patterns, readers, recipes, which knob
                    applies to which type, and how each type's checkpoint opens in the
                    viewer (schema: data_types.schema.json). All data-type-specific
                    knowledge lives here, none of it in the workflow
  modules/          discovery: generic, catalog-driven tree walk and classification
  tests/            check_catalog.py (catalog <-> schema <-> params <-> recipes) and the
                    discovery harness it drives
docker/     single-image build (multi-stage), nginx edge, supervisor
docs/       CONTRACT.md (REST/SSE/Arrow API), images/ (README screenshots)
docs-site/  VitePress documentation site published to GitHub Pages. Renders the repo's own
            markdown in place (srcDir is the repo root); demo/ holds the only new pages, and
            viewer-data/ the committed demo checkpoints they embed
scripts/    test-data prep: prepare_test_data.py (Visium H&E), prepare_xenium_data.py (Xenium),
            prepare_xenium_tma.py (Xenium TMA grid for the Identify TMAs detector),
            prepare_demo_checkpoints.py (small checkpoints for the docs site's live demos)
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
| Change which elements a save can leave out, at what resolution images are written, or how their sizes are estimated | `backend/app/persistence/store.py` (`select_elements`, `trim_pyramid`, `element_size_mb`, `image_levels`) + `sessions/appstate.py` (`prune_to_elements`) + `frontend/src/components/SaveCheckpointDialog.tsx` | below |
| Change where a save writes, what the file is named, or what the session is called | `backend/app/main.py` (`_validated_destination`, `_validated_name`) + `deps.py` (`default_save_path`) + `sessions/session.py` (`rename`, `_run_load`) + `frontend/src/components/SaveCheckpointDialog.tsx` | below |
| Change how rendered plot figures are stored, served or shown | `backend/app/persistence/store.py` (`_write_figures`, `read_figure`, `figure_index`) + `sessions/session.py` (`figure`, `figure_index`, `figures_to_persist`) + `frontend/src/lib/figures.ts` + `components/PlotGallery.tsx` / `FigureLightbox.tsx` / `PlotDetail.tsx` | below |
| Change what the serverless viewer can read from a checkpoint | `backend/app/persistence/store.py` (`_write_viewer_sidecar`, the writer half) + `packages/viewer/src/data/checkpointSource.ts` (the reader half) — the two must move together | [DESIGN.md](DESIGN.md) §14.1–14.2, [docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md) §4 |
| Change how cell boundaries are indexed or range-queried | `backend/app/persistence/store.py` (`_index_shapes`, `_row_group_rows`, `_selectivity` — the writer half) + `packages/viewer/src/data/parquetShapes.ts` and `wkbGeoArrow.ts` (the reader half). A change to the on-disk index must keep `test_e2e.run_shape_index_check` passing: it re-derives the pruning from the file and compares it against a brute-force row scan | [DESIGN.md](DESIGN.md) §14.1–14.2, [docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md) §4.4 |
| Change the shape of `app_state`, the `viewer/` sidecar, `X_csc`, or `index.json` | `backend/app/schemas/checkpoint/*.schema.json` (the JSON Schema is validated against on every write) + [docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md) in the same commit — `sds-governance/checks/check_checkpoint_schema_docs.py` fails the build otherwise | [docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md) |
| Add a render-path call the canvas makes | `packages/viewer/src/data/types.ts` (the `DataSource` interface), then **both** `frontend/src/data/apiSource.ts` and `packages/viewer/src/data/checkpointSource.ts` | [DESIGN.md](DESIGN.md) §14.2 |
| Change what the serverless viewer shows (collapsed-by-default sidebar with the analysis history only, the Plots view, PNG export) | `frontend/src/components/Sidebar.tsx` (the serverless branch), `store/sessionStore.ts` (`leftMenuOpen` default), `components/PlotGallery.tsx`, `packages/viewer/src/lib/canvasCapture.ts` | [DESIGN.md](DESIGN.md) §14.2 |
| Change the `index.json` deployment manifest or the checkpoint switcher | `frontend/src/data/checkpointIndex.ts` (format + navigation), `components/CheckpointIndexPage.tsx` (landing), `components/CheckpointPicker.tsx` (header), `backend/app/cirro.py` (`_write_viewer_index`) | [DESIGN.md](DESIGN.md) §14.3, [docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md) §8 |
| Change the embed protocol (viewer in an iframe under a Cirro dashboard) | `frontend/src/data/embedBridge.ts` (viewer side) + [docs/EMBED_PROTOCOL.md](docs/EMBED_PROTOCOL.md) in the same commit — the dashboard side in `@cirrobio/dashboard` must move together | [docs/EMBED_PROTOCOL.md](docs/EMBED_PROTOCOL.md) |
| Change what a shared view link carries | `frontend/src/lib/urlViewState.ts` (schema + diff) + `hooks/useUrlViewSync.ts` (writer); add the field's default to `packages/viewer/src/defaults.ts` if it has a constant one | below |
| Change the deck.gl canvas / rendering | `packages/viewer/src/canvas/` | [packages/viewer/README.md](packages/viewer/README.md) |
| Change the docs site's navigation, or publish a doc that isn't on it yet | `docs-site/.vitepress/config.mts` (sidebar + `srcExclude`) | below |
| Change the docs site's live demos | `docs-site/demo/*.md` + `.vitepress/theme/components/ViewerEmbed.vue`; regenerate data with `scripts/prepare_demo_checkpoints.py` | below |
| Give the canvas something new from the app (store state, an action, a way to persist) | `packages/viewer/src/canvas/canvas-host.tsx` (the `CanvasHost` contract), then `frontend/src/components/StudioCanvasHost.tsx` (the app's implementation of it) — the canvas never reaches for the store or `api.ts` itself | below |
| Change an in-canvas settings panel, or what the canvas hands one | `frontend/src/components/canvas/CanvasControls.tsx` / `EmbeddingControls.tsx` (Tailwind app UI), and `SpatialCanvasControls` / `EmbeddingCanvasControls` in `packages/viewer/src/canvas/` for the slot payload | below |
| Publish or version the canvas library | `packages/viewer/package.json` + [packages/viewer/README.md](packages/viewer/README.md) ("Releasing") | — |
| Change how a display setting is persisted (the debounced PUT, the edit gate, the refetch flush) | `frontend/src/hooks/useDisplayPersistence.ts` | below |
| Retune the palette, theme tokens, fonts, or the Cirro mark | `frontend/src/index.css` (tokens) + `frontend/tailwind.config.js` (names) + `packages/viewer/src/canvas/overlayStyles.ts` (the library overlays' fallbacks) + `frontend/src/components/CirroMark.tsx` / `public/favicon.svg` (logo) | [frontend/README.md](frontend/README.md) |
| Change the canvas minimap (overview inset) | `packages/viewer/src/canvas/Minimap.tsx` (overlay + navigation) + `SpatialCanvas.tsx` (extent/thumbnail wiring) + `backend/app/snapshots.py` `_draw_minimap` (figure inset) | [DESIGN.md](DESIGN.md) §9.11 |
| Change how the browser reads raw image data (client-side Viv compositing) | `backend/app/routers/imaging.py` raster route + `/image/{element}/info` fields; `rasters.py` `raster_stores` map | [docs/CONTRACT.md](docs/CONTRACT.md) |
| Change the parameter-form UI | `frontend/src/components/forms/` (`FunctionFields` renders the widgets incl. the `FsPicker` filesystem picker; `FunctionForm` adds the submit footer; the New Session dialog reuses `FunctionFields` as the reader's input form) | — |
| Change how a reader param is classified as a folder/file/value input | `backend/app/registry/reader_paths.py` (`path_kind` + the absolute/relative path sets, shared with `sessions/manager.py` validation) | [docs/CONTRACT.md](docs/CONTRACT.md) |
| Change how a snapshot figure renders or what it embeds | `backend/app/snapshots.py` (render + metadata) + `frontend/src/components/SnapshotExportModal.tsx` (framing/output) + `frontend/src/components/SnapshotBrowser.tsx` (gallery) | [DESIGN.md](DESIGN.md) §14 |
| Change Cirro upload | `backend/app/cirro.py` (client + bundle + `UploadQueue`) + `backend/app/routers/cirro.py` (routes) + `frontend/src/components/CirroUploadDialog.tsx` | [DESIGN.md](DESIGN.md) §15 |
| Change Cirro login (device code, credential scoping, expiry) | `backend/app/cirro.py` (`CredentialStore`, `start_login`) + `backend/app/routers/cirro.py` (`/api/cirro/auth`) + `frontend/src/components/CirroConnectDialog.tsx` + the token helpers in `frontend/src/api.ts` | [DESIGN.md](DESIGN.md) §15 |

### The canvas host seam

`packages/viewer/` is a standalone package: it renders from its `display` prop, the
`DataSource` in context, and one host object obtained from `useCanvasHost()`. Nothing
under `packages/viewer/src` imports `store/sessionStore`, `api.ts` or anything else
from `frontend/`, and it ships no stylesheet — so the same canvases serve the Studio
app (live, editable) and a Cirro dashboard tile (checkpoint, read-only) that has none
of the app's CSS in the page.

Two things it deliberately does *not* own:

- **The in-canvas settings panel.** `CanvasControls` / `EmbeddingControls` are
  Tailwind-styled app UI and stay in `frontend/`. Both canvases take an optional
  `controls` slot that hands a panel the canvas-internal state it needs (the resolved
  channel list, the live camera, the legend's categorical levels); the app passes one
  in through `components/canvas/StudioSpatialCanvas.tsx` /
  `StudioEmbeddingCanvas.tsx`, and a dashboard passes nothing and gets a bare canvas.
- **Whether the camera follows the display.** `followDisplayViewport` is off by
  default — a live session must not let another viewer's display PUT yank this one's
  camera. The app turns it on in embed mode; a dashboard tile that owns the viewport
  turns it on always.

`canvas-host.tsx` defines that contract: the session fields and data versions the
canvases enumerate, the theme, the edit gate, the isolated category / hidden cells, and
`onDisplayChange` + `currentSpec` for display edits — the host decides what persisting
one means. Region drawing, shape annotations and snapshot export are *optional* groups;
a host that omits one turns that feature off, affordances included, rather than
presenting a control that does nothing.

`frontend/src/components/StudioCanvasHost.tsx` is the app's implementation and the only
place the store and the canvas meet: it reads the store, `useEditGate()` and
`hooks/useDisplayPersistence.ts` (the optimistic store write + the 500 ms debounced
`PUT /displays/{id}`, its flusher, and the `canEdit` gate) and memoizes them into one
host object. Adding a store value or an action to the canvas means adding it to the
contract and to that adapter — never an import from the canvas back into the app.

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

### Where a save writes, and what the file calls itself

`POST /api/sessions/{id}/save` takes three destination fields, all validated at the
route boundary (`main._validated_destination` / `_validated_name`) so a bad one is a 400
rather than a job that fails minutes into a multi-GB write:

- `folder` — a directory under `DATA_DIR`, created by the writer if it doesn't exist
  (`store._zip_from_dir` / `_save_zip` both `mkdir(parents=True)` before staging beside
  the destination).
- `prefix` — the filename stem `-<content hash>` is appended to, defaulting to the
  session's current name. `deps.default_save_path(sess, folder, prefix)` is the single
  seam that composes both; the points-transform route and the MCP `save_checkpoint` tool
  call it with neither and so keep the flat-in-`DATA_DIR` default.
- `name` — the session name. `Session.rename` (run on the worker as the save job's
  first step) sets it and records it in `app_state["name"]`, so it survives into the file
  and `Session._run_load` adopts it back in place of the filename-derived one. That is
  what lets the file's name and the session's name diverge at all;
  `useCheckpointSession.ts` prefers it the same way in serverless mode.

`path` remains the verbatim escape hatch — honored exactly, no hash suffix — and cannot
be combined with `folder`/`prefix`.

### Selective checkpoint saves

`POST /api/sessions/{id}/save` also takes an optional `include` (facet -> element names, see
[docs/CONTRACT.md](docs/CONTRACT.md)) so a copy can be written without a multi-gigabyte
raster, and an optional `levels` (image name -> finest pyramid level) so an image can be
written at reduced resolution instead of being dropped outright.
`SaveCheckpointDialog.tsx` opens on every save with everything ticked and every image at
full resolution, and sends `include`/`levels` **only** when something was unticked or
coarsened — an untouched selection is byte-for-byte the old save.

The per-element size the dialog shows comes from `store.element_size_mb` and, for images,
its per-level counterpart `store.image_levels`, which the `?sizes=1` inventory carries.
Both read the real compressed bytes when the element sits in a store on disk and fall
back to a shape/dtype estimate otherwise; the level sizes sum to the element size, so the
dialog can subtract dropped levels from its running total.

Filtering happens in `store.select_elements`, a shallow `SpatialData` view sharing the
live object's element objects (same dask arrays, same AnnData), so it costs nothing and
cannot mutate the session. A `levels` entry additionally swaps in `store.trim_pyramid`'s
DataTree over the surviving levels — also shared, not copied. Because every level carries
its own transform to the global coordinate system, the level promoted to `scale0` keeps
the downscale its old position implied, so a trimmed image still lands where it did.
`store.cap_image_levels` (`save_spatialdata(max_image_mb=…)`, the CLI's
`--lowres-max-image-mb` and the Nextflow low-res copy) is the batch half of the same
trim — it picks the levels from a byte budget instead of per image, then lands in
`trim_pyramid` too, so a change to how a pyramid is rebuilt touches one place.
Three consequences worth knowing before changing it:

- The view has **no backing path**, so `can_update_incrementally` is false for it. That
  is deliberate — `update_checkpoint` reuses the on-disk rasters wholesale and would put
  back exactly what was dropped — and `Session._write_checkpoint` also short-circuits
  above the incremental branch so the guarantee doesn't rest on that alone.
- The sidecar, the CSC mirrors and consolidated metadata all derive from whatever object
  `_write_browser_reader_support` is handed, so a filtered write produces a
  self-consistent `viewer/` group with no extra work.
- A filtered or level-trimmed write is an **export**: `_save_and_finish` skips adopting
  it, so `store_path`, `saved` and the dirty sets are untouched. The session still holds
  elements — and pyramid levels — the file doesn't.

`appstate.prune_to_elements` clears `image_layer` / `shapes_layer` on any display naming
a dropped element (both are nullable in `app_state.schema.json`), so the file still opens
cleanly instead of rendering a missing layer. Nothing records *which* elements were
dropped — deliberately, since that would mean a `viewer/` sidecar schema change and drag
[docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md) in under rule R17 for no gain.

`store.element_size_mb` backs the dialog's per-element figures (`GET
/api/sessions/{id}/elements?sizes=1`, off by default — it stats the store and the
inspector has no use for it). It prefers real compressed bytes off disk, from the
object's backing store or a rebuilt raster's own store in `Session.raster_stores`, and
falls back to a shape/dtype/nnz estimate scaled by `_COMPRESSION` — the documented
inverse of `estimate_resident_mb`'s `DECOMP`, with a separate factor for labels, which
compress far harder than intensity data. The fallback is within roughly 2x and worse for
fluorescence than H&E; `None` ("unknown", a dask points frame whose length would cost a
full scan) makes the dialog's total a lower bound rather than an estimate.

### Rendered plot figures

A drawn plot's SVG/PDF/PNG live in `Session.plot_figures` while the session runs, and
travel in the checkpoint under `viewer/figures/<plot_id>/<fmt>` (one uint8 array per
format; see [docs/CHECKPOINT_FORMAT.md](docs/CHECKPOINT_FORMAT.md) §4.3). Three seams to
know:

- **The session, not the store, decides what gets written.** `figures_to_persist(keep)`
  collects the bytes of every `drawn` plot — from memory, or read back from the store the
  session was loaded from — and `_write_figures` makes the group match that set exactly,
  deleting anything else. So the save dialog's per-plot toggles (`figures` in the save
  body) need no logic in the writer. On the incremental save path the store being
  rewritten is the same one the session reads its figures through, so
  `_hold_dropped_figures` pulls anything about to be pruned into memory first — dropping
  a figure changes the file, never the open session.
- **`figure_index()` reports only `drawn` plots**, merging in-memory bytes over the
  store's `figures` attr. That is what makes a stale figure unreachable the moment its
  plot is invalidated, and it is the single source for `SessionState.figures`, the save
  dialog's sizes, and the MCP `figure_available` flag. Sizes come from the sidecar attr
  rather than the arrays so the state route can report the whole index in one small read
  on every poll.
- **The UI reads figures through the `DataSource`** (`getPlotFigure`), so `PlotGallery`,
  `FigureLightbox`, `PlotDetail` and the exports are the same components against a live
  session and a checkpoint. `frontend/src/lib/figures.ts` holds the shared selectors
  (which format to display, which plots have a figure, byte totals) and `hooks/useFigure.ts`
  turns one into an object URL, revoked when the plot, format or component changes.

## Local dev environment

```bash
./run.sh          # data/ is the data folder
./run.sh --test   # test-data/ is the data folder
```

`run.sh` launches the backend (`uvicorn`, no `--reload` — see below) and the
frontend (`npm run dev`; Vite proxies `/api` to :8000) together.
Stop with Ctrl-C or, from another shell, `./stop.sh` (it reads `.run.pids` and
kills each process group).

The repo is one npm workspace (`frontend` + `packages/viewer`), so dependencies
install once at the root into `./node_modules` — there is no `frontend/node_modules`,
and `run.sh` runs `npm install` at the root when it is missing. Vite aliases
`@cirrobio/spatial-viewer` to `packages/viewer/src`, so the dev server hot-reloads
canvas edits without a library build; `npm run build` at the root builds the library
(`dist/`, ESM + CJS + types) and then the app.

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

### Embed mode (hosting the serverless viewer in an iframe)

`?checkpoint=<url>&embed=1` puts the serverless viewer in **embed mode** for a
hosting page — the Cirro dashboard's `spatialdata` node — that owns the display
settings over `postMessage` (contract: [docs/EMBED_PROTOCOL.md](docs/EMBED_PROTOCOL.md),
v1). In embed mode the app renders only the canvas area: no header, sidebar,
settings panel, view switcher, or checkpoint picker, and no in-canvas controls
(`CanvasControls` / `EmbeddingControls`) either — the host's inspector is the
single place display settings are changed. The canvas itself stays interactive,
so camera moves still stream out to the parent as `display-changed`.

Hiding the controls is host policy, not canvas logic: the canvas has no notion of
embedding. `StudioSpatialCanvas` / `StudioEmbeddingCanvas` simply pass no `controls`
slot in embed mode, and set `followDisplayViewport` so a viewport the parent applies
reaches the camera.

The viewer side lives in `frontend/src/data/embedBridge.ts` (`useEmbedBridge`,
wired in `App.tsx`; the `embed=1` gate is `isEmbedMode` in
`data/checkpointIndex.ts`, read once in `App.tsx` and passed down). It posts `ready` (checkpoint inventory: displays,
obs columns, images + channels, obsm keys) once the checkpoint session mounts,
debounced `display-changed` events (500 ms, echo-guarded) when the active
display's encoding or viewport changes, `search-vars-result` answers via the
checkpoint `DataSource`, and `error` when the checkpoint fails to open; it
applies the parent's `apply-display` / `select-display` to the store exactly as
local edits would land. Both canvases additionally follow an externally applied
viewport into the camera when `followDisplayViewport` is set (the
`appliedEmbedViewport` effects in `packages/viewer/src/canvas/SpatialCanvas.tsx` /
`EmbeddingCanvas.tsx`).

Only checkpoints written by the current code carry the `viewer/` sidecar, and the
viewer **requires** it: a Zarr v3 store has no child index, so without the sidecar (and
the consolidated metadata written with it) the reader can't even name the table. An
older checkpoint is rejected on open with a message saying to re-save it, rather than
opening to an empty session. Re-saving through the app is the fix.

Client-side (Viv) image compositing is the sole canvas image path, **on by default**
(disable with the `sds:disableClientCompositing` localStorage key, which turns the canvas
image off — there is no server-composited fallback); `SDS_CLIENT_IMAGE_MAX_CHANNELS`
(default `6`) caps how many channels the browser composites in one shader pass.
`packages/viewer/src/canvas/useVivImageLayer.ts` builds a single Viv `MultiscaleImageLayer` whose deck.gl `TileLayer`
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

### Shareable view links

In the serverless viewer, whatever differs from the checkpoint's own saved encodings is
mirrored into a `view` query parameter, so a tuned view can be handed to someone else as
a URL (DESIGN §14.2). `lib/urlViewState.ts` owns the schema and the diff;
`hooks/useUrlViewSync.ts` writes it.

- **The baseline is the checkpoint, not a constants table.** The recipient opens the
  same `?checkpoint=`, so both sides read an identical `app_state` and baseline + delta
  reproduces the view exactly. Diffing against static defaults could not work:
  `color_by`, `image_layer` and `show_image` all default off the data.
- **Defaults still matter, for normalization.** Both sides run through
  `SPATIAL_ENCODING_DEFAULTS` / `EMBEDDING_ENCODING_DEFAULTS`
  (`packages/viewer/src/defaults.ts`) before comparing, so an absent field and its
  default compare equal — otherwise toggling a setting off and on again would emit it.
  A new encoding field with a constant default belongs in that table.
- **The backend has to agree, and a test enforces it.** The server-side figure renderer
  (`backend/app/snapshots.py`) applies the same fallbacks when a checkpoint predates a
  field, so it reads them from `appstate.POINT_ENCODING_DEFAULTS` /
  `DISPLAY_ENCODING_DEFAULTS` via `encoding_default(enc, field)` — the one table
  `manager.auto_displays` writes from too. `test_e2e.run_encoding_defaults_parity` parses
  `defaults.ts` and asserts the two agree, because they had already drifted (the renderer
  used `point_size` 6 / `opacity` 1.0 against the canvas's 4 / 0.85, so an exported figure
  of an older checkpoint did not match the canvas). Add a shared default to both tables.
- **Nested maps replace wholesale.** `channels` and `category_colors` are two-level
  records; a per-key merge would need tombstones to express "the user removed this
  override".
- **`ui` carries what the recipient is looking at**, not just how it is styled: `view`
  (which main view), `menu` (sidebar), and `plot` — the `plots[].id` open fullscreen, so a
  link can point at one figure. `ui.view` omits `tables`, which needs a backend. The store
  seeds `mainView`, `leftMenuOpen` and `expandedPlotId` from `initialUiOverlay()` before
  the first render, since all three change what mounts; `FigureLightbox` therefore has to
  wait for a session before deciding a named plot doesn't exist.
- **One opaque parameter**, base64url JSON, not a parameter per setting — those two maps
  do not survive being spread across query parameters. Unknown keys are ignored, so a
  link from a newer build degrades to a partial view; an unreadable one falls back to
  the saved view with a notice.
- **The writer subscribes to the store**, not to `useDisplayPersistence` — that hook
  returns early on `!canEdit`, which is exactly the serverless case, so its debounce
  never arms. The URL is write-only after mount (decoded once, `replaceState` only), so
  there is no feedback loop and deliberately no `popstate` listener.
- **Off in embed mode and in the backed app.** Under a dashboard host the parent owns
  display state over postMessage and a URL writer would race `apply-display`; in the
  backed app the encoding is server-persisted, multi-user, and already shareable by
  session id.
- **Camera restore** reuses the library's `followDisplayViewport` prop, which embed mode
  already used. It is threaded as its own `restoreViewport` prop rather than reusing
  `embedded`, since that one also hides the in-canvas controls — a shared link restores
  the camera *and* keeps the controls.

Tests: `src/lib/urlViewState.test.ts` (vitest, `npm run test -w spatial-data-studio-frontend`)
covers the encoder. That one vitest run covers both workspaces — `frontend/vite.config.ts`
includes `../packages/viewer/src/**/*.test.ts`, since the canvas library has no runner of
its own. Also `e2e/serverless-share.spec.ts` covers the wiring by sharing a link
between two browser contexts. The e2e drives the camera through the zoom buttons —
`onZoom` writes the viewport directly, bypassing deck's controller, which synthetic drag
and wheel events never reach.

## Documentation site

`docs-site/` is a VitePress site published to GitHub Pages by
[`.github/workflows/docs.yml`](.github/workflows/docs.yml). It is a third npm workspace,
so the one root `npm ci` installs it:

```bash
npm run docs:dev      # local, hot-reloading
npm run docs:build    # production build + dead-link check
```

**It publishes the repo's markdown in place.** `srcDir` is the repo root, so the file
tree *is* the route tree (`DEVELOPMENT.md` → `/DEVELOPMENT`, `docs/CONTRACT.md` →
`/docs/CONTRACT`) and the relative links these docs already use between each other keep
working. Nothing is copied, so nothing can drift — which is the whole point, and why
CLAUDE.md forbids forking any of it into `docs-site/`. Two consequences:

- `srcExclude` in `.vitepress/config.mts` has to stay tight, or every stray markdown
  file in the repo becomes a page. Agent instructions (`CLAUDE.md`, `AGENTS.md`,
  `sds-governance/skills/`, `backend/app/mcp/guides/`) are excluded deliberately — they
  are written for tools, not readers.
- The build **fails on a dead link**, which is what keeps the cross-doc links honest.
  `ignoreDeadLinks` carries only two kinds of exemption: `/viewer/`, which the deploy
  job assembles rather than VitePress rendering it, and links to the excluded agent
  files.

**The live demos** are the only new prose (`docs-site/demo/`). They embed the real
serverless viewer through `<ViewerEmbed>`
(`.vitepress/theme/components/ViewerEmbed.vue`), registered globally by the theme. It is
an `<iframe>` over the built SPA, not the `@cirrobio/spatial-viewer` library: this site
is Vue and the library is React, the library ships no control panel (controls stay
app-side behind a render-prop slot, so a page built on it would have nothing to click),
and it needs a `CanvasHost` adapter per host. The iframe also keeps each demo's WebGL
context disposable, and — because the SPA and the `.zarr.zip` files come off the same
origin — needs no CORS for the reader's range requests. Nothing loads until the reader
clicks: the SPA bundle is ~4 MB, so three demos on a page would otherwise cost 12 MB up
front. Pass `chrome="minimal"` to add `embed=1` (no header, sidebar or in-canvas
controls) when a page wants the canvas alone.

**The demo checkpoints are committed** under `docs-site/viewer-data/` (~5 MB), so the
Pages job never downloads or rebuilds data. Regenerate them with

```bash
python scripts/prepare_demo_checkpoints.py
```

which builds a fully synthetic multichannel section (no downloads, no fixtures) plus the
Xenium TMA grid when `test-data/xenium_tma.zarr` exists, writes each through the app's
own session machinery so it carries default displays and a current `viewer/` sidecar,
and rewrites `index.json`. Re-run and commit whenever the checkpoint format moves — the
reader rejects a stale `VIEWER_SIDECAR_VERSION`.

**Deploying** needs one manual step, once: **Settings → Pages → Source = GitHub
Actions**. The workflow builds the SPA and the site, then assembles them so
`/viewer/` is itself a valid standalone deployment (DESIGN §14.3) — `index.html` +
`assets/` + `index.json` + the `.zarr.zip` files — which is what makes it browsable as a
collection as well as embeddable per page. Pull requests build but do not publish.

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
  cell-segmentation `/shapes/{element}/geoarrow` polygons on `xenium.zarr` (including
  `run_shape_index_check`: the saved checkpoint's boundary GeoParquet is spatially
  queryable — covering column present, footer and row groups bounded, row-group pruning
  a superset of a brute-force row scan over 200 random windows, selectivity within
  2.5x of ideal and better than an unsorted copy, the `cell_index` mirror aligned with
  the file's Hilbert-sorted row order and agreeing with `/geoarrow`, and re-indexing a
  no-op), viewer
  presence + the per-session edit lock (auto-lock on attach, 423 for everyone else,
  release → take, and the heartbeat timeout freeing a lock — `run_session_lock_flow`),
  the MCP assistant surface over the real `/api/mcp` transport (`run_mcp_flow`:
  initialize/tools, reader-backed create_session, lock takeover etiquette,
  compute+plot+`view_plot` PNG, and the vision coordinate contract — the
  `view_display` pixel→world affine is proven by mapping a pixel rectangle to world
  polygons whose `inspect_region`/`annotate_region` membership equals an independent
  numpy count, plus embedding-space selection, shape annotations, save, figure
  export, and a subset that evicts the parent), a lasso subset cropping the drawn
  region on stores whose world space is not one of their coordinate systems
  (`run_subset_coordinate_space_flow` synthesizes a Space Ranger `outs` tree and reads
  it with the real `spatialdata_io.visium` reader for the multi-system case;
  `run_xenium_subset_space_flow` covers micron spots against a pixel 'global'), the
  client-compositing raster route + `/info` manifest (raw zarr served with Range
  206) on `xenium.zarr`, an image tile keeping its signal after a reshaping compute
  (filter_cells) — i.e. the per-session raster store isn't deleted while the
  adopted object still references it — and rendering a snapshot figure end to end
  (preview, PDF+PNG render with the minimap inset, gallery list, download, embedded
  metadata, delete — `run_snapshot_flow`). The six Xenium-backed flows (zarr-import,
  custom methods, segmentation, raster, raster-survives-reshape, xenium subset-space)
  skip with a `[skip]` line when their fixture is absent, so CI runs only the
  Visium-backed subset; regenerate the Xenium fixtures locally via
  `scripts/prepare_xenium_*.py` to exercise them.
- `cd backend && python test_cli.py` — offline CLI round trip: loads
  `visium_hne.zarr`, runs a compute + plot recipe headlessly, and asserts the output
  `.zarr.zip` and `plots/…/figure.{svg,pdf}` are written and reload with history and the
  requested display settings intact. A second pass over `xenium.zarr` (whose `obsm` holds
  only `spatial`) runs an embedding recipe and asserts the checkpoint comes back with the
  embedding canvas the read could not have built, and no duplicate spatial one; it prints
  a `[skip]` line when that fixture is absent.
- `cd backend && PYTHONPATH=. python test_compression.py` — dataset-free unit test
  for `SelectiveGZipMiddleware`: which content types compress, round-trip/passthrough
  correctness, and the regression guard that gzip runs off the event loop (a
  concurrent request is not stalled for the whole compress on the single worker).
- `nextflow lint nextflow/` — Nextflow's own linter over every `.nf` and
  `nextflow.config` in the repo. Required to be clean (see `CLAUDE.md`): it catches what
  the legacy parser silently accepts but the language spec does not — top-level variable
  assignments, `while`, `switch`, `continue`, closures called as local functions.
  `-format` reformats the files it can parse.
- `python nextflow/tests/check_catalog.py` — the workflow's declarative half: validates
  `data_types.json` against its schema, checks every recipe it names exists, verifies each
  common parameter's `applies_to` really is the set of types whose recipes declare it,
  checks each type's display default colours by a parameter that applies to it,
  checks the params agree across `nextflow.config` and `nextflow_schema.json`, and runs
  discovery over a synthetic tree of every catalogued type.
- `python nextflow/tests/check_containers.py` — asserts every `*_container` image named
  in `nextflow.config` provides `ps`. Nextflow runs `nxf_trace` inside the container
  under `-with-trace`/`-with-report` and **exits 1** when `ps` is absent, so an image
  without procps fails every task rather than just losing resource metrics. Not in CI —
  it has to pull the images (~2.4 GB) to inspect them; run it when changing an image.
  Skips cleanly when Docker is unavailable.
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
  compute function end-to-end, browse the result, and walk the guided tour twice — once
  with no session open (the state the first-visit tour fires in) and once with a dataset
  loaded, since half the tour's targets only exist in one of the two. The
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
| `--recipe` | path to a recipe JSON file, or a bundled recipe name; repeat to run several recipes back to back in one session |
| `--recipe-params` | JSON object of recipe-parameter overrides (fills the recipe's `$param` refs) |
| `--output` | output directory (created if absent) |
| `--reader-params` | JSON object of extra kwargs for the reader (reader mode) |
| `--name` | base name for the output checkpoint, written as `<name>-<content hash>.sdata.zarr.zip` (default: from `--input`) |
| `--session-name` | what the checkpoint records as its own name (`app_state["name"]`), shown when it is reopened however the file is named; unset leaves a loaded store's name alone |
| `--lowres-max-image-mb` | also write a second checkpoint with as many of each image's finest pyramid levels dropped as it takes to fit that image budget (`store.cap_image_levels`) |
| `--lowres-name` | base name for that copy (default: `<name>.lowres`) |
| `--display-color-by` | field path (`obs:cellular_neighborhood`, `X:GENE`) every saved display is coloured by, applied after the recipes run |
| `--display-render-mode` | `points` or `points+shapes` for the saved spatial canvas |

The output folder holds `<name>-<content hash>.sdata.zarr.zip` (the full SpatialData +
app state, reloadable in the app, with each drawn plot's figure inside it) and
`plots/<NN>_<namespace>.<function>/figure.{svg,pdf}` per plot step as loose files. These
are auto-named checkpoints, so the filename carries a hash of its own contents the way
the app's saves do (`docs/CHECKPOINT_FORMAT.md` §7) — the exact name is only known once
the bytes are, and the CLI prints each path it wrote.
Repeating `--recipe` runs the recipes in order in the same session — one load, one
save — so a longer analysis composes the bundled recipes instead of restating their
steps in a new file. `--recipe-params` is shared by all of them: each recipe fills only
the `$param` names it declares, and ignores the rest.

The displays the checkpoint opens on are built when the object is first read, which is
before any recipe has run: they colour by whatever categorical column the reader happened
to write, and a reader-mode session has no embedding at all, so it gets no embedding
canvas. Both are fixed after the steps finish — `manager.auto_displays` runs again to add
whatever display is still missing (it only ever adds, so the spatial canvas is not
duplicated), then `--display-color-by` repoints every display (failing with the obs
columns listed if the field is not there) and `--display-render-mode` sets how the spatial
canvas draws cells. This matters most for the serverless viewer: it has no session to
POST a display to, so `EmbeddingEmptyState` authors one browser-locally there — a
fallback for checkpoints written before the CLI filled the view in, not a substitute for
writing it, since a local display is gone on reload.

A step that cannot complete does not stop the run. It is kept as a `failed` history
entry with its log — the same model the live app uses for a queued function that fails —
the log is printed and saved into the output checkpoint, and the next step runs. The exit
status is 0 for any run whose input loaded (the failure count is reported on the last
lines of stdout); only a failed read/load is fatal. Reopening the output in the app shows
each failed step and its log.

**Nextflow.** One workflow, `nextflow/main.nf`, wrapping the CLI in a container that
installs the pinned Python deps at runtime with `uv`, so there is no image to build.
Point it at a folder; it finds the spatial datasets inside (all eight readers), loads
each with the right one, runs that data type's recipes, and publishes the checkpoints in
a tree mirroring where they were found, plus a MultiQC report and a serverless viewer
(§14.3). It does not build the SPA: `--viewer_dist` defaults to the `viewer-dist.tar.gz`
that [`.github/workflows/release.yml`](.github/workflows/release.yml) attaches to each
`v*` tag, so a run works from a fresh clone (where `frontend/dist` is gitignored and
absent) as well as from a working tree. Point it at `frontend/dist` to publish a local
`npm ci && npm run build` instead.

```bash
nextflow run nextflow/main.nf -profile test,docker
```

Everything data-type-specific is in `nextflow/data_types.json`; the workflow itself has
no per-format branch. See [`nextflow/README.md`](nextflow/README.md) for the parameters
and [`nextflow/nextflow_schema.json`](nextflow/nextflow_schema.json) for their schema.

**Release assets.** Each `v*` tag carries two build outputs, neither of which is in the
repository: `viewer-dist.tar.gz` (the SPA, above) and
`cirrobio-spatial-viewer-<version>.tgz` — `packages/viewer` packed by `npm pack`, which
is how Cirro-components depends on the canvas library. That consumer used to link a
path into a checkout beside this one, so it only installed on a machine laid out that
way; a tagged tarball pins it by version instead. The library's version is stamped from
the tag at pack time, so `v0.1.1` attaches `cirrobio-spatial-viewer-0.1.1.tgz` — the
in-repo `version` field is a placeholder, not the thing consumers resolve. Neither asset
exists on a tag released before its step did; `workflow_dispatch` re-runs the job against
an existing tag to attach them.

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

**Read the skips, not just the banner.** The gate prints `PASS` when nothing FAILED,
which is not the same as everything being enforced: the checks run under `pytest -rs`
so every skipped rule is listed with its reason, and a skipped rule is unenforced.
Two skip by design until `config.SYNTH_FIXTURE` is wired to a synthetic-SpatialData
builder — R5's contract smoke test (running every registered function and asserting the
`CallResult` envelope) and R6/R7 (append-only history). Pass the backend interpreter to
enforce the import-dependent rules rather than skipping them:

```bash
make -C sds-governance check PYTHON=../.venv-introspect/bin/python
```

The rules that do run assert behavior, not source text: R5's static half reads the
envelope fields off `CallResult` itself, R13 exercises `snapshots._content_hash`, and
R10 walks `Session._run_call`'s AST for a real `self.lock.writing()` block. Keep new
checks in that shape — an `assert "<token>" in source` passes on any file that merely
mentions the token, including in a comment.
