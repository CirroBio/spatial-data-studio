"""Invariant checks (R3, R6/R7, R8-R10, R13). pytest; checks whose seam can't be
satisfied in the current environment skip visibly rather than passing falsely.
"""
import ast
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
    """Snapshot assets are content-hashed (sha256) for dedupe.

    Executes the hashing rather than grepping for the string `hashlib.sha256`, which a
    comment mentioning it satisfied: two different payloads must land on different
    artifact base names and the same payload must reproduce its own."""
    _backend()
    snapshots = importlib.import_module("app.snapshots")
    digest = getattr(snapshots, "_content_hash", None)
    if digest is None:
        pytest.skip("app.snapshots exposes no _content_hash to exercise")
    a, b = digest(b"payload-a"), digest(b"payload-b")
    assert a != b, "distinct snapshot payloads collide on one artifact name"
    assert digest(b"payload-a") == a, "snapshot hash is not deterministic"
    assert len(a) >= 8 and all(c in "0123456789abcdef" for c in a), a


def test_r10_state_changing_ops_are_queued_under_write_lock():
    """Compute mutations run on the worker under the write lock.

    Walks `Session._run_call`'s AST for an actual `with self.lock.writing()` block, rather
    than grepping session.py for the substring `acquire_write` anywhere in the file — the
    previous form passed on any file that merely mentioned the name."""
    tree = ast.parse((config.BACKEND / "sessions" / "session.py").read_text())
    session_cls = next((n for n in ast.walk(tree)
                        if isinstance(n, ast.ClassDef) and n.name == "Session"), None)
    assert session_cls is not None, "Session class not found in sessions/session.py"
    run_call = next((n for n in session_cls.body
                     if isinstance(n, ast.FunctionDef) and n.name == "_run_call"), None)
    assert run_call is not None, "Session._run_call not found"

    def _is_write_lock(item) -> bool:
        call = item.context_expr
        return (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                and call.func.attr == "writing")

    guarded = [n for n in ast.walk(run_call)
               if isinstance(n, ast.With) and any(_is_write_lock(i) for i in n.items)]
    assert guarded, "Session._run_call commits without holding self.lock.writing()"

    # The mutation queue is what serializes those commits.
    assert any(isinstance(n, ast.Attribute) and n.attr == "_queue"
               for n in ast.walk(session_cls)), "Session no longer owns a mutation queue"


@pytest.mark.skipif(True, reason="R6/R7 (append-only history; no COMPLETED->QUEUED) needs a live run harness — wire SYNTH_FIXTURE")
def test_r6_r7_compute_append_only():
    pass
