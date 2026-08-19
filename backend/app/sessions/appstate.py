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
    """Upgrade older blobs to `SCHEMA_VERSION`; a newer-than-app blob is left intact
    (caller may warn). Raises ValueError when the result does not actually conform.

    The steps below only establish the top-level collections. `app_state.schema.json` is
    far stricter than that — `additionalProperties: false` at every level, and each
    compute_history/plot entry requires `library_versions` plus its own per-kind fields —
    and no step here can retro-fit a key from a blob that never carried one, or name the
    unknown keys a foreign blob might carry. So the version stamp is verified rather than
    asserted: without the check a non-conforming blob loads fine and first fails inside
    the save job's `validate_app_state`, an error the user meets long after the load that
    should have caught it, with the session's work already on top of it.

    What is validated is the blob's *persisted projection*, not the blob: the schema
    describes what reaches disk, and a live record's `_log` is stripped into
    logs/<id>.log.gz on the way there (`store._split_logs`), so a session in memory — and
    a checkpoint old enough to still carry its logs inline — legitimately fails the schema
    as-is. Reusing the save path's own splitter keeps the two from drifting into a state
    where a load rejects a blob a save would happily have written.

    A blob NEWER than this app is deliberately not checked — it opens read-only against a
    schema it postdates, and rejecting it would contradict that (DESIGN §5,
    docs/CHECKPOINT_FORMAT.md §9)."""
    v = st.get("schema_version", 0)
    if v < 1:
        st.setdefault("compute_history", [])
        st.setdefault("plots", [])
        st.setdefault("displays", [])
        st.setdefault("data_versions", {})
    if v < 2:
        st.setdefault("regions", [])
    if v <= SCHEMA_VERSION:
        import jsonschema
        from ..persistence.store import _split_logs
        from ..schemas import checkpoint as checkpoint_schemas
        st["schema_version"] = SCHEMA_VERSION
        try:
            checkpoint_schemas.validate_app_state(_split_logs(st)[0])
        except jsonschema.ValidationError as e:
            where = "/".join(str(p) for p in e.absolute_path) or "(root)"
            raise ValueError(
                f"this checkpoint's app_state (schema_version {v}) cannot be migrated to "
                f"version {SCHEMA_VERSION}: {e.message} — at app_state/{where}") from e
    return st


def bump_versions(st: dict, field_paths) -> dict:
    dv = st.setdefault("data_versions", {})
    for fp in field_paths:
        dv[fp] = dv.get(fp, 0) + 1
    return dv


# Display-encoding keys that name an sdata element, and the facet each is drawn from.
# `coords` is an obsm path and `color_by` is table-scoped, so neither is an element
# reference and neither appears here. A dropped *table* is therefore not this function's
# job either: it is `prune_to_table_slots` that clears the colorings, called with an
# empty `kept` when the whole table goes (`store.save_spatialdata`).
_ELEMENT_REFS = {"image_layer": "images", "shapes_layer": "shapes"}


def color_by_slot(path: str) -> str | None:
    """The table slot a `color_by` field path reads, in `store.table_slot_paths`'
    vocabulary — `X:CD3` -> `X`, `layers:counts/CD3` -> `layers/counts`, `obs:leiden`
    -> `obs`. None for a path that names no slot (an empty or malformed one)."""
    element, _, key = path.partition(":")
    if not element or not key:
        return None
    if element == "layers":
        layer, _, gene = key.partition("/")
        return f"layers/{layer}" if gene else None
    return element


def prune_to_table_slots(st: dict, kept: set[str]) -> dict:
    """Copy of `st` with display `color_by` paths that read a dropped table slot
    cleared.

    The table half of `prune_to_elements`: a save can leave out the expression matrix
    or a layer (`store.trim_table`), and a display still coloring by `X:<gene>` would
    then look up a matrix the file doesn't hold. `color_by` is nullable in
    `app_state.schema.json`, so clearing it leaves the display rendering its cells in
    flat grey (`useSpotColors`). `kept` is the surviving slot paths of the table
    displays resolve against — empty when that table is not in the file at all, which
    reads correctly here: no slot of it survives, so every coloring is cleared. Returns
    `st` unchanged (same object) when nothing needs clearing.
    """
    stale = [
        i for i, d in enumerate(st.get("displays", []))
        if (slot := color_by_slot((d.get("encoding") or {}).get("color_by") or ""))
        and slot not in kept
    ]
    if not stale:
        return st
    out = dict(st)
    out["displays"] = [dict(d) for d in st["displays"]]
    for i in stale:
        out["displays"][i]["encoding"] = {**out["displays"][i]["encoding"], "color_by": None}
    return out


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
