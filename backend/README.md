# Spatial Data Studio backend

FastAPI backend for interactive spatial-omics analysis. Holds one `SpatialData`
object per session in memory, exposes squidpy/scanpy/spatialdata-io as an
introspected function registry, runs compute/plot jobs on a per-session worker thread, and serves field
data as Apache Arrow IPC. See `../DESIGN.md` for the full design and `../docs/CONTRACT.md`
for the API.

## Layout

```
app/
  main.py                FastAPI app, routes, lifespan (build registry, resource sampler, SSE loop, prewarm)
  config.py              env-driven config (memory limits, mounts, cadence, Cirro creds)
  registry/
    base.py              abstract Function + contract envelope + shared compute/plot helpers (§4)
    library_fn.py        the one reflection executor for squidpy/scanpy/spatialdata-io
    introspect.py        Registry: discovery + signature->JSON-Schema + type-injection + effect class (§4)
    library_catalog.yaml opt-in library manifests; library_meta.py + .yaml supply per-library provenance
    terms.yaml + dictionary.py   Parameter Term Dictionary — THE ONLY library-specific knowledge, keyed by term
    custom/              hand-written non-squidpy Function subclasses (+ _vendor/ numerical code, README.md)
  manifest/              data-manifest contributor registry + seed contributors (§Part 3)
  sessions/
    manager.py           SessionManager: load/create, subset->child, memory admission, resource sampling (§8,§11)
    session.py           Session: SpatialData + FIFO queue + worker thread + RW lock + app_state (§6,§20.2)
    adapter.py           the single CallAdapter.execute (§4.6) — routes a descriptor to Function.execute
    appstate.py          versioned app_state in sdata.attrs["app_state"] + migration (§3.2,§13)
    regions.py           lasso membership -> region-set obs column; transform.py: points->global affine
  transport/
    arrow.py             field-path resolver -> Arrow IPC (obs/obsm/var/X dense, obsp CSR triplets) (§3.3)
    tables.py            data-inspector element inventory + paginated dataframe JSON
    sse.py               single multiplexed SSE bus with Last-Event-ID resume (§14.2)
  persistence/
    store.py             save/load .zarr (dir) and .zarr.zip (browser-readable, sharded, incremental re-save)
  recipes/               curated analysis recipes (JSON, discovered at startup) + catalog/apply
  imaging.py             tiled image pyramid + channel compositing + coordinate reconciliation (§9.2)
  rasters.py             ingest-time re-tiling into a tile-chunked sharded pyramid
  snapshots.py           JSON snapshot-config write/list
  datasets.py            saved-checkpoint scan for the load/upload pickers (prewarmed cache)
  prewarm.py             background queue that warms slow first-open menu lists off the event loop
  cirro.py               Cirro dataset upload (client-credentials auth, symlink bundle)
  acknowledgements.py    third-party license catalog from the SBOMs
cli.py                   offline recipe runner — reuses the registry/session engine headlessly
```

## Run locally

The canonical dev venv is `.venv-introspect/` at the repo root (Python 3.11;
squidpy does not support 3.13+), created as in the root README:

```bash
cd ..                                                # repo root
python3.11 -m venv .venv-introspect && . .venv-introspect/bin/activate
pip install -r backend/requirements.txt
pip uninstall -y leidenalg igraph                    # GPL Leiden backends; use custom.leiden
cd backend
SDS_DATA_DIR=../data SDS_CONTAINER_MEM_MB=16384 \
  uvicorn app.main:app --host 127.0.0.1 --port 8000
```

For the full launcher (backend + frontend together) use `../run.sh`.

Create a session from the test dataset:

```bash
curl -X POST localhost:8000/api/sessions -H 'content-type: application/json' \
  -d '{"source":{"kind":"load","path":"/abs/path/test-data/visium_hne.zarr"}}'
```

## Test

`python test_e2e.py` runs a full in-process round trip (load → compute → Arrow →
plot → save `.zarr.zip` → reload, asserting app_state and computed fields survive).

## Known limitations (v1)

Surfaced by an adversarial review and consciously deferred (none affect the
validated load → compute → plot → save → reload path):

- **Lasso subset → child session** (§8) is implemented but not yet end-to-end
  validated. The parent-eviction-on-subset path takes the read lock while saving;
  acceptable since the parent is being evicted, but not hardened.
- **RW-lock writer starvation**: under sustained reader traffic a queued compute
  job's write lock can be deferred. Mitigated in practice by the client deferring
  refetches to `job.completed` (§9.5/§20.2); no writer-priority counter yet.
- **SSE backpressure**: if a slow client's per-connection queue fills, events are
  dropped; recovery relies on `Last-Event-ID` replay from the ring buffer rather
  than an explicit resync signal.

## Invariants enforced (DESIGN §16)

No module names a library function (the registry is the only path). `copy=False`/
`inplace=True` are pinned so the in-place model can't be defeated. App state is
written only to `sdata.attrs["app_state"]`. Figures are never persisted. References
validate at dequeue, not enqueue. Child sessions deep-copy attrs and start with empty
compute history.
