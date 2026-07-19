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

# Copy built SPA from stage 1 into the static dir that uvicorn (and nginx) serves
COPY --from=spa-builder /build/frontend/dist /app/spa

# nginx config and supervisord config
COPY docker/nginx.conf     /etc/nginx/nginx.conf
COPY docker/supervisord.conf /etc/supervisor/conf.d/spatial-data-studio.conf

# Create the volume mountpoint so Docker can bind-mount without root issues
RUN mkdir -p /data

# Expose the edge port
EXPOSE 80

# Runtime env defaults (overridden in docker-compose or docker run -e).
# SDS_DATA_DIR is the single read-write data dir (inputs + checkpoints + snapshots).
ENV SDS_STATIC_DIR=/app/spa \
    SDS_DATA_DIR=/data \
    SDS_CONTAINER_MEM_MB=8192 \
    SDS_WORKER_CEILING_MB=6144 \
    SDS_MAX_SESSIONS=8 \
    SDS_ADMISSION_PCT=0.80 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg

# tini as PID 1; supervisor is the main process
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf", "-n"]

# Liveness check — generous: 5 s start period, 30 s interval, 3 retries
# This matches DESIGN §19.8 ("tolerate several consecutive misses")
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -sf http://127.0.0.1/api/healthz || exit 1
