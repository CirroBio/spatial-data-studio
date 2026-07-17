# Docker packaging

Everything ships as a single image: the React SPA is built in a Node stage and
copied into the Python stage alongside the FastAPI backend. At runtime, nginx
serves the SPA and proxies `/api/*` to uvicorn; tini is PID 1; supervisord
manages both processes.

## Build

From the repository root:

```
docker build -f docker/Dockerfile -t spatial-data-studio .
```

The scientific wheels (squidpy, spatialdata, anndata, pyarrow …) take several
minutes on the first build; subsequent builds are cached unless
`requirements.txt` changes.

## Run (via compose)

```
docker compose up -d
```

Then check:

```
curl http://localhost:8080/api/healthz    # {"status":"ok"}
curl http://localhost:8080/api/readyz     # {"status":"ready","functions":N}
curl http://localhost:8080/               # SPA HTML
```

Logs:

```
docker compose logs -f
```

Stop (allows in-flight saves to flush — up to 120 s):

```
docker compose down
```

## Run (manual)

```
docker run -d \
  --name spatial-data-studio \
  -p 8080:80 \
  -v "$(pwd)/test-data":/data:ro \
  -v sqv-checkpoints:/checkpoints \
  -e SDS_CONTAINER_MEM_MB=12288 \
  -e SDS_WORKER_CEILING_MB=9216 \
  -e SDS_MAX_SESSIONS=4 \
  --memory=12g \
  --memory-swap=12g \
  spatial-data-studio
```

`--memory` is the hard OS ceiling; `--memory-swap=12g` (equal to `--memory`)
disables swap so a runaway allocation is OOM-killed promptly instead of thrashing
the host. `SDS_CONTAINER_MEM_MB` must be set to the same value: the app's soft
admission control refuses new work at `SDS_ADMISSION_PCT` of it, so it trips
*before* the OS OOM killer fires. Compose sets both via `mem_limit` /
`deploy.resources.limits.memory` and `SDS_CONTAINER_MEM_MB` — keep them in sync.

## Environment contract (DESIGN §19.9)

| Variable                 | Default   | Purpose |
|--------------------------|-----------|---------|
| `SDS_DATA_DIR`           | `/data`   | Read-only bind mount for input datasets |
| `SDS_CHECKPOINT_DIR`     | `/checkpoints` | Read-write volume for auto-checkpoints and saves |
| `SDS_CONTAINER_MEM_MB`   | `8192`    | Container cgroup memory limit in MiB. Set to match `--memory` / `mem_limit`. |
| `SDS_WORKER_CEILING_MB`  | `6144`    | Per-worker memory ceiling (must be < `SDS_CONTAINER_MEM_MB`). Triggers a catchable `MemoryError` before the OOM killer fires. |
| `SDS_ADMISSION_PCT`      | `0.80`    | Fraction of container RAM at which new jobs, reads, and image renders are refused. |
| `SDS_MAX_SESSIONS`       | `8`       | Maximum concurrent in-memory sessions. |
| `SDS_IMAGE_RENDER_CONCURRENCY` | `2` | Max image tiles/thumbnails composited at once. Caps the transient memory of a zoom/pan tile burst; renders past `SDS_ADMISSION_PCT` return 503 and the canvas keeps its coarse base layer. |
| `SDS_RASTER_BASE_PX`     | `1024`    | Coarsest image-pyramid level target (longest side) when re-tiling images at ingest. |
| `SDS_RASTER_REBUILD_WORKERS` | `2`   | dask worker count for the one-time ingest re-tiling; bounds its peak memory. |
| `SDS_STATIC_DIR`         | `/app/spa`| Path to the compiled SPA (baked into the image). |
| `SDS_SNAPSHOTS_DIR`      | `<SDS_CHECKPOINT_DIR>/snapshots` | Where snapshot JSON configs are written; defaults under the checkpoint mount, override only if needed. |
| `SDS_SNAPSHOT_VIEWER_DIR`| `frontend/dist-viewer` | Built standalone snapshot viewer copied into a Cirro upload bundle when snapshots are included (`npm run build:viewer`). |
| `SDS_N_THREADS`      | all cores | Default for thread-count form params (`n_jobs`, etc.). |
| `SDS_RESOURCE_HZ`        | `2`       | Resource-sample broadcast cadence (Hz) for the RAM/CPU strip. |
| `SDS_LONG_RUNNING_S`     | `120`     | Long-running-job watchdog threshold (seconds). |
| `CIRRO_BASE_URL`         | _(unset)_ | Cirro API base URL. Upload is dark unless all three `CIRRO_*` are set. |
| `CIRRO_CLIENT_ID`        | _(unset)_ | Cirro service-account (client-credentials) id. |
| `CIRRO_CLIENT_SECRET`    | _(unset)_ | Cirro service-account secret. |

## Volumes

| Mount     | Mode      | Purpose |
|-----------|-----------|---------|
| `/data`   | read-only | Source datasets (`.zarr`, `.zarr.zip`, Visium/Xenium raw folders). |
| `/checkpoints` | read-write | Checkpoint `.zarr` directories and explicit `.zarr.zip` saves. **Must be a persistent volume** — container-local storage does not survive a restart. |

## Internal process tree

```
PID 1: tini
  supervisord
    nginx      - serves /app/spa; reverse-proxies /api/* and /api/events to uvicorn
    uvicorn    - FastAPI backend on 127.0.0.1:8000, --workers 1
```

nginx stays up while uvicorn restarts, so the SPA shell stays reachable during
a backend crash/restart cycle. supervisord applies exponential back-off before
each uvicorn restart attempt.

## SSE

The `/api/events` location in `nginx.conf` has `proxy_buffering off` and a
24-hour read timeout, which is required for the persistent SSE stream. Do not
add any HTTP middleware upstream (load balancer, CDN) that re-enables response
buffering without also applying the same setting.

## Health endpoints

- `GET /api/healthz` — liveness: event loop is responsive.
- `GET /api/readyz`  — readiness: registry built and ready to serve.

The HEALTHCHECK uses `/api/healthz` with generous tolerances (60 s start
period, 3 retries) to avoid false restarts caused by GIL-blocking jobs
(DESIGN §19.8).
