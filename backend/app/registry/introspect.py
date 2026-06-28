"""Function introspection layer (DESIGN §4) — the backbone.

Discovers squidpy functions by reflection and builds, per function, a form
descriptor (JSON Schema + ui hints), a list of type-injected data slots, and an
effect class. No squidpy function is ever named here; the registry is the only
path to a function (invariant §16.1).
"""
from __future__ import annotations

import inspect
import typing
import warnings
from dataclasses import dataclass, field

from . import conventions

warnings.filterwarnings("ignore")

NAMESPACES = ["gr", "im", "tl", "read", "pl"]
COMPUTE_NS = {"gr", "im", "tl", "read"}

# Session-held types filled by injection (DESIGN §4.6 step 2), matched on the
# annotation's string form so we never depend on import identity.
_INJECT_TOKENS = [("AnnData", "adata"), ("SpatialData", "sdata"), ("ImageContainer", "image")]


@dataclass
class ParamSpec:
    name: str
    schema: dict          # JSON Schema fragment
    widget: str
    bound_to: str | None
    required: bool
    tooltip: str = ""


@dataclass
class FunctionEntry:
    key: str
    namespace: str
    function: str
    effect_class: str
    summary: str
    injected: dict           # param_name -> injection kind (adata|sdata|image)
    pinned: dict             # param_name -> pinned value
    params: list             # list[ParamSpec] (form params, in signature order)
    partially_supported: bool
    unsupported_params: list  # locked-to-default param names

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
            "effect_class": self.effect_class, "summary": self.summary,
            "json_schema": self.json_schema(), "ui_schema": self.ui_schema(),
            "partially_supported": self.partially_supported,
            "unsupported_params": self.unsupported_params,
        }


def _json_finite(value) -> bool:
    """True if value is JSON-serializable with only finite floats (Starlette rejects
    NaN/Inf). Some squidpy defaults are e.g. `(-inf, inf)`."""
    import json
    import math
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, (list, tuple)):
        return all(_json_finite(v) for v in value)
    if isinstance(value, dict):
        return all(_json_finite(v) for v in value.values())
    try:
        json.dumps(value)
        return True
    except (TypeError, ValueError):
        return False


def _annot_str(annot) -> str:
    if annot is inspect.Parameter.empty or annot is None:
        return ""
    return getattr(annot, "__name__", None) or str(annot)


def _injection_kind(annot) -> str | None:
    s = _annot_str(annot)
    for token, kind in _INJECT_TOKENS:
        if token in s:
            return kind
    return None


def _strip_optional(annot):
    """Return (inner_annotation, is_optional) unwrapping `X | None` / Optional[X]."""
    origin = typing.get_origin(annot)
    if origin is typing.Union or str(origin) == "types.UnionType" or origin is getattr(__import__("types"), "UnionType", None):
        args = [a for a in typing.get_args(annot) if a is not type(None)]
        is_opt = len(args) != len(typing.get_args(annot))
        if len(args) == 1:
            return args[0], is_opt
        return annot, is_opt  # genuine multi-type union, keep as-is
    return annot, False


_SCALAR_SCHEMA = {bool: {"type": "boolean"}, int: {"type": "integer"},
                  float: {"type": "number"}, str: {"type": "string"}}


def _schema_for(annot, default, has_default) -> tuple[dict, str, bool]:
    """Map an annotation to (json_schema_fragment, widget, serializable)."""
    inner, _ = _strip_optional(annot)
    origin = typing.get_origin(inner)

    # Literal -> enum dropdown, preserving JSON-native value types so the form
    # submits e.g. ints/bools rather than their stringified form.
    if origin is typing.Literal:
        vals = list(typing.get_args(inner))
        if all(isinstance(v, bool) for v in vals):
            return {"type": "boolean", "enum": vals}, "select", True
        if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals):
            return {"type": "number", "enum": vals}, "select", True
        if all(isinstance(v, str) for v in vals):
            return {"type": "string", "enum": vals}, "select", True
        return {"type": "string", "enum": [str(v) for v in vals]}, "select", True

    # Sequence/list of strings -> multitext
    if origin in (list, tuple) or _annot_str(inner).startswith(("collections.abc.Sequence", "typing.Sequence")):
        return {"type": "array", "items": {"type": "string"}}, "multitext", True

    if inner in _SCALAR_SCHEMA:
        sch = dict(_SCALAR_SCHEMA[inner])
        return sch, ("checkbox" if inner is bool else "number" if inner in (int, float) else "text"), True

    s = _annot_str(inner)
    # dict-typed -> JSON text widget (rarely needed; defaults to null/None)
    if origin is dict or s.startswith(("dict", "typing.Dict", "collections.abc.Mapping", "typing.Mapping")):
        return {"type": ["object", "null"]}, "json", True

    # Non-serializable (Callable, ndarray, Colormap, type objects, constants enums, etc.)
    NON_SERIALIZABLE = ("Callable", "ndarray", "Colormap", "Axes", "Figure", "function",
                        "Container", "Graph", "NDArray", "dtype", "type")
    if any(t in s for t in NON_SERIALIZABLE):
        return {"type": "string"}, "text", False

    # Unknown / unannotated -> safe text fallback (DESIGN §4.2)
    return {"type": "string"}, "text", True


def _build_function(namespace: str, name: str, fn) -> FunctionEntry | None:
    try:
        sig = inspect.signature(fn)
    except (ValueError, TypeError):
        return None
    try:
        hints = typing.get_type_hints(fn)
    except Exception:
        hints = {}  # DESIGN §17: forward-ref / optional-dep failures fall back to raw annotations

    injected, pinned, params, unsupported = {}, {}, [], []
    partially = False
    doc = inspect.getdoc(fn) or ""
    summary = doc.split("\n")[0].strip()
    param_docs = _parse_param_docs(doc)

    for pname, p in sig.parameters.items():
        if p.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            partially = True  # variadic can't be form-generated (DESIGN §21 R1)
            continue
        annot = hints.get(pname, p.annotation)

        kind = _injection_kind(annot)
        if kind is not None:
            injected[pname] = kind
            continue
        if conventions.is_pinned(pname):
            pinned[pname] = conventions.PINNED_PARAMS[pname]
            continue

        has_default = p.default is not inspect.Parameter.empty
        default = p.default if has_default else None
        schema, type_widget, serializable = _schema_for(annot, default, has_default)

        if not serializable:
            unsupported.append(pname)
            if not has_default:
                partially = True  # required but unfillable
            continue

        if has_default and default is not None and _json_finite(default):
            schema = {**schema, "default": default}
        if pname == "n_jobs" and schema.get("default") in (None, 0):
            schema["default"] = conventions.N_JOBS_DEFAULT

        conv = conventions.convention_for(pname)
        widget, bound = (conv if conv else (type_widget, None))

        params.append(ParamSpec(
            name=pname, schema=schema, widget=widget, bound_to=bound,
            required=not has_default, tooltip=param_docs.get(pname, ""),
        ))

    effect = "plot" if namespace == "pl" else ("read" if namespace == "read" else "compute")
    return FunctionEntry(
        key=f"{namespace}.{name}", namespace=namespace, function=name,
        effect_class=effect, summary=summary, injected=injected, pinned=pinned,
        params=params, partially_supported=partially, unsupported_params=unsupported,
    )


def _parse_param_docs(doc: str) -> dict:
    """Best-effort numpydoc Parameters section -> {param: first-line description}."""
    out = {}
    lines = doc.splitlines()
    in_params = False
    cur = None
    for ln in lines:
        st = ln.strip()
        if st in ("Parameters", "Parameters\n") or st == "Parameters":
            in_params = True
            continue
        if in_params and st and set(st) == {"-"}:
            continue
        if in_params and st in ("Returns", "Raises", "Examples", "Notes", "See Also"):
            break
        if not in_params:
            continue
        if ln and not ln[0].isspace():  # dedented -> end of section
            break
        if " : " in st or (st and not ln.startswith("        ") and ln.startswith("    ")):
            cur = st.split(" : ")[0].split(",")[0].strip()
            out.setdefault(cur, "")
        elif cur and st:
            if not out.get(cur):
                out[cur] = st
    return out


@dataclass
class Registry:
    entries: dict = field(default_factory=dict)
    squidpy_version: str = ""

    def build(self):
        import squidpy as sq
        self.squidpy_version = sq.__version__
        self.entries = {}
        for ns in NAMESPACES:
            mod = getattr(sq, ns, None)
            if mod is None:
                continue
            for name in dir(mod):
                if name.startswith("_"):
                    continue
                obj = getattr(mod, name)
                if not callable(obj) or inspect.isclass(obj):
                    continue
                if not getattr(obj, "__module__", "").startswith("squidpy"):
                    continue
                entry = _build_function(ns, name, obj)
                if entry is not None:
                    self.entries[entry.key] = entry
        return self

    def get(self, key: str) -> FunctionEntry | None:
        return self.entries.get(key)

    def resolve_callable(self, namespace: str, function: str):
        """Resolve the live callable by namespace.function (DESIGN §4.6 step 1)."""
        import squidpy as sq
        return getattr(getattr(sq, namespace), function)

    def public(self) -> dict:
        return {"functions": [e.to_public() for e in self.entries.values()],
                "squidpy_version": self.squidpy_version}


REGISTRY = Registry()
