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


# Canonical 8-color channel palette: ColorBrewer/matplotlib "Set1", the standard
# qualitative cycle used across scientific plotting (R, Python, ggplot2). Mirrors
# frontend/src/components/canvas/colorUtils.ts CHANNEL_COLORS.
DEFAULT_CHANNEL_COLORS: list[tuple[int, int, int]] = [
    (228, 26, 28),   # red
    (55, 126, 184),  # blue
    (77, 175, 74),   # green
    (152, 78, 163),  # purple
    (255, 127, 0),   # orange
    (255, 255, 51),  # yellow
    (166, 86, 40),   # brown
    (247, 129, 191), # pink
]


def parse_channel_colors(spec: str | None) -> dict[int, tuple[int, int, int]] | None:
    """Parse a `channels` query value of comma-separated `index:rrggbb` pairs into
    a channel-index -> RGB dict. Only listed indices are treated as visible."""
    if spec is None:
        return None
    colors: dict[int, tuple[int, int, int]] = {}
    for part in spec.split(","):
        idx_str, _, hexcolor = part.strip().partition(":")
        hexcolor = hexcolor.lstrip("#")
        if not idx_str.isdigit() or len(hexcolor) != 6:
            continue
        colors[int(idx_str)] = (int(hexcolor[0:2], 16), int(hexcolor[2:4], 16), int(hexcolor[4:6], 16))
    return colors


def _to_hwc_uint8(arr, channel_colors: dict[int, tuple[int, int, int]] | None = None) -> np.ndarray:
    """Composite an image's channels into an RGB thumbnail by additively blending
    each visible channel's normalized intensity tinted with its assigned color."""
    data = np.asarray(arr.data if hasattr(arr, "data") else arr)
    # spatialdata images are (c, y, x)
    if data.ndim == 3:
        data = np.transpose(data, (1, 2, 0))
    elif data.ndim == 2:
        data = data[:, :, None]
    h, w, nch = data.shape

    if channel_colors is None:
        channel_colors = {i: DEFAULT_CHANNEL_COLORS[i % len(DEFAULT_CHANNEL_COLORS)] for i in range(nch)}
    vis = [c for c in channel_colors if 0 <= c < nch]
    if not vis:
        return np.zeros((h, w, 3), dtype=np.uint8)

    scale = 255.0 if data.dtype == np.uint8 else float(max(data[:, :, c].max() for c in vis)) or 1.0

    out = np.zeros((h, w, 3), dtype=np.float32)
    for c in vis:
        frac = data[:, :, c].astype(np.float32) / scale
        out += frac[:, :, None] * np.array(channel_colors[c], dtype=np.float32)
    return np.clip(out, 0, 255).astype(np.uint8)


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


def thumbnail_png(
    sdata, element, max_px: int = 2048, channel_colors: dict[int, tuple[int, int, int]] | None = None
) -> bytes:
    from PIL import Image
    arr = _image_array(sdata, element)
    hwc = _to_hwc_uint8(arr, channel_colors)
    img = Image.fromarray(hwc)
    img.thumbnail((max_px, max_px))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
