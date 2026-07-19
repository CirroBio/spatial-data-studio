"""The universal function layer.

`Function` is everything common to *any* runnable operation — identity, the
form descriptor (JSON Schema + ui hints), an effect class, and the `execute`
contract — independent of whether it is a library call or a hand-written
operation. `LibraryFunction` (library_fn.py) and the `custom/` functions both
subclass it, so they flow through the same picker -> form -> queue -> history
machinery.

This module imports nothing from the registry or sessions packages so the
concrete function classes can depend on it without an import cycle.
"""
from __future__ import annotations

import contextlib
import io
import logging
import threading
import traceback
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

# pyplot state is process-global; sessions plot concurrently (DESIGN §4.6 step 6).
_PLOT_LOCK = threading.Lock()

_TABLE_FACETS = ["obs", "var", "obsm", "obsp", "layers", "uns"]
_SDATA_FACETS = ["images", "labels", "points", "shapes", "tables"]
_FACET_TO_ELEMENT = {"obs": "obs", "var": "var", "obsm": "obsm", "obsp": "obsp", "layers": "layers"}

# Closed vocabularies for a ParamSpec / Function, mirrored from the frontend so the
# form can't be handed a value it doesn't render. WIDGETS is the exact `UiWidget`
# union in frontend/src/types.ts; EFFECT_CLASSES / ROLES are `EffectClass` and the
# role field there. The registry self-check (custom/__init__.py) enforces these.
WIDGETS = frozenset({
    "checkbox", "number", "text", "select", "multitext", "obs_key", "obs_categorical",
    "var_names", "layer_key", "obsm_key", "obsp_key", "library_id", "obs_value_map", "json",
})
EFFECT_CLASSES = frozenset({"compute", "plot", "read", "extract"})
ROLES = frozenset({"input", "output"})


@dataclass
class ParamSpec:
    name: str
    schema: dict          # JSON Schema fragment
    widget: str           # a WIDGETS member
    bound_to: str | None  # None for every widget except obs_value_map (names its companion field param)
    required: bool
    tooltip: str = ""
    role: str = "input"   # input | output (output params name a slot the step creates)

    # Named-intent constructors: one per common parameter kind, each baking in the
    # correct widget and schema skeleton so a contributor picks intent, not magic
    # strings. bound_to is always None (only obs_value_map sets it, via the plain
    # constructor). The positional ParamSpec(...) constructor still works.
    @classmethod
    def obs_categorical(cls, name: str, *, required: bool = False, tooltip: str = "") -> "ParamSpec":
        """A picker over the categorical obs columns."""
        return cls(name, {"type": "string"}, "obs_categorical", None, required=required, tooltip=tooltip)

    @classmethod
    def obs_column(cls, name: str, *, required: bool = False, tooltip: str = "") -> "ParamSpec":
        """A picker over all obs columns."""
        return cls(name, {"type": "string"}, "obs_key", None, required=required, tooltip=tooltip)

    @classmethod
    def obsm_key(cls, name: str, *, default: str = "spatial", required: bool = False,
                 tooltip: str = "") -> "ParamSpec":
        """A picker over obsm keys (embeddings/coordinates)."""
        return cls(name, {"type": "string", "default": default}, "obsm_key", None,
                   required=required, tooltip=tooltip)

    @classmethod
    def number(cls, name: str, *, default=None, required: bool = False, tooltip: str = "",
               integer: bool = False) -> "ParamSpec":
        """A numeric input; pass integer=True for an int-typed schema."""
        schema = {"type": "integer" if integer else "number"}
        if default is not None:
            schema["default"] = default
        return cls(name, schema, "number", None, required=required, tooltip=tooltip)

    @classmethod
    def text(cls, name: str, *, default: str = "", required: bool = False, tooltip: str = "",
             output: bool = False) -> "ParamSpec":
        """A free-text input. output=True marks a param that names a slot the step
        creates (e.g. key_added), setting role='output'."""
        schema = {"type": "string"}
        if default is not None:
            schema["default"] = default
        return cls(name, schema, "text", None, required=required, tooltip=tooltip,
                   role="output" if output else "input")

    @classmethod
    def choice(cls, name: str, choices, *, default=None, required: bool = False,
               tooltip: str = "") -> "ParamSpec":
        """A dropdown over a fixed set of string choices."""
        schema = {"type": "string", "enum": list(choices)}
        if default is not None:
            schema["default"] = default
        return cls(name, schema, "select", None, required=required, tooltip=tooltip)

    @classmethod
    def flag(cls, name: str, *, default: bool = False, required: bool = False,
             tooltip: str = "") -> "ParamSpec":
        """A boolean checkbox."""
        return cls(name, {"type": "boolean", "default": default}, "checkbox", None,
                   required=required, tooltip=tooltip)


@dataclass
class CallResult:
    """The result envelope every function — library or custom — returns to the
    session worker: status plus any produced object, figure, diff, or error."""
    status: str                       # completed | drawn | failed
    log: str = ""
    structural_diff: dict = field(default_factory=dict)
    changed_fields: list = field(default_factory=list)  # field paths for version bump
    figure_svg: bytes | None = None
    figure_pdf: bytes | None = None
    new_object: object | None = None
    result_value: object | None = None  # extract-class return (e.g. a DataFrame), JSON-safe summary
    error: str | None = None


class Function(ABC):
    """Everything universal about a runnable function.

    Subclasses set the identity/descriptor attributes (key, namespace,
    function, effect_class, summary, doc, label, params, ...) and implement
    `execute`. The JSON Schema / ui hints / public dict are derived here from
    `params`, so every function — library or custom — presents identically to
    the frontend.
    """

    key: str
    namespace: str
    function: str
    effect_class: str                 # compute | plot | read | extract (see EFFECT_CLASSES)
    summary: str = ""
    doc: str = ""
    label: str | None = None          # human title for the picker; library fns use namespace.function
    source: str = ""                  # squidpy | scanpy | spatialdata_io | custom (subclass sets it)
    params: list                      # list[ParamSpec], in display order
    partially_supported: bool = False
    unsupported_params: list = []
    # For `read` functions only: whether the New Session import picker should accept
    # a "folder", a "file", or "either" as the input path. None for non-readers.
    input_kind: str | None = None
    # Provenance shown in the picker (mandatory for every function — see CLAUDE.md).
    # Library functions inherit both from registry/library_meta.yaml (one entry per
    # library); custom functions set them explicitly (citation = where the method
    # came from; documentation = its section in custom/README.md).
    citation: str = ""
    documentation: str = ""

    def json_schema(self) -> dict:
        props, required = {}, []
        for p in self.params:
            props[p.name] = p.schema
            if p.required:
                required.append(p.name)
        return {"type": "object", "properties": props, "required": required}

    def ui_schema(self) -> dict:
        return {p.name: {"widget": p.widget, "bound_to": p.bound_to, "tooltip": p.tooltip}
                for p in self.params}

    def to_public(self) -> dict:
        return {
            "key": self.key, "namespace": self.namespace, "function": self.function,
            "effect_class": self.effect_class, "summary": self.summary, "doc": self.doc,
            "label": self.label, "source": self.source,
            "citation": self.citation, "documentation": self.documentation,
            "json_schema": self.json_schema(), "ui_schema": self.ui_schema(),
            "partially_supported": self.partially_supported,
            "unsupported_params": self.unsupported_params,
            "input_kind": self.input_kind,
        }

    @abstractmethod
    def execute(self, params: dict, session) -> CallResult:
        """Run the operation against the session, returning a CallResult."""


# ---- shared execution primitives (reused by library + custom functions) -----

def short_error(e: Exception) -> str:
    """A concise, user-facing error string for the failure toast."""
    msg = str(e).strip().splitlines()[0] if str(e).strip() else e.__class__.__name__
    return f"{e.__class__.__name__}: {msg}"[:300]


@contextlib.contextmanager
def capture_log():
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setLevel(logging.DEBUG)
    root = logging.getLogger()
    prev_level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            yield buf
    finally:
        root.removeHandler(handler)
        root.setLevel(prev_level)


def missing_obs_column(adata, name: str | None) -> str | None:
    """Failure message if `name` isn't a column of `adata.obs`, else None. Custom
    functions that take an obs-column param check this before running `mutate`."""
    if not name or name not in adata.obs.columns:
        return f"obs column '{name}' does not exist"
    return None


def resolve_obsm_key(adata, params: dict, param: str = "coords", default: str = "spatial") -> str:
    """Resolve an obsm key from `params[param]` (falling back to `default`).
    Raises KeyError(key) if that key isn't in `adata.obsm`, so callers can build
    their own failure `CallResult` from the missing key."""
    key = params.get(param) or default
    if key not in adata.obsm:
        raise KeyError(key)
    return key


def keyset(adata, sdata) -> dict:
    """Per-key identity snapshot. `id()` of the stored object lets the diff catch
    keys that were *overwritten in place* (e.g. re-running clustering replaces
    `obs['leiden']`), not just keys that were added (DESIGN §6.4). Over-detection
    is harmless (a redundant refetch); under-detection leaves a stale canvas."""
    snap = {}
    for f in _TABLE_FACETS:
        m = getattr(adata, f)
        if f in ("obs", "var"):
            snap[f] = {k: id(m[k].values) for k in m.columns}
        else:
            snap[f] = {k: id(v) for k, v in m.items()}
    if sdata is not None:
        for f in _SDATA_FACETS:
            snap[f] = {k: id(v) for k, v in getattr(sdata, f, {}).items()}
    return snap


def diff(before: dict, after: dict) -> tuple[dict, list]:
    out, fields = {}, []
    for facet, after_map in after.items():
        bmap = before.get(facet, {})
        changed = sorted(k for k, v in after_map.items() if bmap.get(k) != v)
        if changed:
            out[facet] = changed
            elem = _FACET_TO_ELEMENT.get(facet)
            if elem:
                fields.extend(f"{elem}:{k}" for k in changed)
    return out, fields


def run_compute(session, mutate) -> CallResult:
    """Run an in-place compute mutation `mutate(adata)` in the compute pool (see
    kernel.py) so a slow custom function never holds the API process's GIL. The
    caller already holds the session write lock."""
    from . import kernel
    adata = session.active_table()
    env = kernel.run_mutate(mutate, adata, session.sdata)
    if env["status"] == "failed":
        return CallResult(status="failed", error=env.get("error"), log=env.get("log", ""))
    if env.get("new_object") is not None:
        # A mutation that changed the table's row/column count is adopted whole
        # rather than facet-merged (see kernel._table_reshaped).
        return CallResult(status="completed", log=env.get("log", ""), new_object=env["new_object"])
    facets = env.get("changed_facets", {})
    kernel.apply_changed_facets(adata, session.sdata, facets)
    structural_diff = {facet: sorted(values) for facet, values in facets.items()}
    return CallResult(status="completed", log=env.get("log", ""), structural_diff=structural_diff,
                      changed_fields=env.get("changed_fields", []))


def run_plot(session, fn, injected: list | None = None, bound: dict | None = None) -> CallResult:
    """Run a custom plotting callable in the compute pool (see kernel.py) — the
    same GIL isolation as a library plot. `injected` defaults to `[active_table]`,
    the shape every custom plot function uses today."""
    from . import kernel
    adata = session.active_table()
    env = kernel.run_custom_plot(fn, injected if injected is not None else [adata], bound or {},
                                  adata, session.sdata)
    if env["status"] == "failed":
        return CallResult(status="failed", error=env.get("error"), log=env.get("log", ""))
    kernel.apply_changed_facets(adata, session.sdata, env.get("changed_facets", {}))
    return CallResult(status=env["status"], log=env.get("log", ""),
                      figure_svg=env.get("figure_svg"), figure_pdf=env.get("figure_pdf"))


def render_plot(fn, injected: list, bound: dict, buf) -> CallResult:
    """Run a plotting callable under the global pyplot lock and capture SVG+PDF."""
    import numpy as np
    import matplotlib
    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt

    def _figure_from(ret):
        # scanpy's dotplot-family plots return an unrendered BasePlot object under
        # return_fig=True (pinned for every plot); it only produces a figure once
        # make_figure() runs, so drive that before the generic Axes handling below.
        if ret is not None and hasattr(ret, "make_figure") and hasattr(ret, "fig"):
            ret.make_figure()
            return ret.fig
        if ret is not None:
            axes = np.ravel(ret) if isinstance(ret, (list, tuple, np.ndarray)) else [ret]
            for a in axes:
                figure = getattr(a, "figure", None) or getattr(a, "get_figure", lambda: None)()
                if figure is not None:
                    return figure
        return plt.gcf()

    with _PLOT_LOCK:
        try:
            plt.close("all")
            ret = fn(*injected, **bound)
            fig = _figure_from(ret)
            svg, pdf = io.BytesIO(), io.BytesIO()
            fig.savefig(svg, format="svg", bbox_inches="tight")
            fig.savefig(pdf, format="pdf", bbox_inches="tight")
            plt.close("all")
            return CallResult(status="drawn", log=buf.getvalue(),
                              figure_svg=svg.getvalue(), figure_pdf=pdf.getvalue())
        except Exception as e:
            plt.close("all")
            return CallResult(status="failed", log=buf.getvalue() + "\n" + traceback.format_exc(),
                              error=short_error(e))
