import os
import tempfile
from pathlib import Path


def _cgroup_mem_limit_mb() -> int | None:
    """The container's memory hard-limit in MiB, read from the cgroup the kernel OOM
    killer actually enforces (cgroup v2 `memory.max`, then v1 `memory.limit_in_bytes`),
    or None when no limit is set. ECS (Fargate and EC2 launch types), `docker run
    --memory`, and Compose `mem_limit` all surface the task/container limit here. An
    unset limit reads as the literal "max" (v2) or a page-count sentinel near INT64_MAX
    (v1); both map to None. Assumes the container sees its own cgroup as the hierarchy
    root — true under the private cgroup namespace ECS and modern Docker use."""
    UNBOUNDED = 1 << 62  # v1 reports ~0x7ffffffffffff000 when unlimited
    for path in ("/sys/fs/cgroup/memory.max",                     # cgroup v2
                 "/sys/fs/cgroup/memory/memory.limit_in_bytes"):   # cgroup v1
        try:
            raw = Path(path).read_text().strip()
        except OSError:
            continue
        if raw == "max":
            return None
        try:
            nbytes = int(raw)
        except ValueError:
            continue
        return nbytes // (1024 * 1024) if 0 < nbytes < UNBOUNDED else None
    return None


def _host_mem_mb() -> int | None:
    """Total physical RAM in MiB, or None if it can't be read."""
    try:
        import psutil
        return int(psutil.virtual_memory().total // (1024 * 1024))
    except Exception:
        return None


def _container_mem_mb() -> tuple[int, str]:
    """(limit in MiB, source) for admission accounting. An explicit SDS_CONTAINER_MEM_MB
    wins — including 0, which disables the memory percentage (see manager._mem_fraction).
    Otherwise auto-detect from the cgroup hard-limit. When there is no hard limit — an
    ECS task with only a soft `memoryReservation`, `docker run` without `--memory` — the
    container may use the host's full RAM, so fall back to total physical memory (a 64 GiB
    box then admits against 64 GiB, not a stale 8 GiB default). 8192 MiB is a last resort
    only if physical memory can't be read."""
    env = os.environ.get("SDS_CONTAINER_MEM_MB")
    if env is not None:
        return int(env), "SDS_CONTAINER_MEM_MB"
    detected = _cgroup_mem_limit_mb()
    if detected is not None:
        return detected, "cgroup"
    host = _host_mem_mb()
    if host is not None:
        return host, "host physical memory (no cgroup limit)"
    return 8192, "default (no cgroup limit, host RAM unknown)"


class Config:
    # Single data directory (DESIGN §19.9). User-facing artifacts live here,
    # read-write: raw inputs the user imports, saved checkpoints
    # (<name>-<hash>.sdata.zarr.zip), and snapshot configs (<name>-<hash>.sview.json).
    # Save-staging tempdirs (`.save-`) are dot-prefixed here and skipped by the
    # dataset scanner; the atomic os.replace of a finished checkpoint stays a
    # same-filesystem rename because staging sits beside the destination. Transient
    # working stores (unpacked archives, per-session raster caches) live under
    # WORK_DIR, not here.
    # Defaults to the invoking user's home ($HOME), where the deployment environment
    # mounts datasets (e.g. $HOME/datasets); override with SDS_DATA_DIR.
    DATA_DIR = Path(os.environ.get("SDS_DATA_DIR") or Path.home())

    # Working directory for the live session working set: the unpacked `.zarr.zip`
    # extract dir (persistence/store.py) and the per-session normalized raster cache
    # (rasters.py). Kept separate from DATA_DIR so a transient `*.zarr` extract never
    # surfaces in the dataset picker (fs_browse lists `*.zarr` dirs as loadable), and
    # so the whole working set can be relocated with one knob. Defaults to the system
    # temp dir (where the extract dir already lived); point SDS_WORK_DIR at a sized
    # tmpfs mount to hold the working set in RAM for much faster tile/chunk reads.
    WORK_DIR = Path(os.environ.get("SDS_WORK_DIR") or tempfile.gettempdir())

    # Set when WORK_DIR is RAM-backed (tmpfs). tmpfs pages count against the cgroup
    # memory limit the OOM killer enforces but NOT against process RSS, so without
    # this the admission/boundary math (manager.py) can't see the working set and
    # would keep admitting loads/jobs/tile renders until the OOM killer fires. When
    # on, current WORK_DIR usage is added to RSS in that math (see manager._effective_mb).
    # Requires WORK_DIR to be a dedicated mount, so its statvfs usage is the app's own.
    WORK_DIR_IN_RAM = os.environ.get("SDS_WORK_DIR_IN_RAM", "0") not in ("0", "false", "False")

    # Memory accounting (DESIGN §11, §19.5) — evaluated against the container limit.
    # Auto-detected from the cgroup when SDS_CONTAINER_MEM_MB is unset, so an ECS task
    # (or `docker run --memory`) needs no separate env var; an explicit value overrides.
    CONTAINER_MEM_MB, CONTAINER_MEM_SOURCE = _container_mem_mb()
    ADMISSION_PCT = float(os.environ.get("SDS_ADMISSION_PCT", "0.80"))  # 80% boundary rule

    MAX_SESSIONS = int(os.environ.get("SDS_MAX_SESSIONS", "8"))

    # Max image tiles/thumbnails composited at once. A zoom/pan burst asks for many
    # tiles simultaneously, and each finest-level tile can realize a full multi-MB
    # pyramid chunk; this caps the concurrent transient so the burst can't OOM.
    # Scales with the box by default (more cores generally means more RAM too, and
    # compositing is CPU-bound) rather than a fixed small number, so a bigger
    # deployment actually gets more parallelism without a config change; override
    # down via the env var on a memory-constrained container.
    IMAGE_RENDER_CONCURRENCY = int(os.environ.get("SDS_IMAGE_RENDER_CONCURRENCY", str(os.cpu_count() or 4)))

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
    # Rasters rebuild one element at a time (peak RSS bounded by the largest single
    # element, not by this), so more worker threads just chews through one element's
    # chunks faster on a bigger box — scales with cores by default, same reasoning
    # as IMAGE_RENDER_CONCURRENCY above.
    RASTER_BASE_PX = int(os.environ.get("SDS_RASTER_BASE_PX", "1024"))
    RASTER_REBUILD_WORKERS = int(os.environ.get("SDS_RASTER_REBUILD_WORKERS", str(os.cpu_count() or 2)))

    # Server-side LRU (MB) of raw Viv chunk bytes read by the client-compositing path
    # (main.py raster_store). Caps repeat-view reads of the same chunk under the read
    # lock; the bytes live in the API-process heap so they count against RSS/admission.
    # 0 disables the cache. See imaging._raster_chunk_cache.
    RASTER_CHUNK_CACHE_MB = int(os.environ.get("SDS_RASTER_CHUNK_CACHE_MB", "256"))

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

    # Max time a read-only endpoint waits on the session read lock before giving up
    # with a fast 503 instead of hanging. Reads block while a compute/plot job holds
    # the write lock for its whole duration; behind a fronting proxy (e.g. CloudFront,
    # ~30s origin timeout) a longer block returns a 504 to the browser. Failing fast
    # under that limit turns the hang into a retryable 503 the frontend re-issues once
    # the job completes (via SSE). Keep comfortably below the proxy's timeout.
    READ_LOCK_TIMEOUT_S = float(os.environ.get("SDS_READ_LOCK_TIMEOUT_S", "25"))

    STATIC_DIR = Path(os.environ.get("SDS_STATIC_DIR", "")) or None  # built SPA, optional

    # ---- Cirro upload. Strictly additive; off unless all three vars are set. ----
    CIRRO_BASE_URL = os.environ.get("CIRRO_BASE_URL", "")
    CIRRO_CLIENT_ID = os.environ.get("CIRRO_CLIENT_ID", "")
    CIRRO_CLIENT_SECRET = os.environ.get("CIRRO_CLIENT_SECRET", "")

    def cirro_enabled(self) -> bool:
        """True only when a service-account (client-credentials) identity is fully
        configured. No partial/interactive fallback — dark unless all three are set."""
        return bool(self.CIRRO_BASE_URL and self.CIRRO_CLIENT_ID and self.CIRRO_CLIENT_SECRET)


config = Config()
for _dir in (config.DATA_DIR, config.WORK_DIR):
    try:
        _dir.mkdir(parents=True, exist_ok=True)
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
