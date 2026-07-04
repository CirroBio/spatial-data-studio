import os
from pathlib import Path


def _mb(env: str, default_mb: int) -> int:
    return int(os.environ.get(env, default_mb))


class Config:
    # Data mounts (DESIGN §19.9)
    DATA_DIR = Path(os.environ.get("SQV_DATA_DIR", "/data"))            # read mount (inputs)
    CHECKPOINT_DIR = Path(os.environ.get("SQV_CHECKPOINT_DIR", "/checkpoints"))  # rw mount
    SNAPSHOTS_DIR = Path(os.environ.get("SQV_SNAPSHOTS_DIR", "/checkpoints/snapshots"))  # v3 Part 9

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

    _bedrock_ready_cache = None

    def ai_enabled(self) -> bool:
        """True only when the chat surface should light up (v3 Part 8.2). Requires
        AI_ENABLED and either the explicit `mock` dev provider, or — for real
        Bedrock — a configured model id AND resolvable AWS credentials. No creds =>
        dark, even if a model id is set."""
        if not self.AI_ENABLED:
            return False
        if self.AI_PROVIDER == "mock":
            return True
        return bool(self.BEDROCK_MODEL_ID) and self._bedrock_credentials_available()

    def _bedrock_credentials_available(self) -> bool:
        if self._bedrock_ready_cache is None:
            try:
                import boto3
                self._bedrock_ready_cache = (
                    boto3.Session(region_name=self.AWS_REGION).get_credentials() is not None)
            except Exception:
                self._bedrock_ready_cache = False
        return self._bedrock_ready_cache

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


# ---- shared data-root allowlist (used by both the fs/browse API and session
# load-admission, so a client can never point either at an arbitrary path) ----
def browse_roots() -> list[Path]:
    seen, roots = set(), []
    # The process CWD is included so datasets sitting in folders under wherever the
    # server was launched are discoverable without configuring SQV_DATA_DIR.
    for p in (config.DATA_DIR, config.CHECKPOINT_DIR, Path.cwd()):
        try:
            rp = p.resolve()
        except OSError:
            continue
        if rp.exists() and rp.is_dir() and rp not in seen:
            seen.add(rp)
            roots.append(rp)
    return roots


def within_roots(target: Path, roots: list[Path]) -> bool:
    return any(target == r or r in target.parents for r in roots)
