"""Application state lives in `sdata.attrs["app_state"]` (DESIGN §3.2, §16.4).
Versioned; migrated on load (§13). Pure dict manipulation — serializes to Zarr.
"""
SCHEMA_VERSION = 1

EMPTY = {
    "schema_version": SCHEMA_VERSION,
    "compute_history": [],
    "plots": [],
    "displays": [],
    "data_versions": {},  # field_path -> monotonic counter (DESIGN §9.3)
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
        st["schema_version"] = 1
    return st


def bump_versions(st: dict, field_paths) -> dict:
    dv = st.setdefault("data_versions", {})
    for fp in field_paths:
        dv[fp] = dv.get(fp, 0) + 1
    return dv
