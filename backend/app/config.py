import os
from pathlib import Path


def _mb(env: str, default_mb: int) -> int:
    return int(os.environ.get(env, default_mb))


class Config:
    # Single data directory (DESIGN §19.9). Everything on disk lives here, read-write:
    # raw inputs the user imports, saved checkpoints (<name>-<hash>.sdata.zarr.zip),
    # and snapshot configs (<name>-<hash>.sview.json). Internal working stores
    # (per-session raster caches, save-staging tempdirs) are dot-/suffix-prefixed here
    # and are skipped by the dataset scanner and never served by name.
    DATA_DIR = Path(os.environ.get("SDS_DATA_DIR", "/data"))

    # Memory accounting (DESIGN §11, §19.5) — evaluated against the container limit.
    CONTAINER_MEM_MB = _mb("SDS_CONTAINER_MEM_MB", 8192)
    WORKER_CEILING_MB = _mb("SDS_WORKER_CEILING_MB", 6144)   # < container limit
    ADMISSION_PCT = float(os.environ.get("SDS_ADMISSION_PCT", "0.80"))  # 80% boundary rule

    MAX_SESSIONS = int(os.environ.get("SDS_MAX_SESSIONS", "8"))

    # Max image tiles/thumbnails composited at once. A zoom/pan burst asks for many
    # tiles simultaneously, and each finest-level tile can realize a full multi-MB
    # pyramid chunk; this caps the concurrent transient so the burst can't OOM.
    IMAGE_RENDER_CONCURRENCY = int(os.environ.get("SDS_IMAGE_RENDER_CONCURRENCY", "2"))

    # Raster (image/label) tiling normalized at ingest (see rasters.py). Every
    # element is rebuilt into a 2x multiscale pyramid down to a <= RASTER_BASE_PX
    # base, chunked at imaging.TILE_SIZE so one tile realizes one small chunk.
    # The rebuild reads each element once; a small dask pool bounds its peak RSS.
    RASTER_BASE_PX = int(os.environ.get("SDS_RASTER_BASE_PX", "1024"))
    RASTER_REBUILD_WORKERS = int(os.environ.get("SDS_RASTER_REBUILD_WORKERS", "2"))

    # Default for thread-count form params (n_jobs etc.): SDS_N_THREADS if set,
    # else all cores on the machine.
    N_THREADS = int(os.environ.get("SDS_N_THREADS", os.cpu_count() or 1))

    # Worker processes that run the actual squidpy/scanpy call (registry/kernel.py),
    # keeping the CPU-bound work off the API process's GIL so unrelated requests
    # (recipe list, other sessions) stay responsive during a long compute. Small by
    # design — this is a single-user local tool, not a multi-tenant service.
    COMPUTE_POOL_WORKERS = int(os.environ.get("SDS_COMPUTE_POOL_WORKERS", "2"))

    RESOURCE_HZ = float(os.environ.get("SDS_RESOURCE_HZ", "2"))   # resource sample cadence
    LONG_RUNNING_S = float(os.environ.get("SDS_LONG_RUNNING_S", "120"))  # watchdog threshold

    STATIC_DIR = Path(os.environ.get("SDS_STATIC_DIR", "")) or None  # built SPA, optional

    # Built standalone snapshot viewer (frontend `npm run build:viewer` -> dist-viewer/).
    # Copied into a Cirro upload bundle when snapshots are included, so the dataset
    # ships a self-contained web page that renders its snapshots. Defaults to the
    # repo's frontend/dist-viewer relative to this file.
    SNAPSHOT_VIEWER_DIR = Path(os.environ.get(
        "SDS_SNAPSHOT_VIEWER_DIR",
        str(Path(__file__).resolve().parents[2] / "frontend" / "dist-viewer")))

    # ---- Cirro upload. Strictly additive; off unless all three vars are set. ----
    CIRRO_BASE_URL = os.environ.get("CIRRO_BASE_URL", "")
    CIRRO_CLIENT_ID = os.environ.get("CIRRO_CLIENT_ID", "")
    CIRRO_CLIENT_SECRET = os.environ.get("CIRRO_CLIENT_SECRET", "")

    def cirro_enabled(self) -> bool:
        """True only when a service-account (client-credentials) identity is fully
        configured. No partial/interactive fallback — dark unless all three are set."""
        return bool(self.CIRRO_BASE_URL and self.CIRRO_CLIENT_ID and self.CIRRO_CLIENT_SECRET)


config = Config()
try:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    pass  # read-only or unavailable mount; save endpoints surface the error per-call


# ---- data-root allowlist. Everything the app touches on disk — imports, loads,
# saves, snapshots, Cirro upload source — must resolve under the single DATA_DIR;
# a client can never point a path at an arbitrary location. ----
def _existing_root(p: Path) -> Path | None:
    try:
        rp = p.resolve()
    except OSError:
        return None
    return rp if rp.exists() and rp.is_dir() else None


def data_roots() -> list[Path]:
    """The single data directory (import browsing, the load picker, Cirro upload
    source). Empty when the dir does not exist."""
    rp = _existing_root(config.DATA_DIR)
    return [rp] if rp else []


def _within_dir(target: Path, root: Path) -> bool:
    root = root.resolve()
    return target == root or root in target.parents


def within_data_dir(target: Path) -> bool:
    """True if `target` is DATA_DIR or somewhere beneath it — the only on-disk
    location the app may read (imports/loads) or write (saves/snapshots)."""
    return _within_dir(target, config.DATA_DIR)
