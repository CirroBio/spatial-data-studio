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

    # Default for thread-count form params (n_jobs etc.): SQUIDPY_N_THREADS if set,
    # else all cores on the machine.
    N_THREADS = int(os.environ.get("SQUIDPY_N_THREADS", os.cpu_count() or 1))

    RESOURCE_HZ = float(os.environ.get("SQV_RESOURCE_HZ", "2"))   # resource sample cadence
    LONG_RUNNING_S = float(os.environ.get("SQV_LONG_RUNNING_S", "120"))  # watchdog threshold

    STATIC_DIR = Path(os.environ.get("SQV_STATIC_DIR", "")) or None  # built SPA, optional

    # ---- AI / Bedrock (v3 Parts 6-8). AI is strictly additive; off by default. ----
    AI_ENABLED = os.environ.get("AI_ENABLED", "false").lower() in ("1", "true", "yes")
    AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
    BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "")
    AI_PROVIDER = os.environ.get("AI_PROVIDER", "bedrock")  # bedrock | mock (mock for tests)
    CONTEXT_TOKEN_LIMIT = int(os.environ.get("SQV_CONTEXT_TOKEN_LIMIT", "6000"))
    CONTEXT_KEEP_RECENT_N = int(os.environ.get("SQV_CONTEXT_KEEP_RECENT_N", "8"))
    AI_MAX_TOOL_ITERS = int(os.environ.get("SQV_AI_MAX_TOOL_ITERS", "8"))

    def ai_enabled(self) -> bool:
        """True when the chat surface should light up: explicitly enabled and either
        the mock provider or a configured Bedrock model id."""
        if not self.AI_ENABLED:
            return False
        return self.AI_PROVIDER == "mock" or bool(self.BEDROCK_MODEL_ID)


config = Config()
try:
    config.CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    pass  # read-only or unavailable mount; save endpoints surface the error per-call
