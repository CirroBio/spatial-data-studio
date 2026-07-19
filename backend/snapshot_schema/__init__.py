"""Structural signature of the snapshot config (`<name>.sview.json`), frozen once
per published viewer version so a schema change can't ship silently.

`schema_signature(config)` reduces an emitted config to the SHAPE of its keys — a
sorted set of dotted leaf key-paths — with data collapsed out:

- Nested dicts are recursed into; lists, scalars and None are opaque leaves (a
  path ends at the key holding them). So `render.image` present-as-dict yields
  `render.image.element`, `render.image.height`, ... while a `null` image would
  yield the single leaf `render.image` instead — the shape, not the value.
- Value-keyed maps (a non-empty dict whose keys are ALL decimal-digit strings,
  i.e. channel-index maps like `render.channels` / `encoding.channels`) have their
  dynamic keys normalized to `*`, so `render.channels.0.visible` and
  `render.channels.7.visible` both fold to `render.channels.*.visible`. The
  signature is about shape, not how many channels a particular dataset has.

The SAME helper generates each `snapshot_schema/<version>.json` golden and checks
it (in `test_schema_gate.py` and `test_e2e.run_snapshot_flow`), so the frozen file
and the live signature can never drift apart.
"""
from __future__ import annotations

import json
from pathlib import Path

SCHEMA_DIR = Path(__file__).resolve().parent

WILDCARD = "*"


def _is_channel_map(d: dict) -> bool:
    """A value-keyed map: keyed by channel index (all decimal-digit string keys),
    not by fixed field names. Its keys are data, so they collapse to `*`."""
    return bool(d) and all(isinstance(k, str) and k.isdigit() for k in d)


def _walk(node, prefix: str, out: set[str]) -> None:
    if isinstance(node, dict):
        if not node:
            return  # empty dict contributes no shape
        channel_map = _is_channel_map(node)
        for key, value in node.items():
            seg = WILDCARD if channel_map else key
            child = f"{prefix}.{seg}" if prefix else seg
            _walk(value, child, out)
    else:
        # lists / scalars / None are opaque leaves — path ends here.
        out.add(prefix)


def schema_signature(config: dict) -> list[str]:
    """Sorted, de-duplicated dotted leaf key-paths of `config` (see module docstring)."""
    out: set[str] = set()
    _walk(config, "", out)
    return sorted(out)


def golden_path(version: str) -> Path:
    return SCHEMA_DIR / f"{version}.json"


def load_golden(version: str) -> list[str]:
    """The frozen signature for `version`. Raises FileNotFoundError if the version
    was bumped without adding its immutable golden."""
    return json.loads(golden_path(version).read_text())
