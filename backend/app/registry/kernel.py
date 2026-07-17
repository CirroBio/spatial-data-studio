"""The compute-pool boundary (v3 Part 2 addendum: GIL isolation). Everything in
this module either runs *inside* the child process (the `_child_*` functions,
submitted to `sessions/compute_pool.py`'s executor) or applies a child's result
back onto the live session (`apply_*`), run by the caller in the parent
process under the session's write lock.

Why the split lands here and not deeper/shallower: `keyset()`/`diff()`
(base.py) are `id()`-based — unpickling reassigns a fresh id to every array or
column, even untouched ones, so "before" and "after" must be captured on the
*same* side of the process boundary or every facet looks changed. That forces
the whole call — inject, invoke, before/after diff — into the child; only the
*changed* facets travel back, so unrelated (untouched) data never round-trips.
"""
from __future__ import annotations

import importlib
import traceback

from .base import (
    _TABLE_FACETS, _SDATA_FACETS, capture_log, keyset, diff, render_plot, short_error,
)
from ..sessions import compute_pool


def _resolve_callable(library: str, path: str):
    obj = importlib.import_module(library)
    for part in path.split("."):
        obj = getattr(obj, part)
    return obj


def _facet_values(adata, sdata, changed: dict) -> dict:
    """Only the changed column/array objects, keyed like `keyset`/`diff` — the
    payload that travels back to the parent."""
    out = {}
    for facet, keys in changed.items():
        m = getattr(adata, facet) if facet in _TABLE_FACETS else getattr(sdata, facet, {})
        out[facet] = {k: m[k] for k in keys}
    return out


# ---- runs inside the child process -----------------------------------------

def _child_plot(fn, injected, bound, adata, sdata):
    """Shared by library plots and custom plots (registry/custom/*.py via
    `run_plot`). A plot mutates nothing structural but may cache
    uns['<col>_colors'] as a side effect (matplotlib color-mapping); before/after
    brackets render_plot's own fn() call so that incidental change still
    travels back to the parent."""
    before = keyset(adata, sdata)
    with capture_log() as buf:
        result = render_plot(fn, injected, bound, buf)
    if result.status == "failed":
        return {"status": "failed", "error": result.error, "log": result.log}
    after = keyset(adata, sdata)
    changed, fields = diff(before, after)
    return {"status": result.status, "log": result.log,
            "figure_svg": result.figure_svg, "figure_pdf": result.figure_pdf,
            "changed_facets": _facet_values(adata, sdata, changed), "changed_fields": fields}


def _child_library_call(library, path, effect_class, injected_order, bound, adata, sdata, image):
    fn = _resolve_callable(library, path)
    values = {"adata": adata, "sdata": sdata, "image": image}
    injected = [values[kind] for kind in injected_order]

    if effect_class == "plot":
        return _child_plot(fn, injected, bound, adata, sdata)

    with capture_log() as buf:
        try:
            before = keyset(adata, sdata) if effect_class == "compute" else None
            ret = fn(*injected, **bound)
        except Exception as e:
            return {"status": "failed", "log": buf.getvalue() + "\n" + traceback.format_exc(),
                    "error": short_error(e)}
        log = buf.getvalue()

    if effect_class == "read":
        return {"status": "completed", "log": log, "new_object": ret}
    if effect_class == "extract":
        return {"status": "completed", "log": log, "result_value_raw": ret}

    # compute
    after = keyset(adata, sdata)
    changed, fields = diff(before, after)
    if ret is not None and not changed and ret.__class__.__name__ in ("AnnData", "SpatialData"):
        return {"status": "completed", "log": log, "new_object": ret}
    return {"status": "completed", "log": log,
            "changed_facets": _facet_values(adata, sdata, changed), "changed_fields": fields}


def _child_mutate(mutate, adata, sdata):
    """The custom-function shape (registry/custom/*.py via `run_compute`):
    `mutate(adata)` runs in place, no return value."""
    before = keyset(adata, sdata)
    with capture_log() as buf:
        try:
            mutate(adata)
        except Exception as e:
            return {"status": "failed", "log": buf.getvalue() + "\n" + traceback.format_exc(),
                    "error": short_error(e)}
        log = buf.getvalue()
    after = keyset(adata, sdata)
    changed, fields = diff(before, after)
    return {"status": "completed", "log": log,
            "changed_facets": _facet_values(adata, sdata, changed), "changed_fields": fields}


# ---- submission from the parent (blocks the calling worker thread, not the
# event loop — concurrent.futures/loky's wait releases the GIL) -------------

def run_library_call(*, library, path, effect_class, injected_order, bound, adata, sdata, image) -> dict:
    future = compute_pool.executor().submit(
        _child_library_call, library, path, effect_class, injected_order, bound, adata, sdata, image)
    return future.result()


def run_mutate(mutate, adata, sdata) -> dict:
    future = compute_pool.executor().submit(_child_mutate, mutate, adata, sdata)
    return future.result()


def run_custom_plot(fn, injected, bound, adata, sdata) -> dict:
    future = compute_pool.executor().submit(_child_plot, fn, injected, bound, adata, sdata)
    return future.result()


# ---- applying a child envelope back onto the live session (parent side,
# still under the session's write lock) --------------------------------------

def apply_changed_facets(adata, sdata, facets: dict) -> None:
    for facet, values in facets.items():
        target = adata if facet in _TABLE_FACETS else sdata
        m = getattr(target, facet)
        for k, v in values.items():
            m[k] = v
