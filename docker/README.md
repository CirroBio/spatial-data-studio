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

The scientific wheels (squidpy, spatialdata, anndata, pyarrow …) are installed
with [uv](https://docs.astral.sh/uv/) (pinned in the Dockerfile) — much faster
than pip, but still a few minutes on the first build; subsequent builds are
cached unless `requirements.txt` changes.

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

Logs (backend, nginx, and supervisord all stream to the container's stdout/stderr,
so this surfaces uvicorn startup tracebacks too — including a crash-loop where the
backend exits before serving any request):

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
  -p 8080:8888 \
  -v "$(pwd)/test-data":/data \
  -e SDS_DATA_DIR=/data \
  -e SDS_CONTAINER_MEM_MB=12288 \
  -e SDS_MAX_SESSIONS=4 \
  --tmpfs /work:size=10g,mode=1777 \
  -e SDS_WORK_DIR_IN_RAM=1 \
  --cap-add SYS_ADMIN \
  --memory=12g \
  --memory-swap=12g \
  spatial-data-studio
```

The `--tmpfs /work` mount holds the working set (unpacked archives + raster caches) in
RAM (`SDS_WORK_DIR` defaults to `/work` in the image); `SDS_WORK_DIR_IN_RAM=1` folds that
tmpfs usage into the admission accounting so the soft 503 boundary trips before the tmpfs
can grow the container past `--memory` into an OOM kill. `--cap-add SYS_ADMIN` lets the
`work-tmpfs.sh` entrypoint **remount `/work` to `SDS_WORK_TMPFS_PCT` (85%) of the detected
memory limit at startup**, so the tmpfs autoscales with `--memory` instead of staying at the
`size=` fallback. Without the capability it fails open — the `size=10g` fallback stands.
Omit the tmpfs entirely to keep the working set on disk (the container's writable layer).

`--memory` is the hard OS ceiling; `--memory-swap=12g` (equal to `--memory`)
disables swap so a runaway allocation is OOM-killed promptly instead of thrashing
the host. The app's soft admission control refuses new work at `SDS_ADMISSION_PCT`
of the container limit, so it trips *before* the OS OOM killer fires. That limit is
**auto-detected from the container's cgroup** — the same value the kernel enforces —
so you normally do **not** need to set `SDS_CONTAINER_MEM_MB`: leave it unset and the
app reads `--memory` / `mem_limit` / an ECS task's memory / `deploy.resources.limits.memory`
directly. Set it explicitly only to override the detected value. When the container runs
with no memory hard-limit at all — a bare `docker run`, or an ECS task with only a soft
`memoryReservation` — detection falls back to the host's **total physical RAM** (which is
what the container may actually use), and only to 8192 MiB if physical memory can't be
read. The example above passes it just to illustrate the override.

## Environment contract (DESIGN §23.4)

| Variable                 | Default   | Purpose |
|--------------------------|-----------|---------|
| `SDS_DATA_DIR`           | `$HOME` (`/home/cirro`) | Single read-write data folder: input datasets, saved checkpoints (`*.sdata.zarr.zip`), and snapshots (`*.sview.json`) all live here. Defaults to the image's `$HOME`, where a deployment environment mounts datasets (e.g. `$HOME/datasets`); the compose and manual-run examples override it to `/data` and mount there. |
| `SDS_WORK_DIR`           | `/work` (image) / system temp | Working dir for the live session working set: the unpacked `.zarr.zip` extract dir and per-session normalized raster caches. Kept out of `SDS_DATA_DIR` so a transient `*.zarr` extract never surfaces in the dataset picker. Point it at a tmpfs mount (compose mounts `/work`) to hold the working set in RAM. |
| `SDS_WORK_DIR_IN_RAM`    | `0` (compose: `1`) | Set to `1` when `SDS_WORK_DIR` is a **dedicated** tmpfs mount, so its usage (`os.statvfs` of the mount) is added to RSS in the admission/boundary math — otherwise tmpfs RAM is invisible to admission and could grow past the limit into an OOM kill. Leave `0` when `WORK_DIR` is on disk. |
| `SDS_WORK_TMPFS_PCT`     | `85`      | Percentage of the detected memory limit that the `work-tmpfs.sh` entrypoint sizes the `/work` tmpfs to on startup (so the tmpfs autoscales with the container's allocation). Needs `CAP_SYS_ADMIN` (compose `cap_add`); without it the entrypoint fails open and the tmpfs keeps its mount-time `size=`. Keep it **above** `SDS_ADMISSION_PCT` so the soft 503 trips before the tmpfs ENOSPCs. |
| `SDS_RASTER_CHUNK_CACHE_MB` | `256`  | Server-side LRU (MB) of raw Viv chunk bytes for the client-compositing raster route; caps repeat-view reads. Lives in the API-process heap (counts against RSS). `0` disables. |
| `SDS_CONTAINER_MEM_MB`   | auto (cgroup, else host RAM) | Container memory limit in MiB. **Unset: auto-detected from the cgroup** (`--memory` / `mem_limit` / ECS task memory), falling back to the host's total physical RAM when the container has no memory hard-limit (and to `8192` only if physical memory can't be read). Set it to override the detected value. A value of `0` disables the memory percentage (the resource strip shows `0%` and admission control never blocks) rather than being treated as a limit. |
| `SDS_ADMISSION_PCT`      | `0.80`    | Fraction of container RAM at which new jobs, reads, and image renders are refused. |
| `SDS_MAX_SESSIONS`       | `8`       | Maximum concurrent in-memory sessions. |
| `SDS_IMAGE_RENDER_CONCURRENCY` | `2` | Max image tiles/thumbnails composited at once. Caps the transient memory of a zoom/pan tile burst; renders past `SDS_ADMISSION_PCT` return 503 and the canvas keeps its coarse base layer. |
| `SDS_CLIENT_IMAGE_COMPOSITING` | `1` | Advertise the client-side (Viv) compositing path in `/image/{element}/info` so the browser reads the raw raster zarr and composites channels on the GPU (instant contrast/color, no server round-trip; streams full-resolution tiles). On by default. Set `0` to force the server-composited PNG tile path (also the automatic fallback for canonical images or channel counts over the cap). |
| `SDS_CLIENT_IMAGE_MAX_CHANNELS` | `6` | Max channels the browser will composite in one shader pass; an element with more channels falls back to PNG tiles. |
| `SDS_RASTER_BASE_PX`     | `1024`    | Coarsest image-pyramid level target (longest side) when re-tiling images at ingest. |
| `SDS_RASTER_REBUILD_WORKERS` | `2`   | dask worker count for the one-time ingest re-tiling; bounds its peak memory. |
| `SDS_STATIC_DIR`         | `/app/spa`| Path to the compiled SPA (baked into the image). |
| `SDS_N_THREADS`      | all cores | Default for thread-count form params (`n_jobs`, etc.). |
| `SDS_RESOURCE_HZ`        | `2`       | Resource-sample broadcast cadence (Hz) for the RAM/CPU strip. |
| `SDS_LONG_RUNNING_S`     | `120`     | Long-running-job watchdog threshold (seconds). |
| `CIRRO_BASE_URL`         | _(unset)_ | Cirro API base URL. Upload is dark unless all three `CIRRO_*` are set. |
| `CIRRO_CLIENT_ID`        | _(unset)_ | Cirro service-account (client-credentials) id. |
| `CIRRO_CLIENT_SECRET`    | _(unset)_ | Cirro service-account secret. |

## Volumes

| Mount     | Mode      | Purpose |
|-----------|-----------|---------|
| `$SDS_DATA_DIR` | read-write | Single data folder: source datasets (`.zarr`, `.zarr.zip`, Visium/Xenium raw folders), saved checkpoints (`*.sdata.zarr.zip`), and snapshots (`*.sview.json`). **Must be a persistent bind/volume** — container-local storage does not survive a restart. Mount it at whatever `SDS_DATA_DIR` points to (`$HOME` by default; the compose file uses `/data`, host path defaulting to `./test-data`, override with `SDS_DATA_HOST_DIR`). |
| `/work` (tmpfs) | RAM | Transient working set (unpacked archives + raster caches). The compose file mounts it as a `size=10g` tmpfs with `SDS_WORK_DIR_IN_RAM=1`; the `work-tmpfs.sh` entrypoint then remounts it to `SDS_WORK_TMPFS_PCT` of the detected memory limit (needs `cap_add: SYS_ADMIN`). Nothing durable lives here, so it needs no persistence. Omit the tmpfs to keep the working set on the container's writable layer (disk). |

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
