"""Which reader params are filesystem paths, and how the New Session form picks them.

A reader's params fall into three path groups plus plain values:
- the **primary** acquisition path (one per reader): a folder for every reflected
  spatialdata-io reader; the custom zarr reader overrides its own to 'either';
- **absolute** file-path params, validated against the data root directly;
- **relative** filename params the reader joins onto its primary path
  (`Path(primary) / value`), e.g. nanostring's counts_file / meta_file.

`validate_reader_params` below validates the first two groups as absolute paths within
the data root and the third relative to the descriptor's own primary path. The form
renders a folder/file picker per group, driven by the per-param `path_kind`
(and, for relative files, `bound_to` naming the primary param to root against).
"""
from pathlib import Path

from ..config import resolve_within_data_dir

# The primary acquisition path a reader takes (only one of these appears per reader).
PRIMARY_PATH_PARAMS = ("path", "input", "store")
# Absolute file-path params (their own validation against the data root).
ABSOLUTE_FILE_PARAMS = ("image_path", "alignment_file")
# Filename params a reader resolves relative to its primary path.
RELATIVE_FILE_PARAMS = ("counts_file", "meta_file", "fov_file", "transformation_file",
                        "source_image_path", "fullres_image_file", "tissue_positions_file",
                        "scalefactors_file", "vpt_outputs")

# Params validated as absolute paths within the data root (validate_reader_params).
ABSOLUTE_PATH_PARAMS = PRIMARY_PATH_PARAMS + ABSOLUTE_FILE_PARAMS

# The two namespaces a reader can live in: squidpy's `read` and spatialdata-io's `io`.
READER_NAMESPACES = ("read", "io")


def reader_namespace(source: dict) -> str:
    """The reader namespace named by `source`, required rather than defaulted.

    Several reader names exist in BOTH namespaces (`visium` is `read.visium` and
    `io.visium`), so defaulting silently picks one library's reader over the other's —
    and the HTTP route and the MCP tool previously defaulted differently, meaning the
    same request read a different format depending on which surface served it. The
    frontend always sends the namespace explicitly (`NewSessionSource`), so demanding it
    costs the app nothing and removes the ambiguity."""
    ns = source.get("namespace")
    if ns not in READER_NAMESPACES:
        raise RuntimeError(
            f"reader namespace must be one of {' | '.join(READER_NAMESPACES)}, got {ns!r} "
            "(several reader names exist in both, so there is no safe default)")
    return ns


def _path_strings(value, seen: set | None = None):
    """Every non-empty string leaf reachable from `value`, walking dicts and lists.

    A path param is not always a plain string: merscope's `vpt_outputs` is documented as
    `Path | str | dict`, and spatialdata-io's `_get_file_paths` hands that dict's values
    to the filesystem verbatim. Only the values are paths — the dict's keys are the
    reader's own fixed field names. `seen` breaks a self-referential structure; params
    that arrive as JSON cannot contain a cycle, but a descriptor built in-process (MCP,
    a bundled recipe) is an ordinary Python object and could."""
    if isinstance(value, str):
        if value:
            yield value
        return
    if not isinstance(value, (dict, list, tuple)):
        return  # a number/bool/None can never reach the filesystem as a path
    if seen is None:
        seen = set()
    if id(value) in seen:
        return
    seen.add(id(value))
    for item in (value.values() if isinstance(value, dict) else value):
        yield from _path_strings(item, seen)


def validate_reader_params(params: dict) -> None:
    """Containment-check every path-valued reader param in `params`; raise RuntimeError
    on the first that escapes DATA_DIR.

    Applies wherever a read-effect descriptor enters the system — session creation
    (`SessionManager.create_from_read`) *and* a reader re-run on an already-open session
    (`Session.enqueue_descriptor`/`stage_descriptor`/`edit_pending`), which is a
    supported flow (see the re-import note in sessions/session.py). Validating only at
    creation would leave every job/recipe/MCP route able to read an arbitrary store.

    `Path(base) / value` silently DISCARDS `base` when `value` is itself absolute — so a
    relative filename param given as a string is re-joined against the descriptor's own
    primary path and the join is what gets checked, catching both that discard and a
    `../..` traversal.

    A param supplied as a dict or list is checked leaf by leaf against the data root
    directly, with no join: the only reader that takes one (merscope's `vpt_outputs`)
    uses those values as complete paths rather than resolving them against `path`, so
    joining would check a location the reader never opens."""
    base_path = params.get("path")
    joinable = isinstance(base_path, str) and base_path
    for name, value in params.items():
        if name in ABSOLUTE_PATH_PARAMS:
            for leaf in _path_strings(value):
                resolve_within_data_dir(leaf)
        elif name in RELATIVE_FILE_PARAMS:
            if isinstance(value, str):
                if value and joinable:
                    resolve_within_data_dir(str(Path(base_path) / value))
            else:
                for leaf in _path_strings(value):
                    resolve_within_data_dir(leaf)


def primary_path_param(names) -> str | None:
    """The reader's own primary path param among `names`, or None."""
    return next((n for n in names if n in PRIMARY_PATH_PARAMS), None)


def classify_path_param(name: str, primary: str | None, primary_kind: str):
    """`(path_kind, base_param)` for a reader param, or None if it's a plain value.

    `primary` is the reader's primary path param name (the base a relative file roots
    against); `primary_kind` is the picker mode for that primary param
    ('folder' | 'file' | 'either')."""
    if name in PRIMARY_PATH_PARAMS:
        return (primary_kind, None)
    if name in ABSOLUTE_FILE_PARAMS:
        return ("file", None)
    if name in RELATIVE_FILE_PARAMS:
        return ("file", primary)
    return None
