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


def _to_hwc_uint8(arr) -> np.ndarray:
    data = np.asarray(arr.data if hasattr(arr, "data") else arr)
    # spatialdata images are (c, y, x)
    if data.ndim == 3:
        data = np.transpose(data, (1, 2, 0))
    elif data.ndim == 2:
        data = data[:, :, None]
    if data.shape[2] >= 3:
        data = data[:, :, :3]
    else:
        data = np.repeat(data[:, :, :1], 3, axis=2)
    if data.dtype != np.uint8:
        d = data.astype("float32")
        mx = float(d.max()) or 1.0
        data = np.clip(d / mx * 255.0, 0, 255).astype("uint8")
    return data


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
            "bounds": _extent(sdata, element)}


def thumbnail_png(sdata, element, max_px: int = 2048) -> bytes:
    from PIL import Image
    arr = _image_array(sdata, element)
    hwc = _to_hwc_uint8(arr)
    img = Image.fromarray(hwc)
    img.thumbnail((max_px, max_px))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
