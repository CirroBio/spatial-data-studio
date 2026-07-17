# Spatial Data Studio

Interactive analysis and visualization for spatial omics data. A Python backend
holds a [`SpatialData`](https://spatialdata.scverse.org/) object in memory and
exposes [`squidpy`](https://squidpy.readthedocs.io/) as a runtime-introspected
function registry; a React/TypeScript frontend renders cell-scale data in WebGL
(deck.gl) and drives all interaction. See [DESIGN.md](DESIGN.md) for the full
design specification and [docs/CONTRACT.md](docs/CONTRACT.md) for the API.

> **Maintenance rule:** this README is the source of truth for what the app does
> and how to run it. **Keep it up to date** — any change that adds/removes a
> feature, endpoint, run command, or layout element updates this README in the
> same change. See [CLAUDE.md](CLAUDE.md).
>
> **Governance:** invariants are enforced by `sds-governance/` (`make check`); read
> [`sds-governance/AGENTS.md`](sds-governance/AGENTS.md) before changing the catalog.

## Foundational principle: zero hardcoded library functions

No part of the app names a specific `squidpy` function. The available operations
are discovered by introspecting the `squidpy` package at startup; forms are
generated from function signatures; calls are stored and executed as declarative
descriptors. Upgrading `squidpy` exposes new functions with no app code changes.
The only library-specific knowledge is the **Parameter Term Dictionary**
(`backend/app/registry/terms.yaml` + `dictionary.py`): a startup-loaded, editable
map keyed by *parameter term* (never by function) that supplies widgets, data
bindings, value pins, and output-key roles. `GET /api/functions/coverage` reports
which params matched a term, ranked by reuse.

Operations are modeled by an abstract **`Function`** (`backend/app/registry/base.py`):
identity, a generated form descriptor (JSON Schema-of-record + ui hints), an effect class,
and an `execute` contract returning the **contract envelope** `{status, logs,
structural_diff, figure_bytes, new_object, result_value, manifest_before/after, error}`
with a `keep_failures` flag (`True` for every frontend call, so a failed call stays in
history for inspection). **`LibraryFunction`** (`library_fn.py`) is the one reflection-built executor for all
libraries — a `library` field drives the import, so squidpy/scanpy/spatialdata-io readers
run through one path; squidpy is still never named in code. **Custom functions**
(`registry/custom/`) are hand-written `Function` subclasses. All three flow through the
same picker → form → queue → history machinery.

Every function also carries **provenance** shown in the picker — a `citation` and a
`documentation` link (both required for all functions). Library functions inherit
both from `registry/library_meta.yaml` (one entry per library: the library's own
citation + a doc-URL template that resolves to each function's docs page), so a new
library is one meta entry, not per-function edits. Custom functions declare their own
citation (the paper/post/tutorial the method came from, or that it's original here)
and point their documentation at a per-method section in
[`registry/custom/README.md`](backend/app/registry/custom/README.md).

## Features

- **Introspected operations** — every `squidpy` `gr`/`im`/`tl`/`read`/`pl` function
  as a generated form; `copy`/`inplace` pinned, plot render-params managed.
- **Expanded catalog** (`registry/library_catalog.yaml`) — scanpy `pp`/`tl`/`get`
  (QC, normalization, HVG, PCA, neighbors, UMAP, rank_genes_groups, …), the scanpy
  `pl.rank_genes_groups_*` marker-gene plots (dotplot/matrixplot/heatmap/stacked_violin,
  which visualize `uns['rank_genes_groups']` — the genes that differentiate each group),
  and spatialdata-io readers (xenium/visium/visium_hd/merscope/cosmx), added one short
  manifest entry each; `get.*` use an `extract` effect class. (scanpy's `sc.tl.leiden`/
  `sc.tl.louvain` are omitted — their backends are GPL; use `custom.leiden`, below.)
- **Custom functions** (non-squidpy, `namespace: custom`) — *Leiden clustering*
  (graspologic, MIT), *Identify Regions (Leiden)*,
  *Edit Annotations* (rename/merge a categorical obs column's values), *Identify TMAs*
  (automatic tissue-microarray core detection), *Region composition* (cell-type-by-region
  crosstab + chi-square test, then a stacked-bar plot of the proportions in one step —
  pandas/scipy/matplotlib only), and *Annotate Cells (CellTypist)*
  (predict a cell-type label per cell with a pre-trained CellTypist model, writing a
  categorical `<key_added>` column plus a `<key_added>_conf` confidence column; input is
  log1p/1e4-normalized on a copy by default, and the chosen model is downloaded on first use).
- **Spatial & multi-sample analysis methods** (non-squidpy, `namespace: custom`, vendored
  unmodified under `registry/custom/_vendor/`, numpy/scipy/scikit-learn only) — eight
  compute + plot Function pairs for methods scanpy/squidpy don't provide:
  *Cellular Neighborhoods* (windowed cell-type composition clustered into recurring
  tissue niches); *Milo differential abundance* (tests which overlapping kNN
  neighborhoods in an embedding shift in cell abundance between two conditions,
  NB-GLM + spatial FDR); *LISI* (per-cell iLISI/cLISI integration diagnostic — batch
  mixing / cell-type separation in an embedding); *Proximity / avoidance test*
  (nearest-neighbor distance between cell-type pairs vs. a label-permutation null,
  distinct from squidpy's distance-binned `co_occurrence`); *Region boundary /
  infiltration distance* + *Infiltration profile* (derive a tissue region from cell-type
  labels with no hand-drawn geometry, compute each cell's signed distance to the region
  margin, then profile a target population's abundance as a function of that distance —
  the infiltration curve); *Pseudobulk DE (DESeq2)* (sums raw counts per
  sample × cell type and runs PyDESeq2 with an explicit contrast, the replicate-aware
  alternative to `rank_genes_groups` for condition comparisons — requires ≥2 pseudobulk
  samples per condition per cell type, skipped otherwise, and raw integer counts); and
  *Region feature differences (Kruskal-Wallis)* (for each cell type, ranks the genes
  whose expression differs across annotated regions with the non-parametric multi-sample
  Kruskal-Wallis H-test + BH-FDR, then a gene × region mean-expression heatmap).
- **Data manifest** (`backend/app/manifest`) — an extensible, text representation of
  session state (tables + dtypes, categoricals with counts, region sets, images/channels,
  summaries) captured before/after every call; a human-readable diff.
- **Sessions** — one in-memory `SpatialData` per session, a FIFO worker thread,
  compute/plot jobs, structural-diff–driven refresh, live RAM/CPU resource strip.
  The actual squidpy/scanpy/custom-function call runs in a subprocess
  (`backend/app/registry/kernel.py`, `SQV_COMPUTE_POOL_WORKERS`, default 2) so a
  long compute never holds the API process's GIL — unrelated requests (the
  recipe list, other sessions) stay responsive while a job runs; only the busy
  session's own reads wait, via its per-session read/write lock.
- **Startup splash** — the frontend polls `GET /api/readyz` and shows a full-screen
  splash until the backend finishes importing `squidpy` and building its function
  registry, so a slow cold start doesn't look like an app with nothing to load.
  The session list and the New Session dataset picker also show a "Loading…"
  state rather than looking empty while their first fetch is in flight.
- **Menu prewarming** (`backend/app/prewarm.py`) — a background async queue warms
  the menu lists that are otherwise paid lazily on first open, off the event loop,
  so they are ready the moment the user needs them: the saved-dataset scan
  (`GET /api/fs/datasets`, cached in `datasets.py` and invalidated on each save)
  and, when Cirro is configured, the Cirro project list. Warm tasks are
  best-effort — a failure just means the endpoint computes on demand as before.
- **deck.gl canvas** — binary Arrow scatter colored by any per-cell value over the
  tissue image; world-unit point sizing. **Cell rendering is display-only in two zoom
  regimes** (no resegmentation): zoomed out, a distance-capped nearest-cell **field** (a
  custom deck.gl impostor-cone layer — each cell a world-space disc of radius R = the
  median nearest-neighbor distance, its fragment shader writing depth so the nearest
  centroid wins each pixel); zoomed in, the **exact cell-polygon outlines** filled by cell
  color when the session has boundary polygons (fetched viewport-clipped as GeoArrow),
  else the point scatter + size slider. The switch is a zoom threshold (`log2(6/d)`,
  d = median NN distance, with ±0.5 hysteresis). A **Render mode** control
  (`auto` — field/polygons — vs `points`, the classic scatter) and a **Shape set**
  selector (which polygon element to outline) sit in the canvas controls; render mode
  persists on the display state. **Color by** first picks a slot (`obs`, `X`
  gene expression, or a `layer`) and then the column within it: obs columns from a
  dropdown, genes from a type-to-search box backed by
  `GET /api/sessions/{id}/var-names?q=&limit=` (so datasets with tens of thousands of
  genes stay responsive — matches are found server-side, prefix hits first). The chosen
  value is saved in the session display state. **Show points** and **Show image**
  checkboxes toggle each layer independently; these toggles and an isolated category are
  saved to the session and restored on reload. The camera (pan/zoom, and the embedding's
  3D orbit) is saved too — a snapshot uses it as its viewport — but loading a session
  always fits the view to the data (the spot extent, unioned with the image when shown)
  rather than restoring the last camera. Each image channel can be toggled, renamed,
  and assigned one of 8 canonical spectrum colors (the server composites channels
  by additively blending each channel's intensity tinted with its color); a togglable
  legend overlays a color swatch + label for every visible channel. A separate,
  togglable cell-color legend (bottom-right) reflects the current **Color by** — a
  viridis colorbar with the value range for numeric columns (X/layer genes and numeric
  obs), category swatches for categorical ones — with an editable title that defaults to
  the column (gene) name. A categorical column with more than 100 distinct levels (e.g.
  an object-dtype per-cell ID column) is not colored per level — points render in a
  neutral color and the legend notes the level count — to avoid an unusable palette and a
  browser-hanging legend. A spinner in the top-left signals when cells, colors, or image
  tiles are (re)loading.
- **Tiled image pyramid** — large sections (e.g. Xenium, ~34k×14k px) are drawn from
  the `SpatialData` multiscale pyramid: a coarse whole-image base plus level-of-detail
  tiles for the current viewport, so only what's on screen at the resolution it needs
  is fetched, and zooming reaches full resolution. Tiles come from
  `GET /api/sessions/{id}/image/{element}/tile/{level}/{col}/{row}?channels=` (composited
  PNGs, LRU-cached); `…/info` reports the pyramid levels, tile size, and a
  `pixel_to_world` affine. Because a table's `obsm["spatial"]` and its image can live in
  different coordinate spaces (Xenium spots are in microns; the image is in pixels), the
  server reconciles them — picking the element transform that best overlays spots onto
  the image — so points and image line up, and rotated/aligned images (e.g. an H&E) are
  placed as quadrilaterals. On ingest, each image is normalized once into a 2× pyramid
  down to a ~1024px base with tile-sized store chunks (`backend/app/rasters.py`), and
  labels are tile-chunked (single-scale), so a single tile only ever reads one small
  chunk — without this a reader's single-scale or coarsely-chunked raster would force a
  multi-GB read per tile. This adds a one-time re-tiling step (a few seconds per large
  image) when loading a raw or older dataset.
- **Editable points transform** — when the automatic reconciliation is off, **Edit
  points transform** (canvas controls) opens an editor for the points→global affine of
  the table's region element, as either scale/rotation/translation or a raw 2×3 matrix.
  Saving runs `spatialdata.transformations.set_transformation` under the write lock and
  writes the object to its checkpoint (blocking spinner while it saves), so the new
  alignment persists across sessions; the canvas re-renders the cells at the new
  coordinates. Served via `GET`/`POST /api/sessions/{id}/points-transform`.
- **Embeddings view** — a second deck.gl tab (Spatial / **Embeddings** / Tables) that
  plots any `obsm` slot (e.g. `X_umap`, `X_pca`) as an X/Y scatter instead of the
  spatial coordinates, reusing the same **Color by** mechanism and cell-color legend
  as the spatial canvas. Settings let you pick the obsm slot and, per axis, which of
  its components to plot (so `obsm:X_pca`'s 50 components aren't limited to the first
  two); a **3D** toggle adds a Z-component picker and switches to an orbit camera
  (`PointCloudLayer` under `OrbitView`), hidden when the selected slot has fewer than
  three components. In 3D a left-drag rotates the orbit camera and a right-drag traverses
  (pans) across the view; scroll zooms, and a subtle hint in the bottom-left corner spells
  this out. A session with no non-spatial `obsm` shows an empty state to run a
  dimensionality reduction first; sessions that gain one later (or predate this
  feature) create the view on demand from a setup menu that picks the obsm slot and the
  initial **Color by** value (`POST /api/sessions/{id}/displays`).
- **Data inspector** — a Spatial/Embeddings/Tables switch in the viewer's top-left
  opens a paginated browser over the `SpatialData` elements: each table's `obs`/`var`
  dataframes, `shapes` GeoDataFrames (geometry as WKT), `points`, and image
  metadata + thumbnail. Served by `GET /api/sessions/{id}/elements` (inventory)
  and `GET /api/sessions/{id}/table?path=&offset=&limit=` (JSON page).
- **Light/dark theme** — toggle in the top toolbar; colors are CSS variables
  (`rgb(var(--…))`), the choice persists in the browser (`localStorage`).
- **Guided tour** — a compass icon in the top toolbar (**Take the tour**) walks
  through the main landmarks (sessions, new session, the view switcher, the
  sidebar tabs, running an analysis, save, snapshots) with a spotlight + popover.
  It auto-starts once on first visit and remembers completion in `localStorage`.
  Steps point at elements by a stable `data-tour="…"` attribute rather than CSS
  selectors, so restyles don't break it; the tour config, the Driver.js renderer
  adapter, and the anchor registry live in `frontend/src/tours/`, and
  `npm run check:tours` fails the build if an anchor loses its element.
- **Region annotation** — draw a lasso to label cells into a region set (a
  categorical `obs` column) in place, or promote an existing categorical; region
  sets flow through every grouping picker automatically.
- **Lasso subset** — draw a region to create a child session (via
  `spatialdata.polygon_query`), evicting the parent.
- **Four-tab UI** — Compute, Plots, Annotations, Subsetting; the active
  canvas-workflow tab sets the draw mode (label vs subset). Selecting a
  compute/plot item opens its detail in a modal over the current view (canvas or
  inspector); it shows the call's parameters and an **Edit & rerun** that reopens
  the original function form pre-filled. Clicking the selected item again
  deselects it. Every submitted operation (a function, a re-run, a redraw, or a
  recipe/run-all step) appears in its list immediately with a live status badge
  (`queued` → `running` → `completed`/`drawn`) driven straight from the SSE job
  events, so a long-running or back-to-back job shows progress rather than
  appearing only once it finishes. New/Save session are icon buttons (hover for labels) in the top
  toolbar; the Save button shows a subtle dot when the session has unsaved changes
  (any compute/plot/annotation since the last save; cleared on save). A Browse
  snapshots icon button opens a dialog listing saved snapshots and previews the
  selected one inline in a read-only viewer. A snapshot is just a small JSON config
  (viewport + encoding + a baked render manifest) that points at a checkpoint; the
  viewer opens that checkpoint `.zarr.zip` directly in the browser (via zarrita.js
  over HTTP range requests) and renders the image + cells from it — no snapshot ships
  any pixels or data of its own. Saving a snapshot first writes the session to a
  content-hashed checkpoint (so the config points at bytes that won't change under
  it), then records the view. A
  session switcher next to the app name lists every currently-loaded session and
  switches the displayed one on click (non-resident sessions are shown but not
  selectable); each row has a delete control (hover to reveal) that removes the
  session. To its right the title bar reports the active session's cell count
  and the primary image's pixel dimensions. Saving blocks the whole UI behind a spinner overlay until the write
  finishes; an unobtrusive Stop button cancels it if the job is still queued
  (a save already writing to disk can't be interrupted).
- **Recipes** — curated multi-step workflows browsable from the Compute/Plots tabs
  (**Browse recipes**, with a search box filtering by name/description/step), served
  by `GET /api/recipes`, applied through `/recipe/run`. Clicking **Select** on a recipe
  opens its parameter form (the same form the function picker uses, pre-filled with the
  recipe's defaults), and that form's footer offers **Run** (queues every step
  immediately) or **Stage** (loads the steps as editable *pending* entries). A recipe
  can declare its own **parameters** — a curated handful of knobs (cluster column,
  neighbor count, filter thresholds, DE test, …) that map into the params of the
  individual steps; your choices thread through every step that references them. A pending step shows a dashed `pending` badge in the Compute/Plots list;
  opening it lets you **Edit params** (Save keeps it pending) and **Run** it on its
  own, and a **Run all pending (N)** button in the tab footer submits every staged
  step in order. Loading a recipe file (**Load recipe**) stages it the same way (its
  declared defaults applied) so its parameters can be reviewed before running.
  The gallery leads with a **guided Xenium region-analysis workflow** (run in order):
  preprocess & QC (Xenium) → Leiden cluster & top marker genes → assign cell-type
  labels (CellTypist) → neighborhood analysis (cellular neighborhoods) → cell types &
  neighborhoods by region → region gene-expression differences (Kruskal-Wallis); the
  last two use whatever region column you annotated. After that: squidpy spatial
  recipes for `visium_hne` (neighborhood enrichment, spatially variable genes by
  Moran's I / Geary's C / sepal, co-occurrence, region graph topology, Ripley's L,
  ligand-receptor interactions); scanpy recipes for raw data such as Xenium
  (preprocess → Leiden + UMAP; QC → filter → cluster; marker genes; cluster hierarchy
  + markers; t-SNE + diffusion-map embeddings; PAGA trajectory; end-to-end cluster →
  neighborhood enrichment); scanpy-tutorial reproductions (full Visium analysis &
  visualization; MERFISH clustering for imaging-based counts); and a replicate-aware
  *Pseudobulk differential expression (DESeq2)* recipe (bulk-like per-sample × cell-type
  DE between two conditions, with an MA + volcano plot). Recipes are JSON files
  under `backend/app/recipes/` discovered at startup — see "Contributing recipes"
  below. Ad-hoc export/import over history too.
- **Offline computation** (`backend/cli.py` + `nextflow/`) — run a recipe over a
  dataset headlessly, no server or browser. The CLI reads the input with any of the
  app's parsing functions (a spatialdata-io/squidpy reader named by `--parser`, e.g.
  `io.xenium`, or `zarr`/`spatialdata` to load an existing `.zarr`/`.zarr.zip`),
  applies the `--recipe` JSON's steps through the same registry/session engine the UI
  uses, and writes an `--output` folder holding the resulting SpatialData
  `<name>.zarr.zip` plus, per plot step, `plots/<NN>_<namespace>.<function>/figure.{svg,pdf}`.
  A Nextflow workflow (`nextflow/main.nf`) wraps the CLI and exposes the same
  parameters; its container installs the pinned Python deps at runtime with `uv`, so
  no custom image is built. See "Run offline" below.
- **Data vs checkpoint dirs (strict separation)** — raw inputs live under the data
  mount (`SQV_DATA_DIR`); saved sessions ("checkpoints") live under the checkpoint
  mount (`SQV_CHECKPOINT_DIR`). New Session has two modes: **Import Data** runs a
  spatialdata-io reader (`io.xenium`, …) or the **SpatialData zarr** reader
  (`io.read_zarr`, for opening an existing SpatialData store — a `.zarr` directory,
  or a `.zarr.zip` / `.zarr.tar.gz` archive) against a path under the data dir;
  **Open Checkpoint** opens a saved `.zarr`/`.zarr.zip` from the checkpoint dir. The
  dialog is a two-pane picker — source options (mode, reader, session name) on the
  left, a persistent file browser on the right: Open Checkpoint lists saved
  checkpoints (searchable), Import Data navigates the data dir (breadcrumb + up).
  Selection is restricted to a folder or a file per the chosen reader
  (spatialdata-io readers take a raw acquisition folder — opening it selects it; the
  zarr reader takes either), and an empty session name is auto-filled from the
  selected file/folder. The
  backend enforces the split (reads validated to the data dir, load/save to the
  checkpoint dir); the "Open Checkpoint" picker and the Cirro session picker both list
  only checkpoint-dir sessions.
- **Persistence** — save/load `.zarr` and `.zarr.zip` (data + app state in
  `attrs`), with full UI/region/history round-trip. A `.zarr.zip` checkpoint is a
  single-file, browser-readable store: Zarr v3 with consolidated metadata, zipped
  uncompressed (STORED) so each entry is a contiguous byte span, and the large
  image/label arrays are written with the **Zarr v3 sharding codec** (small inner
  chunks packed into a few shard objects) so a browser can range-read a viewport
  cheaply — the same file the snapshot viewer reads directly. Re-saving a session that
  was loaded from a checkpoint is **incremental**: only the elements that changed (a
  table, an edited transform, the app-state blob) are rewritten, and the already-sharded
  rasters are reused untouched — so a save after a compute doesn't re-shard the whole
  image pyramid. A fresh import, or a change that touches a raster, does the full write.
  Per-compute
  worker logs are relocated out of `attrs["app_state"]` (which is inlined into the
  store's root metadata and would otherwise be downloaded in full on open) into
  gzipped files under `logs/`, fetched lazily by the log endpoint. The `.zarr.zip`
  is served for direct browser reads (HTTP Range) at `GET /api/checkpoints/<name>`.
  Auto-managed checkpoint filenames (Save button, no explicit path) embed a hash of
  the `.zarr.zip` contents, e.g. `myfile-3fa21c9b8e4d.zarr.zip`; each save computes
  the hash fresh from the current base name, so the suffix reflects that save's
  contents instead of stacking onto the previous one. Prior checkpoint files are
  left on disk. Loading a `.zarr.zip` with a hash suffix recomputes and logs whether
  it still matches the file's contents (info if it does, warning if not) —
  informational only, never blocks the load.
- **Acknowledgements** (About icon in the header) — third-party libraries in use and
  their licenses, served by `GET /api/about/licenses` from the backend/frontend SBOMs
  (`sds-governance/sbom.json` + `sds-governance/sbom_frontend.json`).
- **Cirro upload** (`backend/app/cirro.py`, optional) — upload selected saved
  checkpoints and snapshots to [Cirro](https://cirro.bio/) as one dataset, via a
  service-account (OAuth client-credentials) identity — no interactive login. Strictly
  additive: dark unless `CIRRO_BASE_URL`, `CIRRO_CLIENT_ID`, and `CIRRO_CLIENT_SECRET`
  are all set. The dialog (opened from the toolbar, independent of any active session)
  multi-selects saved checkpoints (the same checkpoint list as "Open Checkpoint");
  the snapshot list is then populated from just those sessions — a snapshot can only
  ship with the session it sources its data from — and any of them can be included too.
  The destination folder is a creatable combobox (pick an existing folder or type a new
  path). The upload runs in the background
  via `POST /api/cirro/upload` and announces completion/failure over SSE
  (`cirro.upload.completed`/`cirro.upload.failed`). Uploads go through a bounded queue
  (small concurrency cap; extra uploads wait as pending), and the uploading/pending
  counts are broadcast (`cirro.upload.state`, also `GET /api/cirro/uploads`) — while any
  upload is in flight the toolbar button shows a non-blocking spinner and its tooltip
  reports how many are uploading and pending. The upload folder is built from
  symlinks (each selected `.zarr.zip` under `sessions/`, and each selected snapshot's
  JSON config under `snapshots/` with the checkpoint it references added to
  `sessions/`) so nothing is copied and the bundle stays self-contained. When
  snapshots are included the bundle also ships the built standalone snapshot viewer
  at its root (`index.html` + `assets/`, from `frontend/dist-viewer` — see
  `SQV_SNAPSHOT_VIEWER_DIR`) plus a `snapshots/index.json` manifest, so the uploaded
  dataset is a self-contained web page: a picker switches between the bundled
  snapshots (kept in the `?snapshot=` query param) and each renders read-only from
  the bundle's own zarr, exactly like the in-app viewer. Build it with
  `npm run build:viewer` in `frontend/` (the upload errors if it hasn't been built).
  Always
  uploaded via Cirro's generic "Files" ingest process (`custom_dataset`, accepts any
  file) — the service-account identity only needs `Create dataset`/`View dataset` on
  the target project, no `View process` permission. The dialog uses the same two-pane
  layout as New Session: the dataset options (project, dataset name, checkpoint/snapshot
  selection) on the left, and a folder browser on the right. The optional destination
  folder is picked from the chosen project's existing folders, or a new path is typed to
  create one (Cirro groups datasets into folders via a `folder://<path>` dataset tag, not
  a real API); folder paths are backend-cached per project
  (`GET /api/cirro/projects/{id}/folders`). The project list itself is cached too
  (`GET /api/cirro/projects`) and prewarmed at startup when Cirro is configured.

## Layout

```
backend/    FastAPI app
  app/registry/   base.py (abstract Function + contract envelope), library_fn.py (one reflection
                  executor for squidpy/scanpy/spatialdata-io), custom/ (non-squidpy functions),
                  library_catalog.yaml (opt-in library manifests), terms.yaml + dictionary.py
                  (Parameter Term Dictionary), introspect.py (Registry)
  app/manifest/   data manifest contributor registry + seed contributors (v3 Part 3)
  app/sessions/   manager, session (queue/worker), adapter (routes to Function.execute), regions, appstate,
                  transform (points->global affine)
  app/transport/  arrow (field -> Arrow IPC), tables (element inventory + dataframe page JSON), sse
  app/recipes/    curated analysis recipes — JSON bundle files, discovered at startup (catalog + apply)
  app/persistence/ store (.zarr / .zarr.zip)
  app/datasets.py saved-checkpoint scan for the load/upload pickers (prewarmed cache)
  app/prewarm.py  background async queue that warms slow first-open menu lists off the event loop
  app/cirro.py    Cirro dataset upload (client-credentials auth, symlink-based upload folder)
  cli.py          offline recipe runner — reuses the registry/session engine headlessly
frontend/   React + TS + Vite + Tailwind + deck.gl SPA
nextflow/   Nextflow workflow wrapping backend/cli.py (uv installs deps at runtime; no image build)
docker/     single-image build (multi-stage), nginx edge, supervisor
docs/       CONTRACT.md (REST/SSE/Arrow API)
scripts/    test-data prep: prepare_test_data.py (Visium H&E), prepare_xenium_data.py (Xenium),
            prepare_xenium_tma.py (Xenium TMA grid for the Identify TMAs detector)
sds-governance/  governance bundle: RULES.md (R1-R16) + AGENTS.md + skills/ +
                 checks/ executable gate (`make check`) + license allowlist (v3 Part 14);
                 `checks/scan_licenses_frontend.py` regenerates sbom_frontend.json (not
                 gated by `make check`, no npm forbidden-package list defined yet)
```

## Contributing recipes

Recipes are plain JSON files in `backend/app/recipes/`, discovered at startup — no
code changes needed. To contribute one, open a PR that adds a file named
`NN_short_name.json` (continue the numbering) with this shape:

```json
{
  "schema_version": 1,
  "meta": {
    "name": "Human-readable name",
    "description": "One or two sentences on what it computes and where the result lands.",
    "provenance": "The squidpy/scanpy vignette or API it is adapted from, and the target dataset."
  },
  "readme": "Longer notes shown with the recipe: assumptions, preconditions, gotchas.",
  "params": [
    { "name": "cluster_key", "schema": { "type": "string", "default": "cluster" },
      "widget": "obs_categorical", "bound_to": null, "required": true,
      "tooltip": "obs column holding the cluster/region labels" },
    { "name": "n_neighs", "schema": { "type": "integer", "default": 6 },
      "widget": "number", "bound_to": null, "required": false,
      "tooltip": "neighbors per node in the spatial graph" }
  ],
  "steps": [
    { "namespace": "gr", "function": "spatial_neighbors", "params": { "coord_type": "grid", "n_neighs": { "$param": "n_neighs" } } },
    { "namespace": "gr", "function": "nhood_enrichment", "params": { "cluster_key": { "$param": "cluster_key" }, "seed": 0 } }
  ]
}
```

Each step is `{namespace, function, params}`. Valid namespaces: squidpy `gr`, `im`,
`tl`, `pl`, `read`; scanpy `sc.pp`, `sc.tl`, `sc.get`, and `sc.pl` (limited to the
`rank_genes_groups_*` marker-gene plots — do all other plotting with squidpy `pl.*`).

**Recipe parameters (optional).** A recipe can declare a top-level `params` array of
the knobs worth exposing — the same `{name, schema, widget, bound_to, required,
tooltip}` shape a function's parameters use, with the default carried in
`schema.default`. A step param value of the form `{ "$param": "<name>" }` is replaced
by that recipe param's value before the step runs, so one knob can feed several steps
(and a produced key plus its consumers, e.g. a `custom.leiden` `key_added` and a
downstream `sc.tl.paga` `groups`). Omit `params` entirely for a fixed recipe. Expose a
curated handful (1–4) — cluster column, neighbor count, filter thresholds, DE test —
not every step param. Widgets are the ones the picker form understands: `number`,
`text`, `select` (with `schema.enum`), `obs_categorical`, `multitext`, `json`. Use
`text` for a cluster column the recipe *produces* and `obs_categorical` for one it only
*consumes*; leave `bound_to` `null` (the widget alone drives the picker). A `$param`
that resolves to `null` is dropped from the step (same as a literal `null`), so it
applies the function's own default.

Guidelines:

- Only reference functions/params that exist in the installed registry. Validate with
  the preflight endpoint (`POST /api/sessions/{id}/recipe/preflight`) or by running the
  recipe through **Browse recipes** on a matching dataset; a step that names a missing
  function or param fails at run time.
- A param set to `null` is dropped before the call, so never pass `null` for a required
  argument — omit it or give a real value.
- Avoid the process-pool code paths: `gr.spatial_autocorr`/`sepal` must not pass
  `n_perms` (joblib's process pool can't spawn inside the worker thread); prefer the
  analytic score. Plots needing `uns['spatial']` (`pl.spatial_scatter`) don't work on
  app sessions.
- State the target dataset in `provenance`/`readme` when a recipe is bound to specific
  columns or gene names (e.g. the mouse-brain `obs['cluster']` or ligand-receptor pairs).

## Run with Docker (single image, recommended)

```bash
python scripts/prepare_test_data.py     # writes test-data/visium_hne.zarr (~375 MB, needs squidpy)
docker compose up --build -d            # builds the SPA + backend into one image
open http://localhost:8080              # New Session -> /data/visium_hne.zarr
```

The compose file mounts `test-data/` read-only at `/data` and a `checkpoints`
volume at `/checkpoints`. Inside the container: `tini` → `supervisord` →
{`nginx` edge (SSE buffering off), `uvicorn --workers 1`}.

**Memory limit (two-tier).** The compose file caps the container at a hard OS
memory limit (`mem_limit: 12g`, plus `deploy.resources.limits.memory` for swarm);
exceeding it OOM-kills only this container instead of the host. Above that sits
the app's *soft* admission control, which refuses new work once usage reaches
`SQV_ADMISSION_PCT` (default 0.80) of `SQV_CONTAINER_MEM_MB` — so it trips before
the OS OOM killer fires. **These two must stay in sync**: `SQV_CONTAINER_MEM_MB`
(MiB) and the OS limit (`mem_limit` / `docker run --memory`) describe the same
budget (12288 MiB == 12g). See `docker/README.md` for the manual `docker run`
form and the full environment contract. Image tile/thumbnail compositing is
additionally bounded by `SQV_IMAGE_RENDER_CONCURRENCY` (default 2) so a zoom/pan
tile burst can't spike memory; renders requested past the admission boundary
return 503 and the canvas keeps its coarse base layer until memory frees.

**Enable Cirro upload (optional).** Set `CIRRO_BASE_URL`, `CIRRO_CLIENT_ID`, and
`CIRRO_CLIENT_SECRET` in `.env` (a service-account/client-credentials identity — no
interactive login). The compose file forwards these too; with any unset, the upload
button stays hidden and the app runs normally.

## Run locally for development

```bash
./run.sh          # data/ is the data folder
./run.sh --test   # test-data/ is the data folder
```

Launches the backend (`uvicorn`, no `--reload` — see below) and the frontend
(`npm run dev`, Vite proxies `/api` and `/snapshots` to :8000) together. Stop with
Ctrl-C or, from another shell, `./stop.sh`. `SQV_DATA_DIR` (raw inputs; set by
`run.sh` to `data/` or, with `--test`, `test-data/`) and `SQV_CHECKPOINT_DIR` (saved
sessions + snapshots; `run.sh` uses `checkpoints/`) are strictly separate — imports
read only from the data dir, load/save only from the checkpoint dir — and can each be
overridden to point at any other folder. If a `.env` file exists at the repo root, `run.sh` sources it
before launching uvicorn, so `CIRRO_*` config set there (see above)
reaches the backend the same way docker compose's auto-loaded `.env` does. It
expects a `.venv-introspect/` virtualenv at the repo root (Python 3.11;
squidpy does not support 3.13+):

```bash
python3.11 -m venv .venv-introspect && . .venv-introspect/bin/activate
pip install -r backend/requirements.txt
pip uninstall -y leidenalg igraph   # GPL Leiden backends; use custom.leiden instead
```

Backend edits require restarting `run.sh` manually: the long-lived SSE stream
(`/api/events`) never closes, so `--reload` hangs on "Waiting for connections
to close" instead of picking up the change.

Testing a Cirro upload that includes snapshots also needs the standalone snapshot
viewer built once (it's copied into the bundle): `cd frontend && npm run build:viewer`
(output `frontend/dist-viewer/`, where the backend looks by default). `run.sh` does
not build it — rebuild after changing the viewer.

## Run offline (headless CLI + Nextflow)

`backend/cli.py` runs a recipe over a dataset without the server or frontend,
reusing the same introspected registry, session worker, and persistence the app
uses (so results match the UI). Run it from `backend/` with the dev venv:

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

# override a recipe's declared parameters
../.venv-introspect/bin/python cli.py \
  --parser zarr --input ../test-data/visium_hne.zarr \
  --recipe app/recipes/07_neighborhood_enrichment.json \
  --recipe-params '{"n_neighs": 4}' --output ../out

../.venv-introspect/bin/python cli.py --list-parsers   # available parsers
```

| Flag | Meaning |
|---|---|
| `--parser` | reader registry key (`io.xenium`), bare reader name (`xenium`), or `zarr`/`spatialdata` to load an existing `.zarr`/`.zarr.zip` |
| `--input` | raw data folder (reader mode) or the `.zarr`/`.zarr.zip` (zarr mode) |
| `--recipe` | path to a recipe JSON file, or a bundled recipe name |
| `--recipe-params` | JSON object of recipe-parameter overrides (fills the recipe's `$param` refs; declared defaults apply otherwise) |
| `--output` | output directory (created if absent) |
| `--reader-params` | JSON object of extra kwargs for the reader (reader mode) |
| `--name` | base name for the output `.zarr.zip` (default: from `--input`) |

The output folder holds `<name>.zarr.zip` (the full SpatialData + app state, reloadable
in the app) and `plots/<NN>_<namespace>.<function>/figure.{svg,pdf}` for each plot step.

**Nextflow.** `nextflow/main.nf` wraps the CLI and exposes the same parameters; its
container installs the pinned Python deps at runtime with `uv`, so there is no image to
build. Quick run against the test dataset:

```bash
nextflow run nextflow/main.nf -profile test,docker
```

See `nextflow/README.md` for the full parameter list and a raw-reader example.

## Test dataset

`scripts/prepare_test_data.py` downloads squidpy's `visium_hne_sdata` (a mouse-brain
Visium H&E section: 2688 spots x 18078 genes, with `leiden`/`cluster` annotations),
backfills `obsm['spatial']` from the spot centroids, and writes `test-data/visium_hne.zarr`.
A representative pipeline: `gr.spatial_neighbors` → `gr.nhood_enrichment` →
`pl.nhood_enrichment`, then save/export to `.zarr.zip` and reload.

`scripts/prepare_xenium_data.py` builds `test-data/xenium.zarr` (~70 MB) from the 10x
"Human Lung (2 FOV)" Xenium demo — 11,898 cells x 289 genes of RAW counts (no
clustering), with cell/nucleus boundaries and a morphology image. Fetch the raw bundle
first (see the script's docstring), then run it. This is the target for the scanpy
preprocessing recipes (`Preprocess & cluster`, etc.). `test-data/` is gitignored
(datasets are regenerated by these scripts, never committed).

`scripts/prepare_xenium_tma.py` builds `test-data/xenium_tma.zarr` — a tissue
microarray laid out as a 3×4 grid of 12 cores from the real Xenium lung cells (no
public Xenium TMA is downloadable at a usable size). It's the target for validating
the custom **Identify TMAs** core-detection function, which recovers all 12 cores,
and — using the detected cores as a per-cell sample id, plus a synthetic condition
split for testing — the multi-sample methods (**Milo differential abundance**,
**LISI**, **Pseudobulk DE (DESeq2)**).

## Tests

- `cd backend && ./check-contribution.sh` — the contribution gate: builds the registry,
  runs the custom-function self-check (closed widget/`effect_class`/`role` vocab, the
  `bound_to` contract, that every custom `key` is unique, and that every
  `custom_doc(...)` anchor resolves in `registry/custom/README.md`), asserts every
  function carries `citation` + `documentation`, and confirms the recipes load. Prints
  `OK N functions M recipes`. Run this before opening a PR (see `CONTRIBUTING.md`).
- `cd backend && python test_e2e.py` — full in-process round trip (load → compute →
  Arrow → plot → save `.zarr.zip` → reload), asserting app state + computed fields survive.
  Also covers staged/pending recipe steps + preflight, region promote/annotate and their
  persistence, the editable points-transform (affine applied to the Arrow fetch, persisted),
  content-hashed checkpoint naming, `data_versions` bumping + plot invalidation/redraw,
  persisted canvas encoding, the data-inspector endpoints, cross-session isolation, the
  eight spatial/multi-sample custom methods end to end on `xenium_tma.zarr`, and the
  cell-segmentation display endpoints on `xenium.zarr` (`/cell-field` metadata and the
  `/shapes/{element}/geoarrow` polygons — bbox subsetting, `limit`, 404 on a
  missing/non-polygonal element, a checkpoint round-trip, the no-polygon `visium_hne`
  fallback, and a centroid-alignment gate that transformed polygons overlay `obsm:spatial`).
- `cd backend && python test_cli.py` — offline CLI (`cli.py`) round trip: loads
  `visium_hne.zarr` in zarr mode, runs a compute + plot recipe headlessly, and asserts the
  output `.zarr.zip` and `plots/…/figure.{svg,pdf}` are written and reload with history intact.
- `cd frontend && npx tsc --noEmit -p tsconfig.app.json && npm run build` — typecheck + build.
- `cd frontend && npm run check:tours` — static guard that every guided-tour anchor
  (`frontend/src/tours/anchors.ts`) has a matching `data-tour="…"` attribute in the source.
- `cd frontend && npm run test:e2e` — Playwright browser e2e tests (`frontend/e2e/`). Boots the
  real backend (against `test-data/`) and the Vite dev server itself (see
  `frontend/playwright.config.ts`); drives the app in Chromium to open the `visium_hne` dataset,
  run a compute function end-to-end, browse the result in the data inspector, and walk the
  guided tour through its always-present steps.
