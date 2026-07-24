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


def _cgroup_cpu_limit() -> float | None:
    """The container's CPU hard-limit in (possibly fractional) cores, read from the CFS
    quota the kernel scheduler enforces (cgroup v2 `cpu.max`, then v1
    `cpu.cfs_quota_us`/`cpu.cfs_period_us`), or None when no quota is set. An ECS
    task-level `cpu`, Fargate task `cpu`, and `docker run --cpus` all surface here as
    quota/period. We deliberately ignore CPU *shares* (v2 `cpu.weight`, v1 `cpu.shares`,
    what an ECS *container-level* `cpu` sets): shares are a relative scheduling weight
    under contention, not a hard cap, and can't be turned into a core count. v2 `cpu.max`
    is "<quota> <period>" or "max <period>" when unlimited; v1 quota is -1 when unlimited."""
    try:
        parts = Path("/sys/fs/cgroup/cpu.max").read_text().split()  # cgroup v2
    except OSError:
        parts = None
    if parts:
        if parts[0] == "max":
            return None
        quota, period = int(parts[0]), int(parts[1])
        return quota / period if quota > 0 and period > 0 else None
    try:  # cgroup v1
        quota = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read_text().strip())
        period = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read_text().strip())
    except OSError:
        return None
    return quota / period if quota > 0 and period > 0 else None


def _container_cpus() -> tuple[float, str]:
    """(CPU cores available, source) used to size the compute pool and per-op thread
    budgets. An explicit SDS_CONTAINER_CPUS wins. Otherwise use the cgroup CFS quota —
    the hard cap an ECS task `cpu` / `docker --cpus` imposes — so a task limited to 2
    vCPU on a 16-core instance sizes to 2, not 16 (host `os.cpu_count()` ignores the
    quota and would oversubscribe). With no quota (an ECS EC2 task with only a
    container-level `cpu` share, `docker run` without `--cpus`) the container may use
    every host core, so fall back to `os.cpu_count()`. 1.0 is the last resort."""
    env = os.environ.get("SDS_CONTAINER_CPUS")
    if env is not None:
        return float(env), "SDS_CONTAINER_CPUS"
    detected = _cgroup_cpu_limit()
    if detected is not None:
        return detected, "cgroup"
    host = os.cpu_count()
    if host:
        return float(host), "host cpu_count (no cgroup quota)"
    return 1.0, "default (no cgroup quota, host cpu_count unknown)"


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

    # CPU cores the container may actually use — the single source of truth for sizing
    # every CPU-bound pool/thread budget below. Auto-detected from the cgroup CFS quota
    # (an ECS task `cpu` / `docker --cpus`) so a CPU-limited task doesn't size to the
    # host's core count; falls back to os.cpu_count() when there is no quota. Rounded
    # only where an integer worker/thread count is needed (see below); kept as a float
    # here so the resource strip can show "cores used / cores available".
    CPU_LIMIT, CPU_LIMIT_SOURCE = _container_cpus()
    _CPU_INT = max(1, round(CPU_LIMIT))  # integer core budget for worker/thread counts

    MAX_SESSIONS = int(os.environ.get("SDS_MAX_SESSIONS", "8"))

    # Max image tiles/thumbnails composited at once. A zoom/pan burst asks for many
    # tiles simultaneously, and each finest-level tile can realize a full multi-MB
    # pyramid chunk; this caps the concurrent transient so the burst can't OOM.
    # Scales with the CPU allocation by default (compositing is CPU-bound) rather than a
    # fixed small number, so a bigger deployment gets more parallelism without a config
    # change; override down via the env var on a memory-constrained container.
    IMAGE_RENDER_CONCURRENCY = int(os.environ.get("SDS_IMAGE_RENDER_CONCURRENCY", str(_CPU_INT)))

    # Client-side (Viv) image compositing — the only canvas image path. When on, the
    # /image/{element}/info manifest advertises that the browser reads the session's
    # on-disk normalized raster zarr directly (via /api/sessions/{sid}/raster/...) and
    # composites channels on the GPU. The frontend displays up to 6 channels at once
    # (Viv's shader-pass limit; the channel picker caps it) and lets the user pick which
    # of a >6-channel image's channels to show. Default ON; disable with
    # SDS_CLIENT_IMAGE_COMPOSITING=0 only to turn the canvas image off entirely (there is
    # no server-composited canvas fallback anymore). See DESIGN.md 9.4.
    CLIENT_IMAGE_COMPOSITING = os.environ.get("SDS_CLIENT_IMAGE_COMPOSITING", "1") not in ("0", "false", "False")

    # Raster (image/label) tiling normalized at ingest (see rasters.py). Every
    # element is rebuilt into a 2x multiscale pyramid down to a <= RASTER_BASE_PX
    # base, chunked at imaging.TILE_SIZE so one tile realizes one small chunk.
    # Rasters rebuild one element at a time (peak RSS bounded by the largest single
    # element, not by this), so more worker threads just chews through one element's
    # chunks faster — scales with the CPU allocation by default, same reasoning as
    # IMAGE_RENDER_CONCURRENCY above.
    RASTER_BASE_PX = int(os.environ.get("SDS_RASTER_BASE_PX", "1024"))
    RASTER_REBUILD_WORKERS = int(os.environ.get("SDS_RASTER_REBUILD_WORKERS", str(_CPU_INT)))

    # Server-side LRU (MB) of raw Viv chunk bytes read by the client-compositing path
    # (main.py raster_store). Caps repeat-view reads of the same chunk under the read
    # lock; the bytes live in the API-process heap so they count against RSS/admission.
    # 0 disables the cache. See imaging._raster_chunk_cache.
    RASTER_CHUNK_CACHE_MB = int(os.environ.get("SDS_RASTER_CHUNK_CACHE_MB", "256"))

    # Default for thread-count form params (n_jobs etc.): SDS_N_THREADS if set, else the
    # CPU allocation, so one operation can use every allocated core (the main lever for
    # a single job's CPU utilization) without oversubscribing a CPU-limited task.
    N_THREADS = int(os.environ.get("SDS_N_THREADS", str(_CPU_INT)))

    # Worker processes that run the actual squidpy/scanpy call (registry/kernel.py),
    # keeping the CPU-bound work off the API process's GIL so unrelated requests
    # (recipe list, other sessions) stay responsive during a long compute. Defaults to
    # the CPU allocation so concurrent jobs/sessions can spread across the allocated
    # cores instead of a fixed pair; override down with SDS_COMPUTE_POOL_WORKERS.
    COMPUTE_POOL_WORKERS = int(os.environ.get("SDS_COMPUTE_POOL_WORKERS", str(_CPU_INT)))

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
