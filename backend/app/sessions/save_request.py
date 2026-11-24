"""What a checkpoint save may be asked for: the destination, the session name, and the
element / pyramid-level / table-slot / figure selections, each checked against the
session before the job is queued. Shared by the save route and the MCP save_checkpoint
tool, so it raises a plain `SaveRequestError` and imports nothing of fastapi; the route
maps that onto 400 (main.save).
"""
from pathlib import Path

from ..config import config, within_data_dir


class SaveRequestError(ValueError):
    """A save request the session cannot honour: a destination outside DATA_DIR, a name
    that isn't one, or a selection naming something the session doesn't hold."""


def require_save_path(path: str) -> None:
    """Refuse a checkpoint target outside DATA_DIR. Run where a caller's verbatim path
    enters (`validated_destination`, the points-transform route) so a bad one is refused
    before a job is queued, and again by the save and set_transform jobs before they
    touch the session — which is what keeps a refused job from leaving the session
    renamed or its transform rewritten."""
    if not within_data_dir(Path(path).resolve()):
        raise SaveRequestError("save path is outside the data directory")


def default_save_path(sess, folder: str | None = None, prefix: str | None = None) -> str:
    """Checkpoint path to use when the caller doesn't give one explicitly — shared by
    the save/points-transform routes and the MCP save_checkpoint tool. The filename's
    content-hash suffix is (re)computed from the written bytes on every save (see
    `_save_zip`), so this only needs the checkpoint's clean base name - stripping any
    hash (or extension) a previous save already appended keeps it from stacking a new
    one on top.

    `folder` (a directory under DATA_DIR, relative to it or absolute) and `prefix` (the
    filename stem the hash is appended to) are the Save dialog's destination fields;
    without them the file lands flat in DATA_DIR under the session's name. Both are
    validated by `validated_destination` — a caller reaching this directly must have
    checked them itself."""
    from ..persistence.store import strip_content_hash, strip_checkpoint_ext, CHECKPOINT_EXT
    stem = strip_content_hash(strip_checkpoint_ext(prefix or sess.name))
    return str(config.DATA_DIR / (folder or "") / f"{stem}{CHECKPOINT_EXT}")


def validated_payload(sess, body: dict) -> dict:
    """The save job's payload (`Session._run_save`) for a save request body, every field
    checked — so a bad one is refused here rather than surfacing as a failed job.

    The stem `prefix` falls back to is the session's name as it stands now; the rename
    lands on the worker together with the write, so a save that never runs leaves both
    the name and the file alone."""
    name = validated_name(body)
    path, hash_name = validated_destination(sess, body)
    return {"path": path, "hash_name": hash_name, "name": name,
            "include": validated_include(sess, body.get("include")),
            "levels": validated_levels(sess, body.get("levels")),
            "slots": validated_slots(sess, body.get("slots")),
            "figures": validated_figures(sess, body.get("figures"))}


def validated_include(sess, include) -> dict[str, list[str]] | None:
    """Check the save body's element selection against the session. A facet absent from
    `include` keeps that facet whole; a facet present keeps exactly the names listed, so
    `{"images": []}` drops every image."""
    if include is None:
        return None
    from ..registry.base import sdata_facets
    if not isinstance(include, dict):
        raise SaveRequestError("include must be an object of facet -> element names")
    facets = sdata_facets()
    out: dict[str, list[str]] = {}
    for facet, names in include.items():
        if facet not in facets:
            raise SaveRequestError(f"unknown element facet '{facet}'")
        if not isinstance(names, list):
            raise SaveRequestError(f"include['{facet}'] must be a list of element names")
        have = set(getattr(sess.sdata, facet, None) or {})
        missing = sorted(n for n in names if n not in have)
        if missing:
            raise SaveRequestError(f"unknown {facet} element(s): {', '.join(missing)}")
        out[facet] = list(names)
    kept = out.get("tables")
    # Dropping the table the displays and every field path are resolved against would
    # produce a checkpoint that reopens with nothing to show.
    if kept is not None and sess.active_table_key is not None:
        if sess.active_table_key not in kept:
            raise SaveRequestError("the active table must be included in the saved checkpoint")
        # `select_elements` keeps the listed order, and a display names no table — it
        # resolves against the first one. So a list that includes the active table but
        # does not lead with it would hand the reopened checkpoint a different default
        # table than the app_state written beside it describes. Reordering keeps both
        # tables and costs nothing; the order carries no other meaning.
        out["tables"] = [sess.active_table_key] + [n for n in kept if n != sess.active_table_key]
    return out


def validated_levels(sess, levels) -> dict[str, int] | None:
    """Check the save body's per-image resolution choice — image name -> index of the
    finest pyramid level to write, coarser levels always kept, so 0 writes the whole
    pyramid. Levels a caller left at 0 are dropped here, so an all-0 request is
    indistinguishable from no request at all and keeps the incremental fast path."""
    if not levels:
        return None
    if not isinstance(levels, dict):
        raise SaveRequestError("levels must be an object of image name -> level index")
    from .. import imaging
    out: dict[str, int] = {}
    for name, finest in levels.items():
        if name not in (getattr(sess.sdata, "images", None) or {}):
            raise SaveRequestError(f"unknown images element '{name}'")
        depth = len(imaging.image_levels(sess.sdata, name))
        if not isinstance(finest, int) or isinstance(finest, bool) or not 0 <= finest < depth:
            raise SaveRequestError(f"levels['{name}'] must be an integer in 0..{depth - 1}")
        if finest:
            out[name] = finest
    return out or None


def validated_slots(sess, slots) -> dict[str, list[str]] | None:
    """Check the save body's per-table slot selection — table name -> the slot paths to
    write (`store.table_slot_paths`' vocabulary). A table absent from `slots` is written
    whole; a table present keeps exactly the paths listed. Two things a selection may
    not drop, because the resulting file would not open onto what it claims to hold:
    the structurally required slots (`store.REQUIRED_TABLE_SLOTS`), and an `obsm` key a
    display reads its coordinates or its embedding from — `coords` and `obsm_key` are
    non-nullable in `app_state.schema.json`, so unlike a coloring they cannot be
    neutralised."""
    if not slots:
        return None
    if not isinstance(slots, dict):
        raise SaveRequestError("slots must be an object of table name -> slot paths")
    from ..persistence import store
    out: dict[str, list[str]] = {}
    for name, paths in slots.items():
        adata = (getattr(sess.sdata, "tables", None) or {}).get(name)
        if adata is None:
            raise SaveRequestError(f"unknown tables element '{name}'")
        if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
            raise SaveRequestError(f"slots['{name}'] must be a list of slot paths")
        have = store.table_slot_paths(adata)
        if unknown := sorted(set(paths) - set(have)):
            raise SaveRequestError(f"unknown slot(s) in table '{name}': {', '.join(unknown)}")
        if missing := [p for p in store.REQUIRED_TABLE_SLOTS if p not in paths]:
            raise SaveRequestError(
                f"table '{name}' cannot be saved without: {', '.join(missing)}")
        for key in _display_obsm_keys(sess) if name == sess.active_table_key else ():
            if f"obsm/{key}" in have and f"obsm/{key}" not in paths:
                raise SaveRequestError(f"obsm/{key} is used by a display and must be saved")
        out[name] = list(paths)
    return out


def _display_obsm_keys(sess) -> set[str]:
    """The obsm keys the session's displays resolve against: an embedding's `obsm_key`
    and a spatial display's `coords` (an `obsm:<key>` field path)."""
    keys = set()
    for d in sess.app_state.get("displays", []):
        enc = d.get("encoding") or {}
        if key := enc.get("obsm_key"):
            keys.add(key)
        element, _, key = (enc.get("coords") or "").partition(":")
        if element == "obsm" and key:
            keys.add(key)
    return keys


def validated_figures(sess, figures) -> list[str] | None:
    """Check the save body's figure selection: `null`/absent keeps every drawn plot's
    figure, a list keeps exactly those plot ids (`[]` writes no figures at all). Ids that
    aren't drawn plots are a client bug, not something to silently drop."""
    if figures is None:
        return None
    if not isinstance(figures, list) or not all(isinstance(p, str) for p in figures):
        raise SaveRequestError("figures must be a list of plot ids")
    missing = sorted(set(figures) - sess.drawn_plot_ids())
    if missing:
        raise SaveRequestError(f"no drawn plot(s) with id(s): {', '.join(missing)}")
    return figures


def validated_name(body) -> str | None:
    """The save body's session name: what the checkpoint records as its own name
    (`app_state["name"]`, adopted again when the file is reloaded) and what the live
    session is renamed to. Absent leaves both alone."""
    name = body.get("name")
    if name is None:
        return None
    if not isinstance(name, str) or not name.strip():
        raise SaveRequestError("name must be a non-empty string")
    return name.strip()


def validated_destination(sess, body) -> tuple[str, bool]:
    """Resolve the save body's destination to (path, hash_name).

    `path` is the verbatim escape hatch — written exactly as given, with no content-hash
    suffix (the MCP save_checkpoint tool and the offline harness use it). The Save dialog
    instead sends `folder` (a directory under DATA_DIR, created if it doesn't exist) and
    `prefix` (the filename stem), which compose onto `default_save_path` and so keep the
    hash suffix. A path or folder outside DATA_DIR, or a prefix that isn't a plain
    filename, is refused here rather than as a job that fails minutes into a multi-GB
    write."""
    explicit = body.get("path")
    folder, prefix = body.get("folder"), body.get("prefix")
    if explicit is not None and (folder is not None or prefix is not None):
        raise SaveRequestError("path cannot be combined with folder or prefix")
    if explicit is not None:
        if not isinstance(explicit, str) or not explicit.strip():
            raise SaveRequestError("path must be a non-empty string")
        require_save_path(explicit)
        return explicit, False
    if folder is not None:
        if not isinstance(folder, str):
            raise SaveRequestError("folder must be a string")
        target = (config.DATA_DIR / folder).resolve()
        if not within_data_dir(target):
            raise SaveRequestError("folder is outside the data directory")
        if target.exists() and not target.is_dir():
            raise SaveRequestError(f"'{folder}' is not a directory")
    if prefix is not None:
        if not isinstance(prefix, str) or not prefix.strip():
            raise SaveRequestError("prefix must be a non-empty string")
        prefix = prefix.strip()
        # One path component, and not dot-prefixed: the dataset scanner skips names
        # starting with "." (it is how save staging hides itself), so such a checkpoint
        # would never appear in the load picker.
        if "/" in prefix or "\\" in prefix or prefix.startswith("."):
            raise SaveRequestError("prefix must be a filename with no path separators")
    return default_save_path(sess, folder, prefix), True
