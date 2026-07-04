# Spatial Data Studio backend

FastAPI backend for interactive spatial-omics analysis. Holds one `SpatialData`
object per session in memory, exposes squidpy as an introspected function
registry, runs compute/plot jobs on a per-session worker thread, and serves field
data as Apache Arrow IPC. See `../DESIGN.md` for the full design and `../docs/CONTRACT.md`
for the API.

## Layout

```
app/
  main.py                FastAPI app, routes, lifespan (build registry, resource sampler, SSE loop)
  config.py              env-driven config (memory limits, mounts, cadence)
  registry/
    introspect.py        discovery + signature->JSON-Schema + type-injection + effect class (§4)
    terms.yaml + dictionary.py   Parameter Term Dictionary — THE ONLY library-specific knowledge, keyed
                          by parameter term (not by function); superseded conventions.py (see root README)
  sessions/
    manager.py           SessionManager: load/create, subset->child, memory admission, resource sampling (§8,§11)
    session.py           Session: SpatialData + FIFO queue + worker thread + RW lock + app_state (§6,§20.2)
    adapter.py           the single CallAdapter.execute (§4.6) — inject/bind/validate/run/diff/effect-handle
    appstate.py          versioned app_state in sdata.attrs["app_state"] + migration (§3.2,§13)
  transport/
    arrow.py             field-path resolver -> Arrow IPC (obs/obsm/var/X dense, obsp CSR triplets) (§3.3)
    sse.py               single multiplexed SSE bus with Last-Event-ID resume (§14.2)
  persistence/
    store.py             save/load .zarr (dir) and .zarr.zip (dir+zip; direct zip write is broken in spatialdata 0.7.3)
  imaging.py             image element -> thumbnail PNG + world-coord bounds for a deck.gl BitmapLayer (§9.2)
```

## Run locally

```bash
python3.11 -m venv .venv && . .venv/bin/activate     # squidpy needs <=3.12; 3.11 validated
pip install -r requirements.txt
SQV_DATA_DIR=../data SQV_CHECKPOINT_DIR=../checkpoints SQV_CONTAINER_MEM_MB=16384 \
  uvicorn app.main:app --host 127.0.0.1 --port 8000
```

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

No module names a squidpy function (the registry is the only path). `copy=False`/
`inplace=True` are pinned so the in-place model can't be defeated. App state is
written only to `sdata.attrs["app_state"]`. Figures are never persisted. References
validate at dequeue, not enqueue. Child sessions deep-copy attrs and start with empty
compute history.
