"""Image serving for the canvas background (DESIGN §9.2).

Large sections (Xenium: ~34k x 14k px, multi-GB) can't ship as one PNG, so we
serve the SpatialData multiscale pyramid as tiles: deck.gl requests only the
tiles visible at the current zoom, from the level whose native resolution matches
the screen. A single coarse thumbnail is still served as an always-present base
layer under the tiles.

Two coordinate spaces have to be reconciled. The spot/cell coordinates in
`obsm["spatial"]` may be in different units (e.g. Xenium microns) than the image's
intrinsic pixel space. SpatialData records this as per-element transformations to
a shared coordinate system; `pixel_to_world` picks the element transform that best
overlays the spots onto the image and returns the image->spot-space affine, so
points and image line up on the canvas.
"""
import io
from collections import OrderedDict

import numpy as np

TILE_SIZE = 512
_TILE_CACHE_MAX = 512  # composited tile PNGs kept in memory (LRU)

# element pixels -> composited tile PNG bytes, and element -> per-channel norm.
# Keyed partly by id(sdata) so a session's caches drop when its object is GC'd.
_tile_cache: "OrderedDict[tuple, bytes]" = OrderedDict()
_norm_cache: dict[tuple, np.ndarray] = {}


# ---- multiscale access -----------------------------------------------------
def _is_multiscale(el) -> bool:
    return hasattr(el, "children") or el.__class__.__name__ in ("DataTree", "Datatree")


def _scale_names(el) -> list[str]:
    """Multiscale level names, finest (scale0) first."""
    keys = el.children.keys() if hasattr(el, "children") else el.keys()
    return sorted(keys)  # 'scale0' < 'scale1' < ... lexically == finest first


def _level_array(el, level: int):
    """DataArray (c,y,x) for a given pyramid level; level 0 is the finest."""
    if not _is_multiscale(el):
        return el
    names = _scale_names(el)
    node = el[names[min(level, len(names) - 1)]]
    dv = getattr(node, "data_vars", {})
    return node["image"] if "image" in dv else next(iter(node.values()))


def _image_array(sdata, element):
    """The coarsest level (for a whole-image thumbnail) or the plain array."""
    if element not in sdata.images:
        raise KeyError(f"image element '{element}' not found")
    el = sdata.images[element]
    if _is_multiscale(el):
        return _level_array(el, len(_scale_names(el)) - 1)
    return el


def image_dims(sdata, element) -> tuple[int, int]:
    """Level-0 (width, height) of an image element, from shape metadata only."""
    el = sdata.images[element]
    arr = _level_array(el, 0) if _is_multiscale(el) else el
    return int(arr.shape[-1]), int(arr.shape[-2])


def channel_names(elem) -> list[str]:
    """Channel labels for an image element, multiscale (DataTree) or plain.
    Falls back through the `c` coord, the `c` dim size, and finally a shape
    guess, since not every reader attaches explicit channel names/coords.
    """
    arr = _level_array(elem, 0) if _is_multiscale(elem) else elem
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


def hex_to_rgb(hexcolor: str) -> tuple[int, int, int] | None:
    """`"rrggbb"` (leading `#` optional) -> (r, g, b), or None if malformed."""
    hexcolor = hexcolor.lstrip("#")
    if len(hexcolor) != 6:
        return None
    return (int(hexcolor[0:2], 16), int(hexcolor[2:4], 16), int(hexcolor[4:6], 16))


def parse_channel_colors(spec: str | None) -> dict[int, tuple[int, int, int]] | None:
    """Parse a `channels` query value of comma-separated `index:rrggbb` pairs into
    a channel-index -> RGB dict. Only listed indices are treated as visible."""
    if spec is None:
        return None
    colors: dict[int, tuple[int, int, int]] = {}
    for part in spec.split(","):
        idx_str, _, hexcolor = part.strip().partition(":")
        rgb = hex_to_rgb(hexcolor)
        if not idx_str.isdigit() or rgb is None:
            continue
        colors[int(idx_str)] = rgb
    return colors


# ---- channel normalization (consistent across tiles) -----------------------
def _channel_norm(sdata, element) -> np.ndarray:
    """Per-channel intensity scale, computed once from the coarsest level so every
    tile of an element uses the same scaling (per-tile maxima would make brightness
    jump between adjacent tiles). uint8 images use a fixed 255."""
    key = (id(sdata), element)
    cached = _norm_cache.get(key)
    if cached is not None:
        return cached
    arr = _image_array(sdata, element)
    data = np.asarray(arr.data if hasattr(arr, "data") else arr)
    if data.ndim == 2:
        data = data[None, :, :]
    if data.dtype == np.uint8:
        norm = np.full(data.shape[0], 255.0, dtype=np.float64)
    else:
        norm = np.array([max(float(np.percentile(data[c], 99.9)), 1.0) for c in range(data.shape[0])])
    _norm_cache[key] = norm
    return norm


def channel_contrast_limits(sdata, element) -> list[float]:
    """Per-channel upper contrast bound (the `_channel_norm` denominator) baked into
    a snapshot config so the browser compositor reproduces the server's brightness:
    displayed = clip(value / limit, 0, 1). Derived from the coarsest level, matching
    what the tile/thumbnail server uses."""
    return [float(x) for x in _channel_norm(sdata, element)]


def _composite(data_cyx: np.ndarray, norm: np.ndarray,
               channel_colors: dict[int, tuple[int, int, int]] | None) -> np.ndarray:
    """Additively blend each visible channel's normalized intensity, tinted with its
    assigned color, into an RGB uint8 HWC image."""
    if data_cyx.ndim == 2:
        data_cyx = data_cyx[None, :, :]
    nch, h, w = data_cyx.shape
    if channel_colors is None:
        channel_colors = {i: DEFAULT_CHANNEL_COLORS[i % len(DEFAULT_CHANNEL_COLORS)] for i in range(nch)}
    vis = [c for c in channel_colors if 0 <= c < nch]
    out = np.zeros((h, w, 3), dtype=np.float32)
    for c in vis:
        frac = data_cyx[c].astype(np.float32) / float(norm[c])
        out += np.clip(frac, 0, 1)[:, :, None] * np.array(channel_colors[c], dtype=np.float32)
    return np.clip(out, 0, 255).astype(np.uint8)


# ---- coordinate reconciliation (spots space vs image space) ----------------
def _affine_xy(elem, sdata):
    """Element -> 'global' transform as a 3x3 affine over (x, y), or None."""
    try:
        from spatialdata.transformations import get_transformation
        t = get_transformation(elem, "global")
        return np.asarray(t.to_affine_matrix(("x", "y"), ("x", "y")))
    except Exception:
        return None


def _apply_bbox(a: np.ndarray, bbox) -> list[float]:
    x0, y0, x1, y1 = bbox
    corners = np.array([[x0, y0, 1], [x1, y0, 1], [x0, y1, 1], [x1, y1, 1]]).T
    p = a @ corners
    return [float(p[0].min()), float(p[1].min()), float(p[0].max()), float(p[1].max())]


def _iou(a, b) -> float:
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _global_extent(sdata, element) -> list[float]:
    try:
        from spatialdata import get_extent
        ext = get_extent(sdata.images[element])
        return [float(ext["x"][0]), float(ext["y"][0]), float(ext["x"][1]), float(ext["y"][1])]
    except Exception:
        arr = _image_array(sdata, element)
        return [0.0, 0.0, float(arr.shape[-1]), float(arr.shape[-2])]


def pixel_to_world(sdata, element, table=None) -> np.ndarray:
    """3x3 affine mapping the image's level-0 intrinsic pixel coords (x=col, y=row)
    into the spots' coordinate space (the space `obsm["spatial"]` is plotted in).

    The image carries its own transform to 'global'; the spots live in some
    element's intrinsic space. We can't trust the table's declared region (Xenium
    annotates labels in pixel space while its spots are in microns), so we pick,
    among all shape/label element transforms plus identity, the one whose mapping
    of the spot bounding box best overlays the image extent in 'global', and
    compose image->global with the inverse of that spots->global transform. The
    result may include rotation/axis-swap (e.g. an aligned H&E), so tiles are
    placed as quadrilaterals rather than axis-aligned rectangles.
    """
    a_image = _affine_xy(sdata.images[element], sdata)
    if a_image is None:
        a_image = np.eye(3)
    if table is None or "spatial" not in getattr(table, "obsm", {}):
        return a_image  # no spots to reconcile against; stay in 'global'

    xy = np.asarray(table.obsm["spatial"])[:, :2]
    spot_bbox = [float(xy[:, 0].min()), float(xy[:, 1].min()),
                 float(xy[:, 0].max()), float(xy[:, 1].max())]
    global_ext = _global_extent(sdata, element)

    # The table's own region element carries the user-editable points->global
    # transform (see sessions/transform.py); exclude it so nudging the points
    # doesn't drag the image reconciliation with them (identity stays a candidate).
    from .sessions.transform import region_name
    region = region_name(table)
    candidates = [np.eye(3)]
    for group in (getattr(sdata, "shapes", {}), getattr(sdata, "labels", {})):
        for name, elem in group.items():
            if name == region:
                continue
            a = _affine_xy(elem, sdata)
            if a is not None:
                candidates.append(a)

    best_a, best_iou = np.eye(3), -1.0
    for a in candidates:
        score = _iou(_apply_bbox(a, spot_bbox), global_ext)
        if score > best_iou:
            best_iou, best_a = score, a
    if best_iou <= 0:
        return a_image
    return np.linalg.inv(best_a) @ a_image


def _world_bounds(m: np.ndarray, width: int, height: int) -> list[float]:
    """Axis-aligned bounds [x0, y0, x1, y1] of the full image under transform `m`."""
    return _apply_bbox(m, [0.0, 0.0, float(width), float(height)])


# ---- public info + rendering -----------------------------------------------
def _levels_meta(sdata, element) -> list[dict]:
    """Per pyramid level: index + native pixel (width=x, height=y), finest first."""
    el = sdata.images[element]
    if not _is_multiscale(el):
        arr = el
        return [{"level": 0, "width": int(arr.shape[-1]), "height": int(arr.shape[-2])}]
    out = []
    for i, _ in enumerate(_scale_names(el)):
        arr = _level_array(el, i)
        out.append({"level": i, "width": int(arr.shape[-1]), "height": int(arr.shape[-2])})
    return out


def image_info(sdata, element, table=None) -> dict:
    arr = _level_array(sdata.images[element], 0) if _is_multiscale(sdata.images[element]) \
        else sdata.images[element]
    w, h = int(arr.shape[-1]), int(arr.shape[-2])
    m = pixel_to_world(sdata, element, table)
    # 6-float affine [a,b,c,d,e,f]: world_x = a*px + b*py + c, world_y = d*px + e*py + f,
    # where (px, py) are level-0 pixel coords.
    affine6 = [float(m[0, 0]), float(m[0, 1]), float(m[0, 2]),
               float(m[1, 0]), float(m[1, 1]), float(m[1, 2])]
    return {"element": element,
            "height": h, "width": w,
            "channels": int(arr.shape[0]) if arr.ndim == 3 else 1,
            "channel_names": channel_names(sdata.images[element]),
            "bounds": _world_bounds(m, w, h),
            "pixel_to_world": affine6,
            "levels": _levels_meta(sdata, element),
            "tile_size": TILE_SIZE}


def tile_png(sdata, element, level: int, col: int, row: int,
             channel_colors: dict[int, tuple[int, int, int]] | None = None) -> bytes:
    """One TILE_SIZE tile at pyramid `level`, tile grid (col, row). Cached."""
    chanspec = tuple(sorted(channel_colors.items())) if channel_colors else None
    key = (id(sdata), element, level, col, row, chanspec)
    cached = _tile_cache.get(key)
    if cached is not None:
        _tile_cache.move_to_end(key)
        return cached

    from PIL import Image
    arr = _level_array(sdata.images[element], level)
    h, w = arr.shape[-2], arr.shape[-1]
    x0, x1 = col * TILE_SIZE, min((col + 1) * TILE_SIZE, w)
    y0, y1 = row * TILE_SIZE, min((row + 1) * TILE_SIZE, h)
    if x0 >= x1 or y0 >= y1:
        raise KeyError(f"tile out of range: level={level} col={col} row={row}")

    region = arr[..., y0:y1, x0:x1]
    data = np.asarray(region.data if hasattr(region, "data") else region)
    hwc = _composite(data, _channel_norm(sdata, element), channel_colors)
    buf = io.BytesIO()
    Image.fromarray(hwc).save(buf, format="PNG")
    png = buf.getvalue()

    _tile_cache[key] = png
    if len(_tile_cache) > _TILE_CACHE_MAX:
        _tile_cache.popitem(last=False)
    return png


def thumbnail_png(
    sdata, element, max_px: int = 2048, channel_colors: dict[int, tuple[int, int, int]] | None = None
) -> bytes:
    """Whole-image thumbnail from the coarsest level (base layer / snapshots)."""
    from PIL import Image
    arr = _image_array(sdata, element)
    data = np.asarray(arr.data if hasattr(arr, "data") else arr)
    hwc = _composite(data, _channel_norm(sdata, element), channel_colors)
    img = Image.fromarray(hwc)
    img.thumbnail((max_px, max_px))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def region_png(sdata, element, world_bbox, table=None, out_px: int = 2048,
               channel_colors: dict[int, tuple[int, int, int]] | None = None) -> tuple[bytes, list[float]]:
    """Composite a world-space rectangle at higher resolution than the whole-image
    thumbnail: clamp the requested bbox to the image extent, pick the coarsest
    pyramid level whose crop is still >= `out_px` on its long side (then downscale
    to out_px), and return (png, world bounds actually covered). Used for snapshots
    of the current viewport. Assumes an axis-aligned pixel->world mapping (the
    scale+translate common to Visium/Xenium); rotation is approximated by the
    axis-aligned pixel crop."""
    from PIL import Image
    info = image_info(sdata, element, table)
    a, b, c, d, e, f = info["pixel_to_world"]
    m = np.array([[a, b, c], [d, e, f], [0, 0, 1]])
    minv = np.linalg.inv(m)

    # World rect -> level-0 pixel AABB, clamped to the image.
    wx0, wy0, wx1, wy1 = world_bbox
    px_bbox = _apply_bbox(minv, [wx0, wy0, wx1, wy1])
    w0, h0 = info["width"], info["height"]
    px0 = max(0, int(np.floor(min(px_bbox[0], px_bbox[2]))))
    py0 = max(0, int(np.floor(min(px_bbox[1], px_bbox[3]))))
    px1 = min(w0, int(np.ceil(max(px_bbox[0], px_bbox[2]))))
    py1 = min(h0, int(np.ceil(max(px_bbox[1], px_bbox[3]))))
    if px0 >= px1 or py0 >= py1:
        raise ValueError("viewport does not overlap the image")

    # Coarsest level whose crop still has >= out_px on its long side (finest first).
    levels = info["levels"]
    chosen = 0
    for i, lv in enumerate(levels):
        s = lv["width"] / w0
        if max((px1 - px0) * s, (py1 - py0) * s) >= out_px:
            chosen = i
        else:
            break

    sL = levels[chosen]["width"] / w0
    lx0, lx1 = int(px0 * sL), max(int(px0 * sL) + 1, int(round(px1 * sL)))
    ly0, ly1 = int(py0 * sL), max(int(py0 * sL) + 1, int(round(py1 * sL)))
    arr = _level_array(sdata.images[element], chosen)
    region = arr[..., ly0:ly1, lx0:lx1]
    data = np.asarray(region.data if hasattr(region, "data") else region)
    hwc = _composite(data, _channel_norm(sdata, element), channel_colors)
    img = Image.fromarray(hwc)
    if max(img.size) > out_px:
        img.thumbnail((out_px, out_px))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    # World bounds actually covered = clamped level-0 pixel box mapped back through m.
    bounds = _apply_bbox(m, [px0, py0, px1, py1])
    return buf.getvalue(), bounds
