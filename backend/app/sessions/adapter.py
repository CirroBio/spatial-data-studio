"""The single call adapter (DESIGN §4.6). Every squidpy call — every namespace,
every function — executes through `CallAdapter.execute`. Per-function variation is
absorbed by the introspected descriptor; the only branch is on `effect_class`.
"""
import contextlib
import io
import logging
import threading
import traceback
from dataclasses import dataclass, field

from ..registry.introspect import REGISTRY

# pyplot state is process-global; sessions plot concurrently (DESIGN §4.6 step 6).
_PLOT_LOCK = threading.Lock()

def _short_error(e: Exception) -> str:
    """A concise, user-facing error string for the failure toast."""
    msg = str(e).strip().splitlines()[0] if str(e).strip() else e.__class__.__name__
    return f"{e.__class__.__name__}: {msg}"[:300]


_TABLE_FACETS = ["obs", "var", "obsm", "obsp", "layers", "uns"]
_SDATA_FACETS = ["images", "labels", "points", "shapes", "tables"]


@dataclass
class CallResult:
    status: str                       # completed | drawn | failed
    log: str = ""
    structural_diff: dict = field(default_factory=dict)
    changed_fields: list = field(default_factory=list)  # field paths for version bump
    figure_svg: bytes | None = None
    figure_pdf: bytes | None = None
    new_object: object | None = None
    error: str | None = None


@contextlib.contextmanager
def _capture_log():
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


def _keyset(adata, sdata) -> dict:
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


def _diff(before: dict, after: dict) -> tuple[dict, list]:
    diff, fields = {}, []
    facet_to_element = {"obs": "obs", "var": "var", "obsm": "obsm", "obsp": "obsp", "layers": "layers"}
    for facet, after_map in after.items():
        bmap = before.get(facet, {})
        changed = sorted(k for k, v in after_map.items() if bmap.get(k) != v)
        if changed:
            diff[facet] = changed
            elem = facet_to_element.get(facet)
            if elem:
                fields.extend(f"{elem}:{k}" for k in changed)
    return diff, fields


class CallAdapter:
    def execute(self, descriptor: dict, session) -> CallResult:
        entry = REGISTRY.get(f"{descriptor['namespace']}.{descriptor['function']}")
        if entry is None:
            return CallResult(status="failed", error=f"unknown function {descriptor}")
        fn = REGISTRY.resolve_callable(entry.namespace, entry.function)

        try:
            injected = self._inject(entry, session)
            bound = self._bind_and_validate(entry, descriptor.get("params", {}), session)
        except Exception as e:
            return CallResult(status="failed", error=str(e), log=str(e))

        before = _keyset(session.active_table(), session.sdata) if entry.effect_class == "compute" else None

        with _capture_log() as buf:
            try:
                if entry.effect_class == "plot":
                    return self._run_plot(fn, injected, bound, buf)
                ret = fn(*injected, **bound)
            except Exception as e:
                return CallResult(status="failed", log=buf.getvalue() + "\n" + traceback.format_exc(),
                                  error=_short_error(e))
            log = buf.getvalue()

        return self._handle_effect(entry, ret, session, before, log)

    def _inject(self, entry, session) -> list:
        args = []
        for pname, kind in entry.injected.items():
            if kind == "adata":
                args.append(session.active_table())
            elif kind == "sdata":
                args.append(session.sdata)
            elif kind == "image":
                args.append(session.active_image())
        return args

    def _bind_and_validate(self, entry, params: dict, session) -> dict:
        bound = dict(entry.pinned)  # pinned policy params first (DESIGN §16, can't be overridden)
        # A `read` bootstrap job runs before any object exists; there is nothing to
        # validate convention-bound references against yet (DESIGN §12).
        adata = session.active_table() if session.sdata is not None else None
        by_name = {p.name: p for p in entry.params}
        for name, value in params.items():
            if name in entry.pinned:
                continue
            spec = by_name.get(name)
            if value is None or value == "" or value == []:
                continue  # unset -> let squidpy's own default apply
            if spec is not None and adata is not None:
                self._validate_reference(spec, value, adata)
            bound[name] = value
        # required form params must be present
        for p in entry.params:
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

    def _handle_effect(self, entry, ret, session, before, log) -> CallResult:
        if entry.effect_class == "read":
            return CallResult(status="completed", log=log, new_object=ret)

        adata = session.active_table()
        after = _keyset(adata, session.sdata)
        diff, fields = _diff(before, after)

        # Edge B: a function that always returns a data object despite copy=False.
        if ret is not None and not diff and ret.__class__.__name__ in ("AnnData", "SpatialData"):
            return CallResult(status="completed", log=log, new_object=ret)
        # Edge A: return-only function (non-None, empty diff) — surface the return.
        if ret is not None and not diff:
            session.stash_result(entry.key, ret)
        return CallResult(status="completed", log=log, structural_diff=diff, changed_fields=fields)

    def _run_plot(self, fn, injected, bound, buf) -> CallResult:
        import matplotlib
        matplotlib.use("Agg", force=True)
        import matplotlib.pyplot as plt
        with _PLOT_LOCK:
            try:
                plt.close("all")
                ret = fn(*injected, **bound)
                fig = self._figure_from(ret, plt)
                svg, pdf = io.BytesIO(), io.BytesIO()
                fig.savefig(svg, format="svg", bbox_inches="tight")
                fig.savefig(pdf, format="pdf", bbox_inches="tight")
                plt.close("all")
                return CallResult(status="drawn", log=buf.getvalue(),
                                  figure_svg=svg.getvalue(), figure_pdf=pdf.getvalue())
            except Exception as e:
                plt.close("all")
                return CallResult(status="failed", log=buf.getvalue() + "\n" + traceback.format_exc(),
                                  error=_short_error(e))

    @staticmethod
    def _figure_from(ret, plt):
        import numpy as np
        if ret is not None:
            axes = np.ravel(ret) if isinstance(ret, (list, tuple, np.ndarray)) else [ret]
            for a in axes:
                fig = getattr(a, "figure", None) or getattr(a, "get_figure", lambda: None)()
                if fig is not None:
                    return fig
        return plt.gcf()


ADAPTER = CallAdapter()
