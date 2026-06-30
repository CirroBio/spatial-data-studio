"""Snapshots: a self-contained read-only HTML view of the current display, with
content-hashed Arrow/tile assets (v3 Part 9). The capture + read-only viewer are
built out separately; this module is the backend entry point the gear menu, the
canvas toolbar, and the agent's save_snapshot tool call into."""
from __future__ import annotations

import os

from .config import config

_SNAPSHOTS_DIR = os.environ.get("SQV_SNAPSHOTS_DIR", str(getattr(config, "CHECKPOINT_DIR", "/checkpoints")))


def list_snapshots(session) -> list[dict]:
    d = _SNAPSHOTS_DIR
    if not os.path.isdir(d):
        return []
    return [{"name": f} for f in sorted(os.listdir(d)) if f.endswith(".html")]


def save_snapshot(session, label: str | None = None) -> dict:
    return {"status": "unavailable",
            "error": "snapshot capture is performed from the viewer; not available as a backend action yet"}
