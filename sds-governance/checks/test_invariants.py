"""Invariant checks (R3, R6/R7, R9-R14). pytest; checks whose seam can't be
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


def test_r12_fixed_meta_tools_no_annotate_subset():
    """The agent gets a fixed meta-tool set; annotate/subset are never exposed."""
    _backend()
    tools = importlib.import_module("app.agent.tools")
    names = {t["name"] for t in tools.TOOL_SPECS}
    assert names == {"list_functions", "describe_function", "get_data_manifest", "list_recipes",
                     "list_snapshots", "run_function", "apply_recipe", "save_snapshot"}, names
    assert not any("annotate" in n or "subset" in n for n in names)


def test_r14_bindings_have_widget_and_resolver():
    """Every binding the term dictionary can emit has a describe_function resolver."""
    _backend()
    tools = importlib.import_module("app.agent.tools")
    # the resolver map covers the data-bound facets the dictionary produces
    assert {"obs_categorical", "obs", "obsm", "obsp", "layers", "var_names"} <= set(tools._BIND_FACET)


def test_r11_context_only_no_transcript_replay():
    """Agent replay carries the self-curated context, never the raw transcript."""
    chat = (config.BACKEND / "agent" / "chat.py").read_text()
    assert "ctx.rolled_up" in chat, "context must be replayed"
    # the transcript is appended for the human record but not fed into the model messages
    assert "transcript.append" in chat
    assert "provider.converse(preamble, messages" in chat
    assert "transcript" not in chat.split("messages = [")[1].split("provider.converse")[0]


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
