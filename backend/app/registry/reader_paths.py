"""Which reader params are filesystem paths, and how the New Session form picks them.

A reader's params fall into three path groups plus plain values:
- the **primary** acquisition path (one per reader): a folder for every reflected
  spatialdata-io reader; the custom zarr reader overrides its own to 'either';
- **absolute** file-path params, validated against the data root directly;
- **relative** filename params the reader joins onto its primary path
  (`Path(primary) / value`), e.g. nanostring's counts_file / meta_file.

`sessions/manager.py` validates the first two groups as absolute paths within the
data root and the third relative to the descriptor's own primary path. The form
renders a folder/file picker per group, driven by the per-param `path_kind`
(and, for relative files, `bound_to` naming the primary param to root against).
"""

# The primary acquisition path a reader takes (only one of these appears per reader).
PRIMARY_PATH_PARAMS = ("path", "input", "store")
# Absolute file-path params (their own validation against the data root).
ABSOLUTE_FILE_PARAMS = ("image_path", "alignment_file")
# Filename params a reader resolves relative to its primary path.
RELATIVE_FILE_PARAMS = ("counts_file", "meta_file", "fov_file", "transformation_file",
                        "source_image_path", "fullres_image_file", "tissue_positions_file",
                        "scalefactors_file", "vpt_outputs")

# Params validated as absolute paths within the data root (manager._resolve_or_raise).
ABSOLUTE_PATH_PARAMS = PRIMARY_PATH_PARAMS + ABSOLUTE_FILE_PARAMS


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
