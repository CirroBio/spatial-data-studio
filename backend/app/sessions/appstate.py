"""Application state lives in `sdata.attrs["app_state"]` (DESIGN §3.2, §16.4).
Versioned; migrated on load (§13). Pure dict manipulation — serializes to Zarr.
"""
SCHEMA_VERSION = 3

EMPTY = {
    "schema_version": SCHEMA_VERSION,
    "compute_history": [],
    "plots": [],
    "displays": [],
    "data_versions": {},  # field_path -> monotonic counter (DESIGN §9.3)
    "regions": [],        # region-set registry (post-build spec Part 2)
}

# Point styling a display falls back to when its encoding omits the field. Older
# checkpoints predate most of the optional encoding fields, so three readers have to
# agree on these: `manager.auto_displays` (which writes a session's first display), the
# canvas (`POINT_DEFAULTS` in packages/viewer/src/defaults.ts), and the server-side
# figure renderer (`snapshots.py`). They are defined once here because they had already
# drifted — the renderer defaulted point_size to 6 and opacity to 1.0 against the
# canvas's 4 and 0.85, so an exported figure of a pre-defaults checkpoint did not match
# the canvas it came from. `backend/test_e2e.py::run_encoding_defaults_parity` asserts
# this table still equals the TypeScript one.
POINT_ENCODING_DEFAULTS = {
    "point_size": 4,
    "opacity": 0.85,
    "colormap": "viridis",
}

# The rest of the fallbacks the figure renderer needs; the canvas keeps its own copies of
# these in the same defaults.ts tables.
DISPLAY_ENCODING_DEFAULTS = {
    **POINT_ENCODING_DEFAULTS,
    "legend_visible": True,
    "legend_title": "",
    "background": "dark",
}


def encoding_default(enc: dict, field: str):
    """`enc`'s value for `field`, or the shared fallback when it is absent or null.

    Treats an explicit None like an absent key: a checkpoint written before a field
    existed and one that stores it as null must render identically."""
    value = enc.get(field)
    return DISPLAY_ENCODING_DEFAULTS[field] if value is None else value


def ensure(attrs: dict) -> dict:
    st = attrs.get("app_state")
    if st is None:
        st = {k: (v.copy() if isinstance(v, (list, dict)) else v) for k, v in EMPTY.items()}
        attrs["app_state"] = st
    return migrate(st)


def fresh() -> dict:
    import copy
    return copy.deepcopy(EMPTY)


def migrate(st: dict) -> dict:
    """Upgrade older blobs; a newer-than-app blob is left intact (caller may warn)."""
    v = st.get("schema_version", 0)
    if v < 1:
        st.setdefault("compute_history", [])
        st.setdefault("plots", [])
        st.setdefault("displays", [])
        st.setdefault("data_versions", {})
    if v < 2:
        st.setdefault("regions", [])
    if v <= SCHEMA_VERSION:
        st["schema_version"] = SCHEMA_VERSION
    return st


def bump_versions(st: dict, field_paths) -> dict:
    dv = st.setdefault("data_versions", {})
    for fp in field_paths:
        dv[fp] = dv.get(fp, 0) + 1
    return dv


# Display-encoding keys that name an sdata element, and the facet each is drawn from.
# `coords` is an obsm path and `color_by` is table-scoped, so neither is an element
# reference and neither appears here.
_ELEMENT_REFS = {"image_layer": "images", "shapes_layer": "shapes"}


def prune_to_elements(st: dict, kept: dict[str, set[str]]) -> dict:
    """Copy of `st` with display encodings that name a dropped element neutralised.

    A selective save (`store.select_elements`) can omit an element a display still
    points at; left alone the written checkpoint would reference an image or shapes
    layer that isn't in the file, which the serverless viewer renders as a broken
    layer. Both reference keys are nullable in `app_state.schema.json`, so clearing
    them keeps the blob schema-valid and the display falls back to "no image" /
    "no boundaries".

    `kept` maps facet -> surviving element names. Returns `st` unchanged (same object)
    when nothing needs clearing, so the common full-save path copies nothing.
    """
    stale = [
        (i, key)
        for i, d in enumerate(st.get("displays", []))
        for key, facet in _ELEMENT_REFS.items()
        if (name := (d.get("encoding") or {}).get(key)) and name not in kept.get(facet, set())
    ]
    if not stale:
        return st
    out = dict(st)
    out["displays"] = [dict(d) for d in st["displays"]]
    for i, key in stale:
        out["displays"][i]["encoding"] = {**out["displays"][i]["encoding"], key: None}
    return out
