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
    "ai_context": [],     # self-curated agent memory (v3 Part 7); persists into .zarr.zip
    "ai_transcript": [],  # human-readable chat record (v3 Part 8.4); never replayed to the model
}


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
    if v < 3:
        st.setdefault("ai_context", [])
        st.setdefault("ai_transcript", [])
    st["schema_version"] = SCHEMA_VERSION
    return st


def bump_versions(st: dict, field_paths) -> dict:
    dv = st.setdefault("data_versions", {})
    for fp in field_paths:
        dv[fp] = dv.get(fp, 0) + 1
    return dv
