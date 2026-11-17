"""Corrections to what a reflected spatialdata-io reader returns, applied in the read
call's child process before the session adopts the object (registry/kernel.py)."""


def name_steinbock_channels(sdata):
    """Name each steinbock image's channels after the table's markers.

    spatialdata-io's steinbock reader loads every `ome/*.ome.tiff` with `imread`, which
    drops the OME channel names, so the channels arrive numbered 0..n-1 (or as r, g, b
    when there are exactly three, which spatialdata takes for RGB) and the viewer's
    channel picker can't say which marker is which. steinbock writes an image's channels
    in the order of the panel's kept rows, the same order as `cells.h5ad`'s var
    (https://bodenmillergroup.github.io/steinbock/latest/file-types/), so the table's
    marker names are the channel names."""
    from spatialdata.models import get_channel_names, set_channel_names

    markers = [str(name) for name in sdata.tables["table"].var_names]
    for name, image in list(sdata.images.items()):
        n_channels = len(get_channel_names(image))
        if n_channels != len(markers):
            raise ValueError(f"steinbock image {name!r} has {n_channels} channels but cells.h5ad "
                             f"has {len(markers)} markers, so its channels can't be named")
        sdata.images[name] = set_channel_names(image, markers)
    return sdata
