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
  (automatic tissue-microarray core detection), *Region composition* / *Region
  composition (plot)* (cell-type-by-region crosstab + chi-square test, then a stacked-bar
  plot of the proportions — pandas/scipy/matplotlib only), and *Annotate Cells (CellTypist)*
  (predict a cell-type label per cell with a pre-trained CellTypist model, writing a
  categorical `<key_added>` column plus a `<key_added>_conf` confidence column; input is
  log1p/1e4-normalized on a copy by default, and the chosen model is downloaded on first use).
- **Spatial & multi-sample analysis methods** (non-squidpy, `namespace: custom`, vendored
  unmodified under `registry/custom/_vendor/`, numpy/scipy/scikit-learn only) — six
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
  the infiltration curve); and *Pseudobulk DE (DESeq2)* (sums raw counts per
  sample × cell type and runs PyDESeq2 with an explicit contrast, the replicate-aware
  alternative to `rank_genes_groups` for condition comparisons — requires ≥2 pseudobulk
  samples per condition per cell type, skipped otherwise, and raw integer counts).
- **Data manifest** (`backend/app/manifest`) — an extensible, text representation of
  session state (tables + dtypes, categoricals with counts, region sets, images/channels,
  summaries) captured before/after every call; a human-readable diff.
- **Sessions** — one in-memory `SpatialData` per session, a FIFO worker thread,
  compute/plot jobs, structural-diff–driven refresh, live RAM/CPU resource strip.
- **Startup splash** — the frontend polls `GET /api/readyz` and shows a full-screen
  splash until the backend finishes importing `squidpy` and building its function
  registry, so a slow cold start doesn't look like an app with nothing to load.
  The session list and the New Session dataset picker also show a "Loading…"
  state rather than looking empty while their first fetch is in flight.
- **deck.gl canvas** — binary Arrow scatter colored by any per-cell value over the
  tissue image; world-unit point sizing. **Color by** first picks a slot (`obs`, `X`
  gene expression, or a `layer`) and then the column within it: obs columns from a
  dropdown, genes from a type-to-search box backed by
  `GET /api/sessions/{id}/var-names?q=&limit=` (so datasets with tens of thousands of
  genes stay responsive — matches are found server-side, prefix hits first). The chosen
  value is saved in the session display state. **Show points** and **Show image**
  checkboxes toggle each layer independently; these toggles, the camera (pan/zoom, and
  the embedding's 3D orbit), and an isolated category are all saved to the session too, so
  the view is restored on reload. Each image channel can be toggled, renamed,
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
  three components. A session with no non-spatial `obsm` shows an empty state to run a
  dimensionality reduction first; sessions that gain one later (or predate this
  feature) can create the view on demand via `POST /api/sessions/{id}/displays`.
- **Data inspector** — a Spatial/Embeddings/Tables switch in the viewer's top-left
  opens a paginated browser over the `SpatialData` elements: each table's `obs`/`var`
  dataframes, `shapes` GeoDataFrames (geometry as WKT), `points`, and image
  metadata + thumbnail. Served by `GET /api/sessions/{id}/elements` (inventory)
  and `GET /api/sessions/{id}/table?path=&offset=&limit=` (JSON page).
- **Light/dark theme** — toggle in the top toolbar; colors are CSS variables
  (`rgb(var(--…))`), the choice persists in the browser (`localStorage`).
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
  toolbar. Saving blocks the whole UI behind a spinner overlay until the write
  finishes; an unobtrusive Stop button cancels it if the job is still queued
  (a save already writing to disk can't be interrupted).
- **Recipes** — curated multi-step workflows browsable from the Compute/Plots tabs
  (**Browse recipes**, with a search box filtering by name/description/step), served
  by `GET /api/recipes`, applied through `/recipe/run`. Each recipe offers **Run**
  (queues every step immediately) or **Stage** (loads the steps as editable *pending*
  entries). A pending step shows a dashed `pending` badge in the Compute/Plots list;
  opening it lets you **Edit params** (Save keeps it pending) and **Run** it on its
  own, and a **Run all pending (N)** button in the tab footer submits every staged
  step in order. Loading a recipe file (**Load recipe**) stages it the same way so
  its parameters can be reviewed before running.
  squidpy spatial recipes for `visium_hne` (neighborhood enrichment, spatially
  variable genes by Moran's I / Geary's C / sepal, co-occurrence, region graph
  topology, Ripley's L, ligand-receptor interactions); scanpy recipes for raw
  data such as Xenium (preprocess → Leiden + UMAP; QC → filter → cluster; marker
  genes; cluster hierarchy + markers; t-SNE + diffusion-map
  embeddings; PAGA trajectory; end-to-end cluster → neighborhood enrichment); and
  scanpy-tutorial reproductions (full Visium analysis & visualization; MERFISH
  clustering for imaging-based counts). Recipes
  are JSON files under `backend/app/recipes/` discovered at startup — see
  "Contributing recipes" below. Ad-hoc export/import over history too.
- **Persistence** — save/load `.zarr` and `.zarr.zip` (data + app state in
  `attrs`), with full UI/region/history round-trip. Auto-managed checkpoint
  filenames (Save button, no explicit path) embed a hash of the `.zarr.zip`
  contents, e.g. `myfile-3fa21c9b8e4d.zarr.zip`; each save computes the hash
  fresh from the current base name, so the suffix reflects that save's
  contents instead of stacking onto the previous one. Prior checkpoint files
  are left on disk. Loading a `.zarr.zip` with a hash suffix recomputes and
  logs whether it still matches the file's contents (info if it does, warning
  if not) — informational only, never blocks the load.
- **Acknowledgements** (About icon in the header) — third-party libraries in use and
  their licenses, served by `GET /api/about/licenses` from the backend/frontend SBOMs
  (`sds-governance/sbom.json` + `sds-governance/sbom_frontend.json`).
- **Cirro upload** (`backend/app/cirro.py`, optional) — upload the saved session plus
  selected snapshots to [Cirro](https://cirro.bio/) as a dataset, via a service-account
  (OAuth client-credentials) identity — no interactive login. Strictly additive: dark
  unless `CIRRO_BASE_URL`, `CIRRO_CLIENT_ID`, and `CIRRO_CLIENT_SECRET` are all set. The
  session must be saved first; the upload folder is built from symlinks (the saved
  `.zarr.zip` plus, per selected snapshot, only the specific assets it references —
  `assets/` is shared and content-hashed across snapshots) so nothing is copied. Always
  uploaded via Cirro's generic "Files" ingest process (`custom_dataset`, accepts any
  file) — the service-account identity only needs `Create dataset`/`View dataset` on
  the target project, no `View process` permission. An optional destination folder can
  be typed in (Cirro groups datasets into folders via a `folder://<path>` dataset tag,
  not a real API); existing folder paths for the chosen project are offered as a
  typeahead, backend-cached per project (`GET /api/cirro/projects/{id}/folders`).

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
  app/cirro.py    Cirro dataset upload (client-credentials auth, symlink-based upload folder)
frontend/   React + TS + Vite + Tailwind + deck.gl SPA
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
  "steps": [
    { "namespace": "sc.pp", "function": "normalize_total", "params": {} },
    { "namespace": "gr", "function": "spatial_neighbors", "params": { "coord_type": "grid", "n_neighs": 6 } }
  ]
}
```

Each step is `{namespace, function, params}`. Valid namespaces: squidpy `gr`, `im`,
`tl`, `pl`, `read`; scanpy `sc.pp`, `sc.tl`, `sc.get`, and `sc.pl` (limited to the
`rank_genes_groups_*` marker-gene plots — do all other plotting with squidpy `pl.*`).
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
(`npm run dev`, Vite proxies `/api` to :8000) together. Stop with Ctrl-C or,
from another shell, `./stop.sh`. `SQV_DATA_DIR` (set by `run.sh` to `data/` or,
with `--test`, `test-data/`) can still be overridden directly to point at any
other folder. If a `.env` file exists at the repo root, `run.sh` sources it
before launching uvicorn, so `CIRRO_*` config set there (see above)
reaches the backend the same way docker compose's auto-loaded `.env` does. It
expects a `.venv-introspect/` virtualenv at the repo root (Python 3.11;
squidpy does not support 3.13+):

```bash
python3.11 -m venv .venv-introspect && . .venv-introspect/bin/activate
pip install -r backend/requirements.txt
```

Backend edits require restarting `run.sh` manually: the long-lived SSE stream
(`/api/events`) never closes, so `--reload` hangs on "Waiting for connections
to close" instead of picking up the change.

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

- `cd backend && python test_e2e.py` — full in-process round trip (load → compute →
  Arrow → plot → save `.zarr.zip` → reload), asserting app state + computed fields survive.
  Also covers staged/pending recipe steps + preflight, region promote/annotate and their
  persistence, the editable points-transform (affine applied to the Arrow fetch, persisted),
  content-hashed checkpoint naming, `data_versions` bumping + plot invalidation/redraw,
  persisted canvas encoding, the data-inspector endpoints, cross-session isolation, and the
  six spatial/multi-sample custom methods end to end on `xenium_tma.zarr`.
- `cd frontend && npx tsc --noEmit -p tsconfig.app.json && npm run build` — typecheck + build.
- `cd frontend && npm run test:e2e` — Playwright browser e2e tests (`frontend/e2e/`). Boots the
  real backend (against `test-data/`) and the Vite dev server itself (see
  `frontend/playwright.config.ts`); drives the app in Chromium to open the `visium_hne` dataset,
  run a compute function end-to-end, and browse the result in the data inspector.
