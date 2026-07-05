"""Seed manifest contributors (v3 Part 3.2). Each reads session state and emits a
labeled text block. They reuse `transport.arrow.describe_fields`/`field_kind` so
the agent's view of "which columns are categorical" matches the Arrow transport
exactly (no second definition)."""
from __future__ import annotations

from .registry import contributor
from .. import imaging
from ..transport import arrow

_MAX_CATS = 50


def _active_adata(session):
    try:
        return session.active_table()
    except RuntimeError:
        return None


@contributor("SpatialData")
def spatialdata_repr(session) -> str | None:
    if session.sdata is None:
        return None
    return str(session.sdata)


@contributor("Tables")
def tables(session) -> str | None:
    sdata = session.sdata
    if sdata is None or not getattr(sdata, "tables", {}):
        return None
    lines = []
    for name, tbl in sdata.tables.items():
        active = " (active)" if name == session.active_table_key else ""
        lines.append(f"- {name}{active}: {tbl.n_obs} obs x {tbl.n_vars} vars")
        fields = arrow.describe_fields(tbl, sdata)
        obs_cols = ", ".join(f"{f['name']}:{f['kind']}" for f in fields["obs"]) or "(none)"
        lines.append(f"    obs[{len(fields['obs'])}]: {obs_cols}")
        obsm = fields.get("obsm") or []
        if obsm:
            rendered = ", ".join(f"{f['name']}({f['n_components']})" for f in obsm)
            lines.append(f"    obsm: {rendered}")
        for facet in ("obsp", "layers"):
            keys = fields.get(facet) or []
            if keys:
                lines.append(f"    {facet}: {', '.join(keys)}")
        uns_keys = list(getattr(tbl, "uns", {}).keys())
        if uns_keys:
            lines.append(f"    uns: {', '.join(uns_keys)}")
    return "\n".join(lines)


@contributor("Categoricals")
def categoricals(session) -> str | None:
    adata = _active_adata(session)
    if adata is None:
        return None
    lines = []
    for f in arrow.describe_fields(adata, session.sdata)["obs"]:
        if f["kind"] != "categorical":
            continue
        counts = adata.obs[f["name"]].astype(str).value_counts()
        shown = ", ".join(f"{v} ({n})" for v, n in counts.head(_MAX_CATS).items())
        if len(counts) > _MAX_CATS:
            shown += f", (+{len(counts) - _MAX_CATS} more)"
        lines.append(f"- {f['name']}: {shown}")
    return "\n".join(lines) if lines else None


@contributor("Region sets")
def region_sets(session) -> str | None:
    regions = session.app_state.get("regions") or []
    if not regions:
        return None
    lines = []
    for rs in regions:
        cats = ", ".join(f"{c['label']} ({c['n_cells']})" for c in rs.get("categories", []))
        lines.append(f"- {rs['name']} [obs:{rs.get('obs_column')}]: {cats or '(empty)'}")
    return "\n".join(lines)


@contributor("Images")
def images(session) -> str | None:
    sdata = session.sdata
    if sdata is None or not getattr(sdata, "images", {}):
        return None
    # per-element channel display state lives in the display spec (Part 10)
    chan_state = {}
    for disp in session.app_state.get("displays", []):
        cs = (disp.get("encoding") or {}).get("channels")
        if cs:
            chan_state[disp["encoding"].get("image_layer")] = cs
    lines = []
    for name, elem in sdata.images.items():
        names = imaging.channel_names(elem)
        states = chan_state.get(name) or {}
        chans = []
        for i, cn in enumerate(names):
            st = states.get(str(i)) or states.get(cn) or {}
            disp_name = st.get("name", cn)
            on = "off" if st.get("visible") is False else "on"
            chans.append(f'"{disp_name}"({on})' if disp_name != cn else f"{cn}({on})")
        lines.append(f"- {name}: {len(names)}ch [{', '.join(chans)}]")
    return "\n".join(lines)


@contributor("Summaries")
def summaries(session) -> str | None:
    adata = _active_adata(session)
    if adata is None:
        return None
    lines = [f"- total cells: {adata.n_obs}", f"- total genes: {adata.n_vars}"]
    obs = adata.obs
    if "n_genes_by_counts" in obs:
        lines.append(f"- median genes/cell: {float(obs['n_genes_by_counts'].median()):.0f}")
    if "total_counts" in obs:
        lines.append(f"- median counts/cell: {float(obs['total_counts'].median()):.0f}")
    return "\n".join(lines)


@contributor("Recent context")
def recent_context(session) -> str | None:
    notes = session.app_state.get("ai_context") or []
    if not notes:
        return None
    recent = notes[-5:]
    return "\n".join(f"- {n}" for n in recent if isinstance(n, str)) or None
