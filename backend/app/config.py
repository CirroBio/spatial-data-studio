import os
from pathlib import Path


def _mb(env: str, default_mb: int) -> int:
    return int(os.environ.get(env, default_mb))


class Config:
    # Data mounts (DESIGN §19.9)
    DATA_DIR = Path(os.environ.get("SQV_DATA_DIR", "/data"))            # read mount (inputs)
    CHECKPOINT_DIR = Path(os.environ.get("SQV_CHECKPOINT_DIR", "/checkpoints"))  # rw mount

    # Memory accounting (DESIGN §11, §19.5) — evaluated against the container limit.
    CONTAINER_MEM_MB = _mb("SQV_CONTAINER_MEM_MB", 8192)
    WORKER_CEILING_MB = _mb("SQV_WORKER_CEILING_MB", 6144)   # < container limit
    ADMISSION_PCT = float(os.environ.get("SQV_ADMISSION_PCT", "0.80"))  # 80% boundary rule

    MAX_SESSIONS = int(os.environ.get("SQV_MAX_SESSIONS", "8"))

    RESOURCE_HZ = float(os.environ.get("SQV_RESOURCE_HZ", "2"))   # resource sample cadence
    LONG_RUNNING_S = float(os.environ.get("SQV_LONG_RUNNING_S", "120"))  # watchdog threshold

    STATIC_DIR = Path(os.environ.get("SQV_STATIC_DIR", "")) or None  # built SPA, optional


config = Config()
try:
    config.CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    pass  # read-only or unavailable mount; save endpoints surface the error per-call
