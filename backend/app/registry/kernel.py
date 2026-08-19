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
    _TABLE_FACETS, capture_log, keyset, diff, render_plot, short_error,
)
from ..sessions import compute_pool


def _resolve_callable(library: str, path: str):
    obj = importlib.import_module(library)
    for part in path.split("."):
        obj = getattr(obj, part)
    return obj


def _table_reshaped(shape_before, adata) -> bool:
    """True when an in-place compute changed the active table's row/column count
    (e.g. `sc.pp.filter_cells` / `filter_genes`). The facet-merge writeback
    (`apply_changed_facets`) can only carry same-length columns back onto the live
    object: a shorter column would index-align, silently NaN-filling the dropped
    rows and coercing integer keys (like a table's `instance_key`) to float, which
    then fails `sdata.write()`. Such a call must instead be adopted whole (§4.6),
    exactly like the read bootstrap."""
    return shape_before is not None and adata is not None and adata.shape != shape_before


# spatialdata keeps each element's coordinate transformations in its `.attrs`, but a
# dask-backed points DataFrame (e.g. Xenium `transcripts`) drops `.attrs` on pickle —
# dask carries nothing through its `__reduce__`. So any element that travels back from
# the compute pool inside a whole-SpatialData `new_object` (the read bootstrap, or a
# table-reshaping `filter_cells`/`filter_genes`) arrives with no transform, and the next
# `sdata.write()` raises `KeyError('transform')` in spatialdata's points writer. Snapshot
# transforms on whichever side still holds them — the parent before the call (for an
# object it owned and passes down) and the child (for one it created, e.g. the read
# bootstrap) — and re-apply any that didn't survive the round-trip.
_SPATIAL_KINDS = ("images", "labels", "points", "shapes")


def _iter_spatial(sdata):
    for kind in _SPATIAL_KINDS:
        for name, elem in getattr(sdata, kind, {}).items():
            yield name, elem


def _has_transform(elem) -> bool:
    # get_transformation asserts the element carries a transformation dict; a points
    # element that lost its .attrs on pickle makes it raise AssertionError.
    from spatialdata.transformations import get_transformation
    try:
        return bool(get_transformation(elem, get_all=True))
    except (KeyError, ValueError, AssertionError):
        return False


def _capture_transforms(sdata) -> dict:
    from spatialdata.transformations import get_transformation
    out = {}
    for name, elem in _iter_spatial(sdata):
        if _has_transform(elem):
            out[name] = get_transformation(elem, get_all=True)
    return out


def _restore_transforms(env: dict, pre: dict | None = None) -> dict:
    """Parent side: re-apply transforms that a pickled `new_object`'s elements lost.
    `pre` is the parent's pre-call snapshot (correct for a reshaped object that came
    *from* the parent, where the transform is stripped on the way into the child);
    the child's own snapshot covers a freshly-created object (the read bootstrap).
    The parent snapshot wins where both exist — so callers must pass `pre` only when
    `new_object` derives from the parent's own dataset (see `run_library_call`)."""
    from spatialdata.transformations import set_transformation
    sdata = env.get("new_object")
    captured = {**(env.pop("element_transforms", None) or {}), **(pre or {})}
    if sdata is None or not captured:
        return env
    for name, elem in _iter_spatial(sdata):
        saved = captured.get(name)
        if saved and not _has_transform(elem):
            set_transformation(elem, dict(saved), set_all=True)
    return env


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
            "figure_png": result.figure_png,
            "changed_facets": _facet_values(adata, sdata, changed), "changed_fields": fields}


def _failure_envelope(buf, e) -> dict:
    """The child-worker failure result: the captured log plus the traceback, and a
    short single-line error. Shared by the library-call and mutate child paths."""
    return {"status": "failed", "log": buf.getvalue() + "\n" + traceback.format_exc(),
            "error": short_error(e)}


def _is_data_object(ret) -> bool:
    """True for the two whole-object types a compute can hand back instead of mutating
    in place. Imported inside the function like the other heavy-library imports in this
    module; `isinstance` rather than a class-name match, so a subclass counts and an
    unrelated class that happens to be called `AnnData` does not."""
    from anndata import AnnData
    from spatialdata import SpatialData
    return isinstance(ret, (AnnData, SpatialData))


def _compute_result(log, before, shape_before, adata, sdata, ret=None, label="") -> dict:
    """Terminal result for an in-place compute child: adopt the whole object when the
    table was reshaped (or a library call returned a fresh AnnData/SpatialData with no
    facet diff), else return the facet diff for the parent to merge. Shared by
    `_child_library_call` and `_child_mutate`; `ret` is None for the mutate shape, and
    `label` names the library call for the both-mutated-and-returned failure below."""
    if _table_reshaped(shape_before, adata) and sdata is not None:
        return {"status": "completed", "log": log, "new_object": sdata,
                "element_transforms": _capture_transforms(sdata)}
    after = keyset(adata, sdata)
    changed, fields = diff(before, after)
    # Only a DIFFERENT object counts as something to adopt (the "always-copies despite
    # pinned copy=False" case, §4.6). A function that hands its input straight back
    # (`return adata`) mutated in place, and the facet diff already describes it.
    if ret is not None and ret is not adata and ret is not sdata and _is_data_object(ret):
        # Whole-object adoption and facet merge are alternatives, not a sequence: the
        # parent applies one or the other (session._run_call), and adopting `ret` would
        # throw away whatever the call also wrote onto the live table — while merging
        # the facets would throw away `ret`. Neither is safe to pick silently, and
        # adoption is the more destructive guess (an adopted bare AnnData is rewrapped
        # as a table-only SpatialData, dropping the dataset's images/labels/shapes), so
        # refuse the call and say so instead of applying half its work. A failed
        # envelope rather than a raise: this runs in the child, and only the envelope
        # carries the captured log back across the process boundary.
        if changed:
            return {"status": "failed", "log": log,
                    "error": (f"{label} both mutated the object in place and returned a new "
                              f"{type(ret).__name__}; only one of the two can be applied, so the "
                              f"call was rejected rather than applied in half")}
        return {"status": "completed", "log": log, "new_object": ret,
                "element_transforms": _capture_transforms(ret)}
    return {"status": "completed", "log": log,
            "changed_facets": _facet_values(adata, sdata, changed), "changed_fields": fields}


def _child_library_call(library, path, effect_class, injected_order, bound, adata, sdata, image,
                        log_queue=None):
    fn = _resolve_callable(library, path)
    values = {"adata": adata, "sdata": sdata, "image": image}
    injected = [values[kind] for kind in injected_order]

    if effect_class == "plot":
        return _child_plot(fn, injected, bound, adata, sdata)

    # A read bootstrap streams its log back to the parent live (loky child → Manager
    # queue → parent drainer → SSE); other calls just buffer (log_queue is None).
    sink = log_queue.put if log_queue is not None else None
    shape_before = adata.shape if (effect_class == "compute" and adata is not None) else None
    with capture_log(sink=sink) as buf:
        try:
            before = keyset(adata, sdata) if effect_class == "compute" else None
            ret = fn(*injected, **bound)
        except Exception as e:
            return _failure_envelope(buf, e)
        log = buf.getvalue()

    if effect_class == "read":
        return {"status": "completed", "log": log, "new_object": ret,
                "element_transforms": _capture_transforms(ret)}
    if effect_class == "extract":
        # Runs for its side-effect-free return, but nothing is written back or
        # persisted — the value is not carried past the worker (DESIGN §4.6).
        return {"status": "completed", "log": log}

    return _compute_result(log, before, shape_before, adata, sdata, ret=ret,
                           label=f"{library}.{path}")


def _child_mutate(mutate, adata, sdata):
    """The custom-function shape (registry/custom/*.py via `run_compute`):
    `mutate(adata)` runs in place, no return value."""
    shape_before = adata.shape
    before = keyset(adata, sdata)
    with capture_log() as buf:
        try:
            mutate(adata)
        except Exception as e:
            return _failure_envelope(buf, e)
        log = buf.getvalue()
    return _compute_result(log, before, shape_before, adata, sdata)


# ---- submission from the parent (blocks the calling worker thread, not the
# event loop — concurrent.futures/loky's wait releases the GIL) -------------

def run_library_call(*, library, path, effect_class, injected_order, bound, adata, sdata, image) -> dict:
    from ..transport import livelog
    # Transform snapshots are keyed by element NAME, not dataset identity (the same
    # trap as session.py's known_stores reset on re-import): a read effect re-run on
    # an already-open session replaces the dataset wholesale, so the parent's
    # pre-call snapshot describes the PREVIOUS dataset — letting it win would stamp
    # the old dataset's transforms onto same-named elements of the new one (whose
    # own transforms were lost to dask pickling). Restore a read's new object from
    # the child snapshot only; `pre` is legitimate solely on compute paths, where
    # the returned object derives from the parent's own dataset.
    pre = _capture_transforms(sdata) if sdata is not None and effect_class != "read" else {}
    # Stream a read bootstrap's log to the client as it runs; nothing else streams.
    sink = livelog.current_sink() if effect_class == "read" else None
    with livelog.child_log_stream(sink) as log_queue:
        future = compute_pool.executor().submit(
            _child_library_call, library, path, effect_class, injected_order, bound,
            adata, sdata, image, log_queue)
        return _restore_transforms(future.result(), pre)


def run_mutate(mutate, adata, sdata) -> dict:
    pre = _capture_transforms(sdata) if sdata is not None else {}
    future = compute_pool.executor().submit(_child_mutate, mutate, adata, sdata)
    return _restore_transforms(future.result(), pre)


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
