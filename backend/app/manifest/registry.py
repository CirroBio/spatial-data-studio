"""The manifest contributor registry (v3 Part 3.1).

A contributor is `fn(session) -> str | None` appending one labeled text block
(None = the facet is absent). New contributors register via `@contributor(label)`
without touching the assembler — the same extensibility model as the term
dictionary. `build_manifest` is lock-agnostic: callers hold the appropriate
session lock (the worker already holds the write lock during a call; the agent
meta-tool acquires a read lock).
"""
from __future__ import annotations

import logging

_CONTRIBUTORS: list[tuple[str, callable]] = []
_log = logging.getLogger(__name__)


def contributor(label: str):
    def deco(fn):
        _CONTRIBUTORS.append((label, fn))
        return fn
    return deco


def _blocks(session) -> list[tuple[str, str]]:
    out = []
    for label, fn in _CONTRIBUTORS:
        try:
            text = fn(session)
        except Exception as e:  # one bad facet must not blind the agent to the rest
            _log.warning("manifest contributor %s failed: %s", label, e)
            continue
        if text:
            out.append((label, text.rstrip()))
    return out


def build_manifest(session) -> str:
    return "\n\n".join(f"## {label}\n{text}" for label, text in _blocks(session))


def manifest_delta(session, previous_blocks: dict[str, str]) -> tuple[str, dict[str, str]]:
    """Return (delta_text, current_blocks). Only blocks whose text changed since
    `previous_blocks` are emitted (v3 Part 7.4). `current_blocks` is fed back next
    turn as `previous_blocks`."""
    current = dict(_blocks(session))
    changed = [(label, text) for label, text in current.items() if previous_blocks.get(label) != text]
    dropped = [label for label in previous_blocks if label not in current]
    parts = [f"## {label} (changed)\n{text}" for label, text in changed]
    parts += [f"## {label} (removed)" for label in dropped]
    return ("\n\n".join(parts) or "(no changes)"), current
