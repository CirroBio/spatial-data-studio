"""Enumerate the app's saved checkpoints (`.sdata.zarr.zip`, the only thing save
writes) under DATA_DIR for the New Session load picker and the Cirro upload source
picker (`GET /api/fs/datasets`). Raw `.zarr` stores and foreign `.zarr.zip` bundles
are deliberately excluded — those are opened via Import Data's SpatialData reader,
not loaded as a session. Snapshot configs (`.sview.json`) and internal working
stores (`.rasters` caches, `.save-` staging) sharing DATA_DIR are skipped too.

The full recursive scan is cached and prewarmed at startup (see `prewarm.py`) so
the picker is instant on first open even on a large/slow mount. The cache is
invalidated whenever the app writes a checkpoint (`Session._write_checkpoint`),
so a just-saved session shows up the next time the picker opens.
"""
from __future__ import annotations

import os
from pathlib import Path

# Dirs never worth walking for datasets (vendored/build/staging; `_`-prefixed dirs
# like a reader's raw-bundle staging folder are skipped so their internal zarrs
# don't surface as loadable sessions).
_SKIP_SCAN_DIRS = {".git", "node_modules", "__pycache__", "venv", ".cache", "dist", "build"}
_DATASET_MAX_DEPTH = 4
_DATASET_CAP = 1000

# roots (as a tuple of strings) -> scanned dataset list.
_cache: dict[tuple[str, ...], list[dict]] = {}


def _mtime(p: Path) -> float:
    try:
        return os.path.getmtime(p)
    except OSError:
        return 0.0


def _scan(roots: list[Path]) -> list[dict]:
    """Recursively find the app's saved checkpoints under the roots (flat list)."""
    # Local import: keep this module free of the heavy spatialdata import store pulls
    # in, while still sourcing the checkpoint extension from one place.
    from .persistence.store import CHECKPOINT_EXT

    def rel(p: Path) -> str:
        for r in roots:
            try:
                return str(p.relative_to(r))
            except ValueError:
                continue
        return str(p)

    found: dict[str, dict] = {}
    for root in roots:
        base = len(root.parts)
        for dirpath, dirnames, filenames in os.walk(root):
            here = Path(dirpath)
            if len(here.parts) - base >= _DATASET_MAX_DEPTH:
                dirnames[:] = []
            keep = []
            for name in sorted(dirnames, key=str.lower):
                # `.rasters` dirs are the app's own transient tile-cache stores under
                # the checkpoint mount (rasters.normalize_rasters) — internal working
                # data, never a loadable checkpoint.
                if name.startswith((".", "_")) or name in _SKIP_SCAN_DIRS or name.endswith(".rasters"):
                    continue
                # A raw `.zarr` store isn't an app-written checkpoint; never descend
                # into one (it's openable via Import Data's SpatialData reader).
                if name.endswith(".zarr"):
                    continue
                keep.append(name)
            dirnames[:] = keep
            for name in filenames:
                if name.endswith(CHECKPOINT_EXT):
                    full = here / name
                    found.setdefault(str(full.resolve()),
                                     {"name": rel(full), "path": str(full), "mtime": _mtime(full)})
            if len(found) >= _DATASET_CAP:
                break
    # Newest first: saved sessions the user just wrote surface at the top.
    return sorted(found.values(), key=lambda e: e["mtime"], reverse=True)


def list_datasets(roots: list[Path], force_refresh: bool = False) -> list[dict]:
    key = tuple(str(r) for r in roots)
    if force_refresh or key not in _cache:
        _cache[key] = _scan(roots)
    return _cache[key]


def invalidate() -> None:
    """Drop the cached scan so the next `list_datasets` rescans — called whenever a
    checkpoint is written, so a just-saved session isn't hidden by a stale cache."""
    _cache.clear()
