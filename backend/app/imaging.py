"""Image serving for the canvas background (DESIGN §9.2).

Large sections (Xenium: ~34k x 14k px, multi-GB) can't ship as one image, so we
serve the SpatialData multiscale pyramid as WebP tiles: deck.gl requests only the
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
import threading
from collections import OrderedDict

import numpy as np

from .config import config

TILE_SIZE = 512

# The DataInspector element preview is a server-composited WebP thumbnail (the canvas
# itself composites client-side via Viv). WebP over PNG: already a lossy display render
# (contrast-clipped uint8 RGB), so lossy encoding costs no source fidelity and is
# ~10-16x smaller on the wire; browsers decode it natively via <img>.
TILE_IMAGE_FORMAT = "WEBP"
TILE_IMAGE_MEDIA_TYPE = "image/webp"
TILE_WEBP_QUALITY = 80

# element -> per-channel percentile norm (shared by the thumbnail compositor).
# Keyed by (id(sdata), ...). id() is only unique among *live* objects, so entries
# MUST be evicted when a session closes (see evict_caches): otherwise they leak, and
# a later session whose sdata is allocated at the same address would read another
# image's stale norm for a same-named element.
_norm_cache: "OrderedDict[tuple, np.ndarray]" = OrderedDict()
_NORM_CACHE_MAX = 256  # per-channel norm arrays kept in memory (LRU)

# Raw Viv chunk bytes (the default client-compositing path). The raster_store route
# reads one compressed chunk file per browser request; without this, panning back
# over already-seen tiles re-reads each chunk (a syscall + read-lock round trip, and
# a real disk read when WORK_DIR is not RAM-backed). Same (id(sdata), ...) keying as
# the tile cache, so evict_caches drops it on the same adoption/close boundary.
# Byte-budgeted because these bytes live in the API process heap (counted in RSS);
# guarded by a lock since reads run under the shared — hence concurrent — read lock.
_raster_chunk_cache: "OrderedDict[tuple, bytes]" = OrderedDict()
_raster_chunk_lock = threading.Lock()
_raster_chunk_bytes = 0
_RASTER_CHUNK_BUDGET = int(config.RASTER_CHUNK_CACHE_MB * 1e6)


def evict_caches(sdata) -> None:
    """Drop every cache entry belonging to `sdata`. Call before a session's object is
    released so a reused id() can't serve another image's cached norm/tiles/chunks."""
    global _raster_chunk_bytes
    sid = id(sdata)
    for key in [k for k in _norm_cache if k[0] == sid]:
        _norm_cache.pop(key, None)
    with _raster_chunk_lock:
        for key in [k for k in _raster_chunk_cache if k[0] == sid]:
            _raster_chunk_bytes -= len(_raster_chunk_cache.pop(key))


def raster_chunk_get(sdata, element: str, key: str) -> bytes | None:
    """Cached raw chunk bytes for a Viv store read, or None on miss/disabled."""
    if _RASTER_CHUNK_BUDGET <= 0:
        return None
    k = (id(sdata), element, key)
    with _raster_chunk_lock:
        data = _raster_chunk_cache.get(k)
        if data is not None:
            _raster_chunk_cache.move_to_end(k)
        return data


def raster_chunk_put(sdata, element: str, key: str, data: bytes) -> None:
    """Cache raw chunk bytes, evicting the least-recently-used until under budget.
    Skips a single chunk larger than the whole budget (it would evict everything)."""
    global _raster_chunk_bytes
    if _RASTER_CHUNK_BUDGET <= 0 or len(data) > _RASTER_CHUNK_BUDGET:
        return
    k = (id(sdata), element, key)
    with _raster_chunk_lock:
        if k in _raster_chunk_cache:
            _raster_chunk_bytes -= len(_raster_chunk_cache[k])
        _raster_chunk_cache[k] = data
        _raster_chunk_cache.move_to_end(k)
        _raster_chunk_bytes += len(data)
        while _raster_chunk_bytes > _RASTER_CHUNK_BUDGET:
            _, evicted = _raster_chunk_cache.popitem(last=False)
            _raster_chunk_bytes -= len(evicted)


# ---- multiscale access -----------------------------------------------------
def _is_multiscale(el) -> bool:
    return hasattr(el, "children") or el.__class__.__name__ in ("DataTree", "Datatree")


def _scale_names(el) -> list[str]:
    """Multiscale level names, finest (scale0) first."""
    keys = el.children.keys() if hasattr(el, "children") else el.keys()
    # Numeric order, not lexical: plain sorted() puts 'scale10' before 'scale2',
    # which would hand back the wrong resolution for a >=10-level pyramid.
    return sorted(keys, key=lambda k: int(str(k).removeprefix("scale")))


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
    arr = _level_array(sdata.images[element], 0)  # returns the element itself if single-scale
    return int(arr.shape[-1]), int(arr.shape[-2])


def channel_names(elem) -> list[str]:
    """Channel labels for an image element, multiscale (DataTree) or plain.
    Falls back through the `c` coord, the `c` dim size, and finally a shape
    guess, since not every reader attaches explicit channel names/coords.
    """
    arr = _level_array(elem, 0)
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
    # An empty or all-malformed spec is indistinguishable from "use defaults":
    # return None (default palette) rather than {} (which _composite renders black).
    return colors or None


# ---- channel normalization (consistent across tiles) -----------------------
def _channel_norm(sdata, element) -> np.ndarray:
    """Per-channel intensity scale, computed once from the coarsest level so every
    tile of an element uses the same scaling (per-tile maxima would make brightness
    jump between adjacent tiles). uint8 images use a fixed 255."""
    key = (id(sdata), element)
    cached = _norm_cache.get(key)
    if cached is not None:
        _norm_cache.move_to_end(key)
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
    if len(_norm_cache) > _NORM_CACHE_MAX:
        _norm_cache.popitem(last=False)
    return norm


def channel_contrast_limits(sdata, element) -> list[float]:
    """Per-channel upper contrast bound (the `_channel_norm` denominator) baked into
    a snapshot config so the browser compositor reproduces the server's brightness:
    displayed = clip(value / limit, 0, 1). Derived from the coarsest level, matching
    what the tile/thumbnail server uses."""
    return [float(x) for x in _channel_norm(sdata, element)]


def channel_value_range(sdata, element) -> list[tuple[float, float]]:
    """Per-channel [min, max] intensity over the coarsest level — the domain the client
    uses for its contrast sliders. The default upper bound (channel_contrast_limits)
    normally sits inside this range; the client widens the domain to include it."""
    arr = _image_array(sdata, element)
    data = np.asarray(arr.data if hasattr(arr, "data") else arr)
    if data.ndim == 2:
        data = data[None, :, :]
    return [(float(data[c].min()), float(data[c].max())) for c in range(data.shape[0])]


def _is_rgb(sdata, element) -> bool:
    """True for a true-color RGB image that must be shown as-is, not tinted like a
    fluorescence stack. Heuristic: 3 uint8 channels whose labels are the RGB triple
    (spatialdata-io's Visium/H&E reader) or bare indices (an H&E imported as a plain
    (c, y, x) uint8 array with no channel coords)."""
    arr = _level_array(sdata.images[element], 0)
    if getattr(arr, "ndim", 0) != 3 or arr.shape[0] != 3 or getattr(arr, "dtype", None) != np.uint8:
        return False
    names = [n.lower() for n in channel_names(sdata.images[element])]
    return names == ["r", "g", "b"] or names == ["0", "1", "2"]


def _composite(data_cyx: np.ndarray, norm: np.ndarray,
               channel_colors: dict[int, tuple[int, int, int]] | None,
               rgb: bool = False) -> np.ndarray:
    """Blend channels into an RGB uint8 HWC image. Fluorescence channels are
    normalized and additively tinted with their assigned color; a true-color RGB
    image (`rgb=True`, see _is_rgb) is passed straight through so an H&E/brightfield
    image isn't false-colored."""
    if data_cyx.ndim == 2:
        data_cyx = data_cyx[None, :, :]
    if rgb:
        return np.moveaxis(data_cyx[:3], 0, -1).astype(np.uint8)
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
        # get_extent failed: map the level-0 pixel box through the image's own
        # 'global' transform so the fallback stays in global (spot) coordinates.
        # Returning coarse-level pixels here scores IOU ~0 against micron spots.
        w, h = image_dims(sdata, element)
        a = _affine_xy(sdata.images[element], sdata)
        if a is None:
            a = np.eye(3)
        return _apply_bbox(a, [0.0, 0.0, float(w), float(h)])


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
    arr = _level_array(sdata.images[element], 0)
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


def thumbnail_image(
    sdata, element, max_px: int = 2048, channel_colors: dict[int, tuple[int, int, int]] | None = None
) -> bytes:
    """Whole-image thumbnail from the coarsest level (base layer), WebP-encoded."""
    from PIL import Image
    arr = _image_array(sdata, element)
    data = np.asarray(arr.data if hasattr(arr, "data") else arr)
    hwc = _composite(data, _channel_norm(sdata, element), channel_colors, rgb=_is_rgb(sdata, element))
    img = Image.fromarray(hwc)
    img.thumbnail((max_px, max_px))
    buf = io.BytesIO()
    img.save(buf, format=TILE_IMAGE_FORMAT, quality=TILE_WEBP_QUALITY)
    return buf.getvalue()


