import os
from pathlib import Path


def _mb(env: str, default_mb: int) -> int:
    return int(os.environ.get(env, default_mb))


class Config:
    # Data mounts (DESIGN §19.9)
    DATA_DIR = Path(os.environ.get("SDS_DATA_DIR", "/data"))            # read mount (inputs)
    CHECKPOINT_DIR = Path(os.environ.get("SDS_CHECKPOINT_DIR", "/checkpoints"))  # rw mount
    # Snapshots live under the checkpoint mount by default, so setting
    # SDS_CHECKPOINT_DIR alone is enough; override independently only if needed.
    SNAPSHOTS_DIR = Path(os.environ.get("SDS_SNAPSHOTS_DIR", str(CHECKPOINT_DIR / "snapshots")))  # v3 Part 9

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
    config.CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    pass  # read-only or unavailable mount; save endpoints surface the error per-call


# ---- data-root allowlists. Raw inputs and saved sessions live in strictly
# separate mounts: spatialdata-io readers may only read from DATA_DIR, and
# session load/save may only touch CHECKPOINT_DIR. A client can never point
# either flow at an arbitrary path, nor cross the two. ----
def _existing_root(p: Path) -> Path | None:
    try:
        rp = p.resolve()
    except OSError:
        return None
    return rp if rp.exists() and rp.is_dir() else None


def data_roots() -> list[Path]:
    """Read mount for raw inputs (spatialdata-io readers / import browsing)."""
    rp = _existing_root(config.DATA_DIR)
    return [rp] if rp else []


def checkpoint_roots() -> list[Path]:
    """RW mount for saved sessions (load, the dataset picker, Cirro upload source)."""
    rp = _existing_root(config.CHECKPOINT_DIR)
    return [rp] if rp else []


def _within_dir(target: Path, root: Path) -> bool:
    root = root.resolve()
    return target == root or root in target.parents


def within_data_dir(target: Path) -> bool:
    """True if `target` is DATA_DIR or somewhere beneath it (raw-input reads)."""
    return _within_dir(target, config.DATA_DIR)


def within_checkpoint_dir(target: Path) -> bool:
    """True if `target` is CHECKPOINT_DIR or somewhere beneath it (save / load /
    set-transform paths must land there)."""
    return _within_dir(target, config.CHECKPOINT_DIR)
