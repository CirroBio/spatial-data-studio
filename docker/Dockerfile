# ---------------------------------------------------------------------------
# Stage 1: build the React/TS SPA
# ---------------------------------------------------------------------------
FROM node:22-slim AS spa-builder

WORKDIR /build/frontend

# Copy manifest files first so the install layer is cached across source-only changes.
# Copies package-lock.json too when present (real Vite project); placeholder has none.
COPY frontend/package.json ./
COPY frontend/package-lock.json* ./

# Use npm ci when a lockfile exists (deterministic, faster); fall back to npm install
# for the placeholder build that ships without a lockfile.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY frontend/ ./
RUN npm run build

# Verify the output exists
RUN test -f dist/index.html


# ---------------------------------------------------------------------------
# Stage 2: Python runtime
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

# OS libraries required by scientific wheels and OpenGL-backed squidpy/spatialdata
# - libgl1 / libglib2.0-0: OpenGL context needed by some squidpy image functions
# - libgomp1: OpenMP runtime (numpy/scipy BLAS)
# - build-essential / gcc: compile any wheel that ships source-only
# - curl: used by the HEALTHCHECK
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        nginx \
        supervisor \
        tini \
        curl \
    && rm -rf /var/lib/apt/lists/*

# uv (pinned) as the installer: much faster than pip and deterministic against the
# fully-pinned requirements.txt. Copied from the official image so no bootstrap pip.
COPY --from=ghcr.io/astral-sh/uv:0.5.16 /uv /uvx /bin/

# Install Python deps before copying app code so this layer is cached across
# app-code-only changes.
WORKDIR /app
COPY backend/requirements.txt ./requirements.txt
# celltypist declares a hard dependency on the GPL Leiden chain (leidenalg ->
# igraph). This app never uses that code path (it clusters via graspologic-native,
# MIT), so strip the copyleft packages after install to keep the image GPL-free.
# Install + strip are one layer so the sealed image never contains them; the
# license gate (sds-governance/scan_licenses.py) fails if they reappear.
RUN uv pip install --system --no-cache -r requirements.txt \
    && uv pip uninstall --system leidenalg igraph

# Copy backend source
COPY backend/ ./backend/

# Single source of truth for the snapshot viewer version/base URL. backend/app/config.py
# reads it from the app root (parents[2] of config.py == /app), so it must sit at /app.
COPY snapshot-viewer.json ./snapshot-viewer.json

# Copy built SPA from stage 1 into the static dir that uvicorn (and nginx) serves
COPY --from=spa-builder /build/frontend/dist /app/spa

# nginx config and supervisord config
COPY docker/nginx.conf     /etc/nginx/nginx.conf
COPY docker/supervisord.conf /etc/supervisor/conf.d/spatial-data-studio.conf

# Home directory for the app. SDS_DATA_DIR defaults to $HOME (backend/app/config.py),
# where the deployment environment mounts datasets (e.g. $HOME/datasets). Create it and
# run from it so the app reads/writes there when no external volume is mounted over it.
ENV HOME=/home/cirro
RUN mkdir -p "$HOME"
WORKDIR $HOME

# Expose the edge port (nginx)
EXPOSE 8888

# Runtime env defaults (overridden in docker-compose or docker run -e). SDS_DATA_DIR is
# left unset so it defaults to $HOME (the single read-write data dir: inputs + checkpoints
# + snapshots). SDS_CONTAINER_MEM_MB is left unset so the memory limit auto-detects from
# the container cgroup (ECS task memory / `--memory` / `mem_limit`); set it only to override.
ENV SDS_STATIC_DIR=/app/spa \
    SDS_WORKER_CEILING_MB=6144 \
    SDS_MAX_SESSIONS=8 \
    SDS_ADMISSION_PCT=0.80 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg

# tini as PID 1; supervisor is the main process
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf", "-n"]

# Readiness check — generous: 60 s start period, 30 s interval, 3 retries
# This matches DESIGN §19.8 ("tolerate several consecutive misses"). Probes
# /api/readyz (not /api/healthz) so the container reports healthy only once the
# operation registry has finished building and requests will actually succeed;
# the 60 s start period covers that build window.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -sf http://127.0.0.1:8888/api/readyz || exit 1
