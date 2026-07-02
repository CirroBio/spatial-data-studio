"""Image serving for the canvas background (DESIGN §9.2). A full z/x/y tile
pyramid is overkill at cell/observation scale; we serve a single downscaled
thumbnail plus its extent in world coordinates, which a deck.gl BitmapLayer
places under the points. (TileLayer remains a later enhancement.)
"""
import io

import numpy as np


def _image_array(sdata, element):
    if element not in sdata.images:
        raise KeyError(f"image element '{element}' not found")
    el = sdata.images[element]
    # multiscale (DataTree): pick the coarsest scale for a thumbnail
    if hasattr(el, "children") or el.__class__.__name__ in ("DataTree", "Datatree"):
        scales = sorted(el.children.keys()) if hasattr(el, "children") else sorted(el.keys())
        node = el[scales[-1]]
        arr = node["image"] if hasattr(node, "__getitem__") and "image" in getattr(node, "data_vars", {}) else node
    else:
        arr = el
    return arr


def channel_names(elem) -> list[str]:
    """Channel labels for an image element, multiscale (DataTree) or plain.
    Falls back through the `c` coord, the `c` dim size, and finally a shape
    guess, since not every reader attaches explicit channel names/coords.
    """
    arr = elem
    if hasattr(elem, "children") or elem.__class__.__name__ in ("DataTree", "Datatree"):
        try:
            scale0 = next(iter(elem.children.values()))
            arr = next(iter(scale0.values()))
        except (StopIteration, AttributeError):
            arr = elem
    try:
        return [str(c) for c in arr.coords["c"].values]
    except (KeyError, AttributeError):
        pass
    try:
        return [str(i) for i in range(arr.sizes["c"])]
    except (KeyError, AttributeError):
        pass
    n = arr.shape[0] if getattr(arr, "ndim", 0) == 3 else 1
    return [str(i) for i in range(n)]


def _to_hwc_uint8(arr, visible: list[int] | None = None) -> np.ndarray:
    data = np.asarray(arr.data if hasattr(arr, "data") else arr)
    # spatialdata images are (c, y, x)
    if data.ndim == 3:
        data = np.transpose(data, (1, 2, 0))
    elif data.ndim == 2:
        data = data[:, :, None]
    nch = data.shape[2]
    if visible is None:
        visible = list(range(nch))
    vis = [c for c in visible if 0 <= c < nch]

    if nch == 3:
        # RGB-like: keep the channel->colour mapping, zero hidden channels.
        out = data.copy()
        for c in range(3):
            if c not in vis:
                out[:, :, c] = 0
    elif len(vis) == 0:
        out = np.zeros((data.shape[0], data.shape[1], 3), dtype=data.dtype)
    elif len(vis) == 1:
        out = np.repeat(data[:, :, vis[:1]], 3, axis=2)  # single channel -> grayscale
    else:
        chans = [data[:, :, c] for c in vis[:3]]
        while len(chans) < 3:
            chans.append(np.zeros_like(chans[0]))
        out = np.stack(chans, axis=2)

    if out.dtype != np.uint8:
        d = out.astype("float32")
        mx = float(d.max()) or 1.0
        out = np.clip(d / mx * 255.0, 0, 255).astype("uint8")
    return out


def _extent(sdata, element):
    """World-coordinate bounds [xmin, ymin, xmax, ymax] of the image element."""
    try:
        from spatialdata import get_extent
        ext = get_extent(sdata.images[element])
        return [float(ext["x"][0]), float(ext["y"][0]), float(ext["x"][1]), float(ext["y"][1])]
    except Exception:
        arr = _image_array(sdata, element)
        h = arr.shape[-2]
        w = arr.shape[-1]
        return [0.0, 0.0, float(w), float(h)]


def image_info(sdata, element) -> dict:
    arr = _image_array(sdata, element)
    return {"element": element, "height": int(arr.shape[-2]), "width": int(arr.shape[-1]),
            "channels": int(arr.shape[0]) if arr.ndim == 3 else 1,
            "channel_names": channel_names(arr),
            "bounds": _extent(sdata, element)}


def thumbnail_png(sdata, element, max_px: int = 2048, visible: list[int] | None = None) -> bytes:
    from PIL import Image
    arr = _image_array(sdata, element)
    hwc = _to_hwc_uint8(arr, visible)
    img = Image.fromarray(hwc)
    img.thumbnail((max_px, max_px))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
