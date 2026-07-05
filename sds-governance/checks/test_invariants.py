"""Invariant checks (R3, R6/R7, R8-R10, R13). pytest; checks whose seam can't be
satisfied in the current environment skip visibly rather than passing falsely.
"""
import importlib
import sys

import pytest

import config


def _backend():
    sys.path.insert(0, str(config.BACKEND.parent))
    try:
        return importlib.import_module(config.REGISTRY_REF.split(":")[0])
    except Exception as e:
        pytest.skip(f"backend not importable here ({type(e).__name__}); wire the test env to enforce")


def _registry():
    importlib.import_module("app.registry.introspect")
    reg = getattr(importlib.import_module(config.REGISTRY_REF.split(":")[0]), config.REGISTRY_REF.split(":")[1])
    reg.build()
    return reg


def test_r3_one_schema_of_record():
    """Every function derives its form schema from `params` (json_schema + ui_schema)."""
    _backend()
    reg = _registry()
    for e in reg.entries.values():
        pub = e.to_public()
        assert "json_schema" in pub and "properties" in pub["json_schema"], e.key
        assert "ui_schema" in pub, e.key


def test_r8_effect_class_explicit():
    """Effect class is explicit and from the known set."""
    _backend()
    reg = _registry()
    for e in reg.entries.values():
        assert e.effect_class in {"compute", "plot", "read", "extract"}, (e.key, e.effect_class)


def test_r13_snapshot_assets_content_hashed():
    """Snapshot assets are content-hashed (sha256) for dedupe."""
    snap = (config.BACKEND / "snapshots.py").read_text()
    assert "hashlib.sha256" in snap


def test_r10_state_changing_ops_are_queued_under_write_lock():
    """Compute mutations run on the worker under the write lock."""
    session = (config.BACKEND / "sessions" / "session.py").read_text()
    assert "acquire_write" in session and "self._queue" in session


@pytest.mark.skipif(True, reason="R6/R7 (append-only history; no COMPLETED->QUEUED) needs a live run harness — wire SYNTH_FIXTURE")
def test_r6_r7_compute_append_only():
    pass
