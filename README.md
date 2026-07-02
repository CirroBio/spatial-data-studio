# Spatial Data Studio

Interactive analysis and visualization for spatial omics data. A Python backend
holds a [`SpatialData`](https://spatialdata.scverse.org/) object in memory and
exposes [`squidpy`](https://squidpy.readthedocs.io/) as a runtime-introspected
function registry; a React/TypeScript frontend renders cell-scale data in WebGL
(deck.gl) and drives all interaction. See [DESIGN.md](DESIGN.md) for the original
design, [post-build-additions-v2.md](post-build-additions-v2.md) for the current
addendum spec, and [docs/CONTRACT.md](docs/CONTRACT.md) for the API.

> **Maintenance rule:** this README is the source of truth for what the app does
> and how to run it. **Keep it up to date** — any change that adds/removes a
> feature, endpoint, run command, or layout element updates this README in the
> same change. See [CLAUDE.md](CLAUDE.md).
>
> **Governance:** invariants are enforced by `sds-governance/` (`make check`); read
> [`sds-governance/AGENTS.md`](sds-governance/AGENTS.md) before changing the catalog
> or agent surface.

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
with a `keep_failures` flag (frontend calls keep failures in history; the AI agent does
not). **`LibraryFunction`** (`library_fn.py`) is the one reflection-built executor for all
libraries — a `library` field drives the import, so squidpy/scanpy/spatialdata-io readers
run through one path; squidpy is still never named in code. **Custom functions**
(`registry/custom/`) are hand-written `Function` subclasses. All three flow through the
same picker → form → queue → history machinery.

## Features

- **Introspected operations** — every `squidpy` `gr`/`im`/`tl`/`read`/`pl` function
  as a generated form; `copy`/`inplace` pinned, plot render-params managed.
- **Expanded catalog** (`registry/library_catalog.yaml`) — scanpy `pp`/`tl`/`get`
  (QC, normalization, HVG, PCA, neighbors, leiden/louvain, UMAP, rank_genes_groups, …)
  and spatialdata-io readers (xenium/visium/visium_hd/merscope/cosmx), added one short
  manifest entry each; `get.*` use an `extract` effect class.
- **Custom functions** (non-squidpy, `namespace: custom`) — *Identify Regions (Leiden)*,
  *Edit Annotations* (rename/merge a categorical obs column's values), and *Identify TMAs*
  (automatic tissue-microarray core detection).
- **Data manifest** (`backend/app/manifest`) — an extensible, text representation of
  session state (tables + dtypes, categoricals with counts, region sets, images/channels,
  summaries) captured before/after every call; the AI's eyes and a human-readable diff.
- **AI chat** (optional, AWS Bedrock; `backend/app/agent`) — a per-session assistant with a
  fixed set of meta-tools over the catalog (list/describe/run functions, manifest, recipes,
  snapshots), an auto-mode toggle and sequential human approval (approve / edit & approve /
  deny+reason), and self-curated context that persists into the `.zarr.zip`. Strictly
  additive: dark unless configured (`AI_ENABLED`), with graceful degradation.
- **Sessions** — one in-memory `SpatialData` per session, a FIFO worker thread,
  compute/plot jobs, structural-diff–driven refresh, live RAM/CPU resource strip.
- **deck.gl canvas** — binary Arrow scatter colored by `obs`/`X`/region set over the
  tissue image; world-unit point sizing.
- **Data inspector** — a Spatial/Tables switch in the viewer's top-left opens a
  paginated browser over the `SpatialData` elements: each table's `obs`/`var`
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
  deselects it. New/Save session are icon buttons (hover for labels) in the top
  toolbar.
- **Recipes** — curated multi-step workflows browsable from the Compute/Plots tabs
  (**Browse recipes**), served by `GET /api/recipes`, run through `/recipe/run`.
  squidpy spatial recipes for `visium_hne` (neighborhood enrichment, Moran's I
  spatially variable genes, co-occurrence, region graph topology, Ripley's L) and
  scanpy recipes for raw data such as Xenium (preprocess → Leiden + UMAP; QC →
  filter → cluster; marker genes; end-to-end cluster → neighborhood enrichment). Plus PENDING staging
  (stage/edit/run/run-all) and a preflight that computes required-vs-produced
  keys + validates the installed registry. Ad-hoc export/import over history too.
- **Persistence** — save/load `.zarr` and `.zarr.zip` (data + app state in
  `attrs`), with full UI/region/history round-trip.

## Layout

```
backend/    FastAPI app
  app/registry/   base.py (abstract Function + contract envelope), library_fn.py (one reflection
                  executor for squidpy/scanpy/spatialdata-io), custom/ (non-squidpy functions),
                  library_catalog.yaml (opt-in library manifests), terms.yaml + dictionary.py
                  (Parameter Term Dictionary), introspect.py (Registry)
  app/manifest/   data manifest contributor registry + seed contributors (v3 Part 3)
  app/agent/      meta-tools, Bedrock/mock provider, chat loop + approval, self-curated context
  app/sessions/   manager, session (queue/worker), adapter (routes to Function.execute), regions, appstate
  app/transport/  arrow (field -> Arrow IPC), tables (element inventory + dataframe page JSON), sse
  app/recipes.py  curated analysis recipes (catalog + apply)
  app/persistence/ store (.zarr / .zarr.zip)
frontend/   React + TS + Vite + Tailwind + deck.gl SPA
docker/     single-image build (multi-stage), nginx edge, supervisor
docs/       CONTRACT.md (REST/SSE/Arrow API)
scripts/    test-data prep: prepare_test_data.py (Visium H&E), prepare_xenium_data.py (Xenium),
            prepare_xenium_tma.py (Xenium TMA grid for the Identify TMAs detector)
sds-governance/  governance bundle: RULES.md (R1-R16) + AGENTS.md + skills/ +
                 checks/ executable gate (`make check`) + license allowlist (v3 Part 14)
```

## Run with Docker (single image, recommended)

```bash
python scripts/prepare_test_data.py     # writes test-data/visium_hne.zarr (~375 MB, needs squidpy)
docker compose up --build -d            # builds the SPA + backend into one image
open http://localhost:8080              # New Session -> /data/visium_hne.zarr
```

The compose file mounts `test-data/` read-only at `/data` and a `checkpoints`
volume at `/checkpoints`. Inside the container: `tini` → `supervisord` →
{`nginx` edge (SSE buffering off), `uvicorn --workers 1`}.

**Enable the AI chat (optional).** Copy `.env.example` to `.env` and set
`AI_ENABLED=true` plus either `AI_PROVIDER=mock` (credential-free demo of the agent
loop/approval) or `AI_PROVIDER=bedrock` with `BEDROCK_MODEL_ID`, `AWS_REGION`, and AWS
credentials. The compose file forwards these; e.g. a quick mock demo:
`AI_ENABLED=true AI_PROVIDER=mock docker compose up --build -d`. With AI disabled the
chat panel is dark and the app runs normally.

## Run locally for development

```bash
./run.sh
```

Launches the backend (`uvicorn`, no `--reload` — see below) and the frontend
(`npm run dev`, Vite proxies `/api` to :8000) together. Stop with Ctrl-C or,
from another shell, `./stop.sh`. It expects a `.venv-introspect/` virtualenv at
the repo root (Python 3.11; squidpy does not support 3.13+):

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
the custom **Identify TMAs** core-detection function, which recovers all 12 cores.

## Tests

- `cd backend && python test_e2e.py` — full in-process round trip (load → compute →
  Arrow → plot → save `.zarr.zip` → reload), asserting app state + computed fields survive.
- `cd frontend && npx tsc --noEmit -p tsconfig.app.json && npm run build` — typecheck + build.
- `cd frontend && npm run test:e2e` — Playwright browser e2e tests (`frontend/e2e/`). Boots the
  real backend (against `test-data/`) and the Vite dev server itself (see
  `frontend/playwright.config.ts`); drives the app in Chromium to open the `visium_hne` dataset,
  run a compute function end-to-end, and browse the result in the data inspector.
