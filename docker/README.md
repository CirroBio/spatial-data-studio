# Docker packaging

Everything ships as a single image: the React SPA is built in a Node stage and
copied into the Python stage alongside the FastAPI backend. At runtime, nginx
serves the SPA and proxies `/api/*` to uvicorn; tini is PID 1; supervisord
manages both processes.

## Build

From the repository root:

```
docker build -f docker/Dockerfile -t squidpy-viewer .
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
  --name squidpy-viewer \
  -p 8080:80 \
  -v "$(pwd)/test-data":/data:ro \
  -v sqv-checkpoints:/checkpoints \
  -e SQV_CONTAINER_MEM_MB=12288 \
  -e SQV_WORKER_CEILING_MB=9216 \
  -e SQV_MAX_SESSIONS=4 \
  --memory=12g \
  squidpy-viewer
```

## Environment contract (DESIGN §19.9)

| Variable                 | Default   | Purpose |
|--------------------------|-----------|---------|
| `SQV_DATA_DIR`           | `/data`   | Read-only bind mount for input datasets |
| `SQV_CHECKPOINT_DIR`     | `/checkpoints` | Read-write volume for auto-checkpoints and saves |
| `SQV_CONTAINER_MEM_MB`   | `8192`    | Container cgroup memory limit in MiB. Set to match `--memory` / `mem_limit`. |
| `SQV_WORKER_CEILING_MB`  | `6144`    | Per-worker memory ceiling (must be < `SQV_CONTAINER_MEM_MB`). Triggers a catchable `MemoryError` before the OOM killer fires. |
| `SQV_ADMISSION_PCT`      | `0.80`    | Fraction of container RAM at which new jobs are refused. |
| `SQV_MAX_SESSIONS`       | `8`       | Maximum concurrent in-memory sessions. |
| `SQV_STATIC_DIR`         | `/app/spa`| Path to the compiled SPA (baked into the image). |

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

## Replacing the frontend placeholder

The current `frontend/` tree is a build placeholder (static HTML). When the
Vite frontend is ready:

1. Replace `frontend/` with the real Vite project.
2. Update `frontend/package.json` `"build"` script to `"vite build"` (or
   whatever the project uses).
3. Rebuild the image: `docker build -f docker/Dockerfile -t squidpy-viewer .`

No changes to `docker/Dockerfile`, `nginx.conf`, or `supervisord.conf` are
needed — Stage 1 runs `npm run build` and copies `frontend/dist/` regardless
of what generates it.
