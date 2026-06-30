"""Squidpy functions — everything universal to a squidpy call.

`SquidpyFunction` is built by reflection (`build_squidpy_function`) and knows how
to inject the session-held objects (AnnData/SpatialData/ImageContainer), bind and
validate the form params, run the squidpy callable, and turn the result into a
CallResult. No squidpy function is ever named here; the introspection builder is
the only path to one (invariant DESIGN §16.1).
"""
from __future__ import annotations

import inspect
import traceback
import typing

from .base import (
    Function, ParamSpec, CallResult,
    capture_log, keyset, compute_result, render_plot, short_error,
)
from .dictionary import DICTIONARY

# Session-held types filled by injection (DESIGN §4.6 step 2), matched on the
# annotation's string form so we never depend on import identity.
_INJECT_TOKENS = [("AnnData", "adata"), ("SpatialData", "sdata"), ("ImageContainer", "image")]
_SCALAR_SCHEMA = {bool: {"type": "boolean"}, int: {"type": "integer"},
                  float: {"type": "number"}, str: {"type": "string"}}


class SquidpyFunction(Function):
    source = "squidpy"

    def __init__(self, *, key, namespace, function, effect_class, summary, doc,
                 injected, pinned, params, partially_supported, unsupported_params):
        self.key = key
        self.namespace = namespace
        self.function = function
        self.effect_class = effect_class
        self.summary = summary
        self.doc = doc
        self.label = None
        self.injected = injected           # param_name -> injection kind (adata|sdata|image)
        self.pinned = pinned               # param_name -> pinned value
        self.params = params
        self.partially_supported = partially_supported
        self.unsupported_params = unsupported_params

    def _callable(self):
        import squidpy as sq
        return getattr(getattr(sq, self.namespace), self.function)

    def execute(self, params: dict, session) -> CallResult:
        fn = self._callable()
        try:
            injected = self._inject(session)
            bound = self._bind_and_validate(params, session)
        except Exception as e:
            return CallResult(status="failed", error=str(e), log=str(e))

        before = keyset(session.active_table(), session.sdata) if self.effect_class == "compute" else None

        with capture_log() as buf:
            if self.effect_class == "plot":
                return render_plot(fn, injected, bound, buf)
            try:
                ret = fn(*injected, **bound)
            except Exception as e:
                return CallResult(status="failed", log=buf.getvalue() + "\n" + traceback.format_exc(),
                                  error=short_error(e))
            log = buf.getvalue()

        if self.effect_class == "read":
            return CallResult(status="completed", log=log, new_object=ret)
        return compute_result(session, before, log, ret=ret, result_key=self.key)

    def _inject(self, session) -> list:
        args = []
        for _pname, kind in self.injected.items():
            if kind == "adata":
                args.append(session.active_table())
            elif kind == "sdata":
                args.append(session.sdata)
            elif kind == "image":
                args.append(session.active_image())
        return args

    def _bind_and_validate(self, params: dict, session) -> dict:
        bound = dict(self.pinned)  # pinned policy params first (DESIGN §16, can't be overridden)
        # A `read` bootstrap job runs before any object exists; nothing to validate yet (§12).
        adata = session.active_table() if session.sdata is not None else None
        by_name = {p.name: p for p in self.params}
        for name, value in params.items():
            if name in self.pinned:
                continue
            spec = by_name.get(name)
            if value is None or value == "" or value == []:
                continue  # unset -> let squidpy's own default apply
            if spec is not None and adata is not None:
                self._validate_reference(spec, value, adata)
            bound[name] = value
        for p in self.params:
            if p.required and p.name not in bound:
                raise ValueError(f"missing required parameter: {p.name}")
        return bound

    @staticmethod
    def _validate_reference(spec, value, adata):
        """Validate-on-dequeue (DESIGN §6.2): convention-bound refs must exist now."""
        b = spec.bound_to
        vals = value if isinstance(value, list) else [value]
        if b in ("obs", "obs_categorical"):
            for v in vals:
                if v not in adata.obs.columns:
                    raise ValueError(f"obs column '{v}' does not exist on the current object")
        elif b == "var_names":
            for v in vals:
                if v not in adata.var_names:
                    raise ValueError(f"gene '{v}' not in var_names")
        elif b == "obsm":
            for v in vals:
                if v not in adata.obsm:
                    raise ValueError(f"obsm key '{v}' does not exist")
        elif b == "obsp":
            for v in vals:
                if v not in adata.obsp:
                    raise ValueError(f"obsp key '{v}' does not exist")
        elif b == "layers":
            for v in vals:
                if v not in adata.layers:
                    raise ValueError(f"layer '{v}' does not exist")


# ---- introspection builder (DESIGN §4) -------------------------------------

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
    import types as _types
    origin = typing.get_origin(annot)
    if origin is typing.Union or str(origin) == "types.UnionType" or origin is getattr(_types, "UnionType", None):
        args = [a for a in typing.get_args(annot) if a is not type(None)]
        is_opt = len(args) != len(typing.get_args(annot))
        if len(args) == 1:
            return args[0], is_opt
        return annot, is_opt  # genuine multi-type union, keep as-is
    return annot, False


def _canonical_type(annot) -> str | None:
    """Coarse type name for dictionary type-only matches (spec §1.2)."""
    inner, _ = _strip_optional(annot)
    return {bool: "bool", int: "int", float: "float", str: "str"}.get(inner)


def _schema_for(annot, default, has_default) -> tuple[dict, str, bool]:
    """Map an annotation to (json_schema_fragment, widget, serializable)."""
    inner, _ = _strip_optional(annot)
    origin = typing.get_origin(inner)

    if origin is typing.Literal:
        vals = list(typing.get_args(inner))
        if all(isinstance(v, bool) for v in vals):
            return {"type": "boolean", "enum": vals}, "select", True
        if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals):
            return {"type": "number", "enum": vals}, "select", True
        if all(isinstance(v, str) for v in vals):
            return {"type": "string", "enum": vals}, "select", True
        return {"type": "string", "enum": [str(v) for v in vals]}, "select", True

    if origin in (list, tuple) or _annot_str(inner).startswith(("collections.abc.Sequence", "typing.Sequence")):
        return {"type": "array", "items": {"type": "string"}}, "multitext", True

    if inner in _SCALAR_SCHEMA:
        sch = dict(_SCALAR_SCHEMA[inner])
        return sch, ("checkbox" if inner is bool else "number" if inner in (int, float) else "text"), True

    s = _annot_str(inner)
    if origin is dict or s.startswith(("dict", "typing.Dict", "collections.abc.Mapping", "typing.Mapping")):
        return {"type": ["object", "null"]}, "json", True

    NON_SERIALIZABLE = ("Callable", "ndarray", "Colormap", "Axes", "Figure", "function",
                        "Container", "Graph", "NDArray", "dtype", "type")
    if any(t in s for t in NON_SERIALIZABLE):
        return {"type": "string"}, "text", False

    return {"type": "string"}, "text", True


def _parse_param_docs(doc: str) -> dict:
    """Best-effort numpydoc Parameters section -> {param: first-line description}."""
    out = {}
    lines = doc.splitlines()
    in_params = False
    cur = None
    for ln in lines:
        st = ln.strip()
        if st == "Parameters":
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


def build_squidpy_function(namespace: str, name: str, fn) -> SquidpyFunction | None:
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
            injected[pname] = kind  # type-injected data slot (core §4.6), not a form param
            continue

        has_default = p.default is not inspect.Parameter.empty
        default = p.default if has_default else None
        base_schema, type_widget, serializable = _schema_for(annot, default, has_default)

        res = DICTIONARY.resolve(
            key=f"{namespace}.{name}", name=pname, canonical_type=_canonical_type(annot),
            base_schema=base_schema, type_widget=type_widget, serializable=serializable,
            has_default=has_default, default=default,
        )
        if res.action == "pin":
            pinned[pname] = res.pin_value
            continue
        if res.action == "lock":
            unsupported.append(pname)  # managed-hidden or non-serializable: locked to its default
            if not has_default:
                partially = True
            continue

        params.append(ParamSpec(
            name=pname, schema=res.schema, widget=res.widget, bound_to=res.bound_to,
            required=not has_default, tooltip=res.tooltip or param_docs.get(pname, ""),
            role=res.role,
        ))

    effect = "plot" if namespace == "pl" else ("read" if namespace == "read" else "compute")
    return SquidpyFunction(
        key=f"{namespace}.{name}", namespace=namespace, function=name,
        effect_class=effect, summary=summary, doc=doc, injected=injected, pinned=pinned,
        params=params, partially_supported=partially, unsupported_params=unsupported,
    )
