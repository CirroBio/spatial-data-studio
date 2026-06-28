# squidpy-viewer

Interactive analysis and visualization for spatial omics data. A Python backend
holds a [`SpatialData`](https://spatialdata.scverse.org/) object in memory and
exposes [`squidpy`](https://squidpy.readthedocs.io/) as a runtime-introspected
function registry; a React/TypeScript frontend renders cell-scale data in WebGL
(deck.gl) and drives all interaction. See [DESIGN.md](DESIGN.md) for the full
design and [docs/CONTRACT.md](docs/CONTRACT.md) for the API.

## Foundational principle: zero hardcoded library functions

No part of the app names a specific `squidpy` function. The available operations
are discovered by introspecting the `squidpy` package at startup; forms are
generated from function signatures; calls are stored and executed as declarative
descriptors. Upgrading `squidpy` exposes new functions with no app code changes.
The only library-specific knowledge is `squidpy`'s parameter-naming conventions
(`backend/app/registry/conventions.py`), applied uniformly.

## Layout

```
backend/    FastAPI app — registry, sessions, queue/worker, Arrow data path, persistence
frontend/   React + TS + Vite + Tailwind + deck.gl SPA
docker/     single-image build (multi-stage), nginx edge, supervisor
docs/       CONTRACT.md (REST/SSE/Arrow API)
scripts/    prepare_test_data.py (fetch + prep the test dataset)
```

## Run with Docker (single image, recommended)

```bash
python scripts/prepare_test_data.py     # writes test-data/visium_hne.zarr (~375 MB, needs squidpy)
docker compose up --build -d            # builds the SPA + backend into one image
open http://localhost:8080              # load /data/visium_hne.zarr in the New Session dialog
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
A representative end-to-end pipeline: `gr.spatial_neighbors` → `gr.nhood_enrichment`
→ `pl.nhood_enrichment`, then save/export to `.zarr.zip` and reload.

## Backend self-test

`cd backend && python test_e2e.py` runs the full round trip in-process (load →
compute → Arrow fetch → plot → save `.zarr.zip` → reload), asserting that app
state and computed fields survive persistence.
