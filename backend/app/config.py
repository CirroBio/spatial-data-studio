import json
import os
from pathlib import Path

# Single source of truth for the shared snapshot viewer: /snapshot-viewer.json at
# the repo root (parents[2] from backend/app/). `version` pins the published viewer
# bundle; `pagesBaseUrl` is its GitHub Pages origin. Every saved snapshot's HTML
# points at `${pagesBaseUrl}/viewer/${version}/app.js`, so old snapshots keep
# loading their exact viewer version even after the schema evolves.
_SNAPSHOT_VIEWER_JSON = Path(__file__).resolve().parents[2] / "snapshot-viewer.json"
_viewer_meta = json.loads(_SNAPSHOT_VIEWER_JSON.read_text())


def _mb(env: str, default_mb: int) -> int:
    return int(os.environ.get(env, default_mb))


class Config:
    # Single data directory (DESIGN §19.9). Everything on disk lives here, read-write:
    # raw inputs the user imports, saved checkpoints (<name>-<hash>.sdata.zarr.zip),
    # and snapshot configs (<name>-<hash>.sview.json). Internal working stores
    # (per-session raster caches, save-staging tempdirs) are dot-/suffix-prefixed here
    # and are skipped by the dataset scanner and never served by name.
    # Defaults to the invoking user's home ($HOME), where the deployment environment
    # mounts datasets (e.g. $HOME/datasets); override with SDS_DATA_DIR.
    DATA_DIR = Path(os.environ.get("SDS_DATA_DIR") or Path.home())

    # Memory accounting (DESIGN §11, §19.5) — evaluated against the container limit.
    CONTAINER_MEM_MB = _mb("SDS_CONTAINER_MEM_MB", 8192)
    WORKER_CEILING_MB = _mb("SDS_WORKER_CEILING_MB", 6144)   # < container limit
    ADMISSION_PCT = float(os.environ.get("SDS_ADMISSION_PCT", "0.80"))  # 80% boundary rule

    MAX_SESSIONS = int(os.environ.get("SDS_MAX_SESSIONS", "8"))

    # Max image tiles/thumbnails composited at once. A zoom/pan burst asks for many
    # tiles simultaneously, and each finest-level tile can realize a full multi-MB
    # pyramid chunk; this caps the concurrent transient so the burst can't OOM.
    IMAGE_RENDER_CONCURRENCY = int(os.environ.get("SDS_IMAGE_RENDER_CONCURRENCY", "2"))

    # Client-side (Viv) image compositing. When on, the /image/{element}/info manifest
    # advertises that the browser may read the session's on-disk normalized raster zarr
    # directly (via /api/sessions/{sid}/raster/...) and composite channels on the GPU,
    # instead of fetching server-composited PNG tiles. The PNG tile path stays intact as
    # the fallback (used whenever this is off, the element has no served store, or its
    # channel count exceeds the cap). Viv composites up to 6 channels per shader pass;
    # above that the frontend falls back to PNG.
    #
    # Default ON (disable with SDS_CLIENT_IMAGE_COMPOSITING=0). The client path streams
    # full-resolution tiles: the frontend (useVivImageLayer.ts) reuses the PNG path's
    # world-coordinate tile selection and renders a Viv XRLayer per visible tile over a
    # coarse base, so deep zoom shows full detail. Verified live: single- and multi-channel
    # fluorescence (additive-on-black), RGB/H&E true-color passthrough, deep-zoom streaming,
    # and image<->points alignment. It does NOT use Viv's tiled MultiscaleImageLayer, whose
    # deck.gl TileLayer silently fetches no tiles under a non-unit pixel->world modelMatrix
    # scale. The PNG tile path stays intact as the fallback (this flag off, an element with
    # no served store, or channel count over the cap below). See DESIGN.md 9.4.
    CLIENT_IMAGE_COMPOSITING = os.environ.get("SDS_CLIENT_IMAGE_COMPOSITING", "1") not in ("0", "false", "False")
    CLIENT_IMAGE_MAX_CHANNELS = int(os.environ.get("SDS_CLIENT_IMAGE_MAX_CHANNELS", "6"))

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

    # Shared snapshot viewer, read from /snapshot-viewer.json (see above). Snapshots
    # embed SNAPSHOT_VIEWER_VERSION in their `schema_version` and load app.js from the
    # version-pinned GitHub Pages URL; no viewer code is bundled or served locally.
    SNAPSHOT_VIEWER_VERSION = _viewer_meta["version"]
    SNAPSHOT_VIEWER_PAGES_URL = _viewer_meta["pagesBaseUrl"]
    SNAPSHOT_VIEWER_APP_JS = f"{_viewer_meta['pagesBaseUrl']}/viewer/{_viewer_meta['version']}/app.js"

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
