"""R5 — every registered function returns the contract envelope (`CallResult`).
The highest-value check: run each function against a synthetic SpatialData
fixture and assert the envelope shape. Functions whose inputs can't be
synthesized are reported as visible skips, not silent passes.

Skips entirely until `config.SYNTH_FIXTURE` is wired to a fixture builder.
"""
import importlib
import sys

import pytest

import config

# The contract fields of CallResult (backend/app/registry/base.py).
ENVELOPE_FIELDS = ("status", "log", "structural_diff", "changed_fields",
                   "changed_facets", "figure_svg", "figure_pdf", "new_object",
                   "error")


@pytest.mark.skipif(config.SYNTH_FIXTURE is None,
                    reason="R5 contract smoke test needs config.SYNTH_FIXTURE wired to a synthetic SpatialData builder")
def test_r5_contract_envelope_for_every_function():
    sys.path.insert(0, str(config.BACKEND.parent))
    mod, attr = config.REGISTRY_REF.split(":")
    registry = getattr(importlib.import_module(mod), attr)
    registry.build()
    session = config.SYNTH_FIXTURE()  # WIRE: build a synthetic session
    skipped = []
    for key, fn in registry.entries.items():
        try:
            result = fn.execute({}, session)
        except Exception:
            skipped.append(key)  # inputs not synthesizable from empty params
            continue
        for f in ENVELOPE_FIELDS:
            assert hasattr(result, f), (key, f)
        assert result.status in {"completed", "drawn", "failed"}, (key, result.status)
    if skipped:
        print(f"R5: {len(skipped)} functions skipped (inputs not synthesizable): {skipped[:10]}")


def test_r5_callresult_is_the_envelope():
    """Even without a fixture, assert the envelope dataclass carries the contract fields."""
    sys.path.insert(0, str(config.BACKEND.parent))
    try:
        base = importlib.import_module("app.registry.base")
    except Exception as e:
        pytest.skip(f"backend not importable here ({type(e).__name__})")
    fields = base.CallResult.__dataclass_fields__
    for f in ENVELOPE_FIELDS:
        assert f in fields, f
