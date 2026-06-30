# squidpy-viewer

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

## Features

- **Introspected operations** — every `squidpy` `gr`/`im`/`tl`/`read`/`pl` function
  as a generated form; `copy`/`inplace` pinned, plot render-params managed.
- **Sessions** — one in-memory `SpatialData` per session, a FIFO worker thread,
  compute/plot jobs, structural-diff–driven refresh, live RAM/CPU resource strip.
- **deck.gl canvas** — binary Arrow scatter colored by `obs`/`X`/region set over the
  tissue image; world-unit point sizing.
- **Region annotation** — draw a lasso to label cells into a region set (a
  categorical `obs` column) in place, or promote an existing categorical; region
  sets flow through every grouping picker automatically.
- **Lasso subset** — draw a region to create a child session (via
  `spatialdata.polygon_query`), evicting the parent.
- **Four-tab UI** — Compute, Plots, Annotations, Subsetting; the active
  canvas-workflow tab sets the draw mode (label vs subset).
- **Recipes / staging (backend)** — PENDING step staging (stage/edit/run/run-all)
  and a recipe preflight that computes required-vs-produced keys + validates the
  installed registry.
- **Persistence** — save/load `.zarr` and `.zarr.zip` (data + app state in
  `attrs`), with full UI/region/history round-trip.

## Layout

```
backend/    FastAPI app
  app/registry/   introspection: terms.yaml + dictionary.py (Parameter Term Dictionary), introspect.py
  app/sessions/   manager, session (queue/worker), adapter (CallAdapter), regions, appstate
  app/transport/  arrow (field -> Arrow IPC), sse
  app/persistence/ store (.zarr / .zarr.zip)
frontend/   React + TS + Vite + Tailwind + deck.gl SPA
docker/     single-image build (multi-stage), nginx edge, supervisor
docs/       CONTRACT.md (REST/SSE/Arrow API)
scripts/    prepare_test_data.py (fetch + prep the test dataset)
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

## Run locally for development

```bash
# backend (needs Python 3.11; squidpy does not support 3.13+)
python3.11 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt
cd backend && SQV_DATA_DIR=../test-data SQV_CONTAINER_MEM_MB=16384 \
  uvicorn app.main:app --port 8000

# frontend (in another shell) — Vite proxies /api to :8000
cd frontend && npm install && npm run dev
```

## Test dataset

`scripts/prepare_test_data.py` downloads squidpy's `visium_hne_sdata` (a mouse-brain
Visium H&E section: 2688 spots x 18078 genes, with `leiden`/`cluster` annotations),
backfills `obsm['spatial']` from the spot centroids, and writes a SpatialData `.zarr`.
A representative pipeline: `gr.spatial_neighbors` → `gr.nhood_enrichment` →
`pl.nhood_enrichment`, then save/export to `.zarr.zip` and reload.

## Tests

- `cd backend && python test_e2e.py` — full in-process round trip (load → compute →
  Arrow → plot → save `.zarr.zip` → reload), asserting app state + computed fields survive.
- `cd frontend && npx tsc --noEmit -p tsconfig.app.json && npm run build` — typecheck + build.
