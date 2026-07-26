"""Snapshots: high-quality figure exports of a display, rendered server-side with
matplotlib.

A snapshot is a *figure* — a vector PDF and/or raster PNG of the current view — not a
re-openable session. Saving one bakes the framing (viewport window + output size/DPI)
and reproduces the display exactly as styled on the live canvas:

- the microscopy image (when shown) is rasterized into an image layer, composited the
  same way the live Viv canvas composites channels (per-channel color + contrast window);
- cell points are drawn as **vector** markers (circle/square/hexagon), colored by the same
  deterministic palette/colormap the frontend uses (see colorUtils.ts) so the figure
  matches the canvas without the client shipping a per-cell color buffer;
- when the display is in render_mode 'points+shapes' and zoomed in far enough, the point
  markers are replaced by the same viewport-clipped cell-boundary polygons (filled or
  outline) the canvas overlays — drawn as vector paths, colored per cell to match;
- above a cell-count cap the point/polygon layer is rasterized, to keep the PDF small/fast.

Extensive provenance metadata (dataset, viewport, output settings, full display encoding,
and the analysis recipe that produced the data) is embedded in every output file (PDF
/Info + PNG tEXt) and written to a sidecar `<name>.figure.json` the gallery lists from.
Colors/styling come from the session's persisted display encoding; the render request
only carries framing + output settings.
"""
from __future__ import annotations

import datetime
import hashlib
import io
import json
import math
import os
from pathlib import Path

import numpy as np

from .config import config, within_data_dir
from . import imaging

# One snapshot is a set of sibling files sharing a base name `<slug>-<hash>`:
#   <base>.figure.json        sidecar metadata (the gallery lists these)
#   <base>.figure.pdf / .png  the deliverable(s) the user chose
#   <base>.figure.thumb.png   always written, backs the gallery grid
FIGURE_EXT = ".figure.json"
THUMB_SUFFIX = ".figure.thumb.png"
SNAPSHOT_SCHEMA_VERSION = "3.0"

# Above this many cells in view, the point layer is rasterized instead of emitted as
# vector markers — a vector scatter of hundreds of thousands of markers makes a PDF that
# is huge and slow to open. Recorded in metadata when it trips.
POINT_VECTOR_CAP = 60000

# render_mode 'points+shapes' overlays cell-boundary polygons in place of the point
# markers once the view is zoomed in far enough (matching the live canvas). These
# mirror the frontend so a snapshot shows shapes exactly when the canvas would:
#   POLYGON_LIMIT   — usePolygonBbox.POLYGON_LIMIT: over this many cells in view the
#                     shapes overlay is suppressed and points are shown instead.
#   SHAPES_MIN_CELL_PX — useCanvasViewState.SHAPES_MIN_CELL_PX: a cell must reach this
#                     on-screen diameter (px) before its outline is drawn.
POLYGON_LIMIT = 20000
SHAPES_MIN_CELL_PX = 6

THUMB_MAX_PX = 320

# Cell-color palettes, kept byte-identical to frontend/src/components/canvas/colorUtils.ts
# so a snapshot matches the live canvas exactly. CATEGORY_COLORS: 15 distinct
# (colorblind-friendly) colors, assigned to the *sorted* category list.
CATEGORY_COLORS: list[tuple[int, int, int]] = [
    (86, 180, 233), (230, 159, 0), (0, 158, 115), (240, 228, 66), (0, 114, 178),
    (213, 94, 0), (204, 121, 167), (153, 153, 153), (255, 127, 14), (44, 160, 44),
    (214, 39, 40), (148, 103, 189), (140, 86, 75), (227, 119, 194), (188, 189, 34),
]
MAX_CATEGORICAL_LEVELS = 100  # matches useSpotColors.MAX_CATEGORICAL_LEVELS
DIM_ALPHA = 30  # isolated-category dimming, matches useSpotColors

PLOT_BACKGROUNDS = {"dark": (15 / 255, 17 / 255, 23 / 255), "light": (243 / 255, 244 / 255, 246 / 255)}


def _dir() -> str:
    d = str(config.DATA_DIR)
    os.makedirs(d, exist_ok=True)
    return d


def _resolve(name: str) -> Path:
    """Resolve a client-supplied snapshot name under DATA_DIR, rejecting any that
    escapes it (a `../`/absolute name)."""
    path = (config.DATA_DIR / name).resolve()
    if not within_data_dir(path):
        raise ValueError(f"invalid snapshot name: {name}")
    return path


# ---- viridis LUT (256 entries), identical to colorUtils.ts VIRIDIS -----------
def _viridis_lut() -> np.ndarray:
    """The 256x3 uint8 viridis table the frontend samples. Built from matplotlib's
    viridis at the same 256 stops and `floor(t*255)` indexing the frontend uses, so a
    numeric coloring lands on the same RGB. Cached on the module."""
    global _VIRIDIS
    try:
        return _VIRIDIS
    except NameError:
        pass
    from matplotlib import colormaps
    cmap = colormaps["viridis"]
    _VIRIDIS = (np.asarray([cmap(i / 255.0)[:3] for i in range(256)]) * 255).round().astype(np.uint8)
    return _VIRIDIS


def _display(session, display_id: str | None):
    displays = session.app_state.get("displays", [])
    if display_id:
        for d in displays:
            if d.get("id") == display_id:
                return d
        return None
    for d in displays:
        if d.get("type") == "spatial_canvas":
            return d
    return displays[0] if displays else None


# ---- geometry: viewport window -> figure coordinates -------------------------
def _point_coords(session, enc: dict, kind: str) -> np.ndarray:
    """Nx2 point coordinates in the canvas' coordinate space (spot/world space).
    For a spatial display this honors the editable points->global affine, matching
    the `/data/obsm:spatial` endpoint; for an embedding it reads the chosen obsm
    components directly."""
    from .transport import arrow
    from .sessions import transform
    table = session.active_table()
    if kind == "embedding":
        key = enc.get("obsm_key") or "X_umap"
        xi, yi = int(enc.get("x_component", 0)), int(enc.get("y_component", 1))
        arr = np.asarray(table.obsm[key])
        return np.column_stack([arr[:, xi], arr[:, yi]]).astype(np.float64)
    coords = enc.get("coords") or "obsm:spatial"
    batch = arrow.resolve_field(table, coords)
    xy = np.column_stack([np.asarray(batch.column("d0")), np.asarray(batch.column("d1"))]).astype(np.float64)
    if coords == "obsm:spatial":
        affine6 = transform.get_affine6(session.sdata, table)
        if not transform.is_identity(affine6):
            xy = transform.apply_affine6_xy(affine6, xy)
    return xy


def _image_element(session, enc: dict) -> str | None:
    el = enc.get("image_layer")
    if el and el in getattr(session.sdata, "images", {}):
        return el
    return None


def _shapes_element(session, enc: dict) -> str | None:
    """The polygonal shapes element the cell-boundary overlay would use: the
    encoding's `shapes_layer` if it still exists and is polygonal, else the first
    available polygonal shapes element (mirrors SpatialCanvas' `shapesElement`)."""
    from .transport import geometry
    shapes = getattr(session.sdata, "shapes", {})
    polygonal = [name for name, gdf in shapes.items() if geometry.is_polygonal(gdf)]
    chosen = enc.get("shapes_layer")
    if chosen and chosen in polygonal:
        return chosen
    return polygonal[0] if polygonal else None


def _window(target, zoom, width_px, height_px):
    """Axis-aligned window [x0,y0,x1,y1] in the view's coordinate space. deck's
    OrthographicView puts 2**zoom pixels per unit, so `n` output px span n/2**zoom
    units, centered on target."""
    tx, ty = float(target[0]), float(target[1])
    scale = 2.0 ** float(zoom)
    hw = (width_px / 2.0) / scale
    hh = (height_px / 2.0) / scale
    return [tx - hw, ty - hh, tx + hw, ty + hh]


# ---- cell colors, reproduced from the display encoding -----------------------
def _cell_rgba(session, enc: dict, n: int) -> np.ndarray:
    """Nx4 float RGBA in [0,1] for the cells, reproducing useSpotColors + colorUtils
    from the color-by field and the encoding (opacity, isolated category)."""
    from .transport import arrow
    opacity = float(enc.get("opacity", 1.0))
    color_by = enc.get("color_by")
    rgba = np.empty((n, 4), dtype=np.float64)
    rgba[:, 3] = opacity
    if not color_by:
        rgba[:, :3] = 0.5  # neutral grey when nothing drives the color
        return rgba

    batch = arrow.resolve_field(session.active_table(), color_by)
    meta = batch.schema.metadata or {}
    if meta.get(b"kind") == b"categorical":
        categories = json.loads(meta[b"categories"].decode())
        codes = np.asarray(batch.column("code"))
        if len(categories) > MAX_CATEGORICAL_LEVELS:
            rgba[:, :3] = 0.5
            return rgba
        order = {cat: i for i, cat in enumerate(sorted(categories))}
        palette = np.array([CATEGORY_COLORS[order[c] % len(CATEGORY_COLORS)] for c in categories],
                           dtype=np.float64) / 255.0
        missing = codes < 0  # pandas' code for cells with no category value
        safe = np.clip(codes, 0, len(categories) - 1)
        rgba[:, :3] = palette[safe]
        rgba[missing, :3] = 0.5  # unlabeled cells render neutral grey, matching the live canvas
        isolated = enc.get("isolated_category")
        if isolated is not None:
            dim = np.array([categories[c] != isolated for c in safe])
            dim |= missing  # an unlabeled cell is never the isolated category
            rgba[dim, 3] = DIM_ALPHA / 255.0
    else:
        vals = np.asarray(batch.column("value"), dtype=np.float64)
        finite = vals[np.isfinite(vals)]
        lut = _viridis_lut()
        if finite.size == 0:
            rgba[:, :3] = 0.5
        else:
            vmin, vmax = float(finite.min()), float(finite.max())
            rng = vmax - vmin
            t = np.where(np.isfinite(vals), 0.5 if rng == 0 else np.clip((vals - vmin) / (rng or 1), 0, 1), 0.0)
            idx = np.clip(np.floor(t * 255).astype(int), 0, 255)
            rgba[:, :3] = lut[idx] / 255.0
            rgba[~np.isfinite(vals), 3] = 0.0
    return rgba


# ---- image compositing for a window ------------------------------------------
def _composite_window(session, element: str, enc: dict, px_bbox) -> tuple[np.ndarray, list[float]] | None:
    """Composite the microscopy image over the pixel-space window `px_bbox`
    ([x0,y0,x1,y1] in level-0 pixels) into an RGB uint8 HWC array, reading only the
    windowed region of a zoom-appropriate pyramid level. Returns (rgb, extent) where
    extent is [x0,x1,y0,y1] in level-0 pixels, or None if the window misses the image."""
    sdata = session.sdata
    el = sdata.images[element]
    w0, h0 = imaging.image_dims(sdata, element)
    x0 = max(0, int(np.floor(px_bbox[0]))); y0 = max(0, int(np.floor(px_bbox[1])))
    x1 = min(w0, int(np.ceil(px_bbox[2]))); y1 = min(h0, int(np.ceil(px_bbox[3])))
    if x1 <= x0 or y1 <= y0:
        return None

    # Pick a pyramid level whose windowed resolution is near the output size: the
    # finest level that still keeps the read modest. levels are a 2x pyramid.
    levels = imaging._scale_names(el) if imaging._is_multiscale(el) else ["scale0"]
    win_px = max(x1 - x0, y1 - y0)
    target_px = 2048  # cap the composited read; supersamples typical output sizes
    level = 0
    for lv in range(len(levels)):
        if win_px / (2 ** lv) <= target_px:
            level = lv
            break
        level = lv
    arr = imaging._level_array(el, level)
    factor = 2 ** level
    lx0, ly0, lx1, ly1 = x0 // factor, y0 // factor, -(-x1 // factor), -(-y1 // factor)
    data = np.asarray(arr[:, ly0:ly1, lx0:lx1].data if hasattr(arr, "data") else arr[:, ly0:ly1, lx0:lx1])
    if data.ndim == 2:
        data = data[None]

    names = imaging.channel_names(el)
    is_rgb = imaging._is_rgb(sdata, element)
    if is_rgb:
        rgb = np.moveaxis(data[:3], 0, -1).astype(np.uint8)
    else:
        rgb = _tint_channels(data, names, enc, sdata, element)
    extent = [lx0 * factor, lx1 * factor, ly0 * factor, ly1 * factor]
    return rgb, extent


def _tint_channels(data_cyx, names, enc, sdata, element) -> np.ndarray:
    """Additive per-channel tint honoring the encoding's channel state (visible, color,
    contrast window [min,max]), matching the live Viv compositor. Falls back to the
    default channel palette + percentile norm when the encoding doesn't override."""
    nch, h, w = data_cyx.shape
    channels = enc.get("channels") or {}
    default_norm = imaging._channel_norm(sdata, element)
    out = np.zeros((h, w, 3), dtype=np.float32)
    any_visible = False
    for c in range(nch):
        name = names[c] if c < len(names) else str(c)
        cs = channels.get(name) or channels.get(str(c)) or {}
        # No channel state at all: show the first channels by default (the canvas caps
        # at 6 visible); with explicit state, honor `visible`.
        visible = cs.get("visible", c < 6) if channels else c < 6
        if not visible:
            continue
        any_visible = True
        color = imaging.hex_to_rgb(cs["color"]) if cs.get("color") else \
            imaging.DEFAULT_CHANNEL_COLORS[c % len(imaging.DEFAULT_CHANNEL_COLORS)]
        limits = cs.get("contrast_limits")
        lo, hi = (float(limits[0]), float(limits[1])) if limits else (0.0, float(default_norm[c]))
        frac = (data_cyx[c].astype(np.float32) - lo) / max(hi - lo, 1e-6)
        out += np.clip(frac, 0, 1)[:, :, None] * np.array(color, dtype=np.float32)
    if not any_visible:
        return np.zeros((h, w, 3), dtype=np.uint8)
    return np.clip(out, 0, 255).astype(np.uint8)


# ---- cell-boundary polygons (render_mode 'points+shapes') --------------------
def _geom_to_path(geom):
    """A matplotlib compound Path for a shapely Polygon/MultiPolygon: exterior +
    interior rings as sub-paths, so holes render (the same geometry the GeoArrow
    polygon layer tessellates on the canvas). None if the geometry has no rings."""
    from matplotlib.path import Path as MplPath
    from shapely.geometry import MultiPolygon
    polys = list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]
    verts, codes = [], []
    for poly in polys:
        for ring in [poly.exterior, *poly.interiors]:
            coords = np.asarray(ring.coords)
            if len(coords) == 0:
                continue
            verts.append(coords)
            c = np.full(len(coords), MplPath.LINETO, dtype=np.uint8)
            c[0] = MplPath.MOVETO
            c[-1] = MplPath.CLOSEPOLY
            codes.append(c)
    if not verts:
        return None
    return MplPath(np.concatenate(verts), np.concatenate(codes))


def _draw_shapes(ax, session, enc, element, view_bbox, p2w, w2p, n_cells, dpi) -> int:
    """Draw cell-boundary polygons over `view_bbox` (in the view's coordinate space:
    level-0 pixels when an image is shown, else world). Returns the number of
    polygons drawn — 0 when the viewport holds none or more than `POLYGON_LIMIT`
    cells, in which case the caller falls back to the point scatter (matching the
    live canvas, where the outlines drop out and the points show)."""
    from matplotlib.collections import PathCollection
    from shapely.affinity import affine_transform
    from .transport import geometry

    # The query bbox is world space; convert from pixel space when an image is shown.
    if p2w is not None:
        corners = np.array([[view_bbox[0], view_bbox[1]], [view_bbox[2], view_bbox[1]],
                            [view_bbox[2], view_bbox[3]], [view_bbox[0], view_bbox[3]]])
        wc = (p2w[:2, :2] @ corners.T).T + p2w[:2, 2]
        world_bbox = (wc[:, 0].min(), wc[:, 1].min(), wc[:, 0].max(), wc[:, 1].max())
    else:
        world_bbox = (view_bbox[0], view_bbox[1], view_bbox[2], view_bbox[3])

    geoms, cell_index = geometry.clipped_polygons(
        session.sdata, session.active_table(), element, world_bbox, limit=POLYGON_LIMIT)
    if len(geoms) == 0:
        return 0

    # World -> view (pixel) space, the same transform the points carry.
    if w2p is not None:
        aff = [w2p[0, 0], w2p[0, 1], w2p[1, 0], w2p[1, 1], w2p[0, 2], w2p[1, 2]]
        geoms = [affine_transform(g, aff) for g in geoms]

    rgba = _cell_rgba(session, enc, n_cells)
    outline = enc.get("boundary_style", "filled") == "outline"
    line_pts = float(enc.get("boundary_line_width", 1)) * 72.0 / dpi  # px -> points at this dpi
    transparent = (0.0, 0.0, 0.0, 0.0)

    paths, facecolors, edgecolors = [], [], []
    for g, ci in zip(geoms, cell_index):
        path = _geom_to_path(g)
        if path is None:
            continue
        color = tuple(rgba[ci]) if 0 <= ci < n_cells else transparent
        paths.append(path)
        facecolors.append(transparent if outline else color)
        edgecolors.append(color if outline else transparent)
    if not paths:
        return 0

    coll = PathCollection(paths, facecolors=facecolors, edgecolors=edgecolors,
                          linewidths=line_pts if outline else 0, antialiased=True,
                          rasterized=len(paths) > POINT_VECTOR_CAP, zorder=1)
    ax.add_collection(coll)
    return len(paths)


# ---- the render core ---------------------------------------------------------
def _render_figure(session, spec: dict):
    """Render into an in-memory matplotlib Figure. Returns (fig, render_meta)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    display = _display(session, spec.get("display_id"))
    if display is None:
        raise ValueError("no display to snapshot")
    enc = display.get("encoding", {})
    kind = "embedding" if display.get("type") == "embedding_canvas" else "spatial"

    width_px = int(spec["width_px"]); height_px = int(spec["height_px"])
    dpi = int(spec.get("dpi", 150))
    vp = spec.get("viewport") or display.get("viewport") or {}
    target = vp.get("target", [0, 0]); zoom = float(vp.get("zoom", 0))

    xy = _point_coords(session, enc, kind)
    element = _image_element(session, enc) if kind == "spatial" else None

    # Coordinate regime: with an image the canvas works in level-0 pixel space (points
    # carry a world->pixel transform); otherwise pure world/spot space.
    affine_scale = 1.0
    p2w = w2p = None
    if element is not None:
        p2w = imaging.pixel_to_world(session.sdata, element, session.active_table())
        w2p = np.linalg.inv(p2w)
        pts = (w2p[:2, :2] @ xy.T).T + w2p[:2, 2]
        affine_scale = float(np.sqrt(abs(np.linalg.det(p2w[:2, :2]))))
    else:
        pts = xy

    bbox = _window(target, zoom, width_px, height_px)

    # mean inter-point spacing (full dataset bounds) -> world radius, matching
    # useArrowPositions.estimateMeanSpacing + pointWorldRadius.
    area = max(1.0, (xy[:, 0].max() - xy[:, 0].min()) * (xy[:, 1].max() - xy[:, 1].min()))
    spacing = np.sqrt(area / max(1, len(xy)))
    world_radius = (float(enc.get("point_size", 6)) / 8.0) * spacing
    radius_data = world_radius / affine_scale  # data-unit radius in the view's space

    background = enc.get("background") or "dark"
    facecolor = PLOT_BACKGROUNDS.get(background, PLOT_BACKGROUNDS["dark"])

    fig = plt.figure(figsize=(width_px / dpi, height_px / dpi), dpi=dpi)
    fig.patch.set_facecolor(facecolor)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_facecolor(facecolor)
    ax.set_axis_off()

    rasterized_points = False
    show_image = enc.get("show_image", element is not None) and element is not None
    if show_image:
        comp = _composite_window(session, element, enc, bbox)
        if comp is not None:
            rgb, extent = comp
            ax.imshow(rgb, extent=extent, origin="lower", interpolation="nearest", zorder=0)

    show_points = enc.get("show_points", True)
    cells_in_view = 0
    shapes_drawn = 0
    if show_points and len(pts):
        # render_mode 'points+shapes' replaces the point markers with cell-boundary
        # polygons once a cell is big enough on screen (SHAPES_MIN_CELL_PX) and the
        # viewport fits under POLYGON_LIMIT — the same gate the live canvas applies.
        # The scatter is the fallback for the zoomed-out / over-budget regimes.
        render_mode = enc.get("render_mode")
        shapes_mode = render_mode in ("points+shapes", "shapes")
        shapes_element = _shapes_element(session, enc) if (shapes_mode and kind == "spatial") else None
        mean_spacing_screen = spacing / affine_scale  # world spacing scaled to view space
        zoomed_in_for_shapes = mean_spacing_screen > 0 and \
            zoom >= math.log2(SHAPES_MIN_CELL_PX / max(mean_spacing_screen, 1e-9))
        if shapes_element is not None and zoomed_in_for_shapes:
            shapes_drawn = _draw_shapes(ax, session, enc, shapes_element, bbox, p2w, w2p, len(pts), dpi)

        if not shapes_drawn:
            # cull to a slightly padded window so off-view markers don't bloat the file
            pad = radius_data
            m = ((pts[:, 0] >= bbox[0] - pad) & (pts[:, 0] <= bbox[2] + pad)
                 & (pts[:, 1] >= bbox[1] - pad) & (pts[:, 1] <= bbox[3] + pad))
            vx, vy = pts[m, 0], pts[m, 1]
            rgba = _cell_rgba(session, enc, len(pts))[m]
            rasterized_points = len(vx) > POINT_VECTOR_CAP
            marker = {"circle": "o", "square": "s", "hexagon": "h"}.get(enc.get("point_marker", "circle"), "o")
            # radius (data units) -> points at this figure size (equal aspect, window aspect
            # == figure aspect): pts-per-data-unit = 72 * 2**zoom / dpi.
            radius_pts = radius_data * 72.0 * (2.0 ** zoom) / dpi
            s = max((2.0 * radius_pts) ** 2, 0.25)
            ax.scatter(vx, vy, s=s, c=rgba, marker=marker, linewidths=0, rasterized=rasterized_points, zorder=1)
            cells_in_view = int(m.sum())
        else:
            cells_in_view = shapes_drawn

    ax.set_xlim(bbox[2], bbox[0]) if enc.get("invert_x") else ax.set_xlim(bbox[0], bbox[2])
    ax.set_ylim(bbox[3], bbox[1]) if enc.get("invert_y") else ax.set_ylim(bbox[1], bbox[3])

    render_meta = {"kind": kind, "rasterized_points": rasterized_points,
                   "image_element": element if show_image else None,
                   "cells_in_view": cells_in_view, "shapes_drawn": shapes_drawn}
    return fig, render_meta


# ---- public: preview, save, list, delete -------------------------------------
def render_preview(session, spec: dict) -> bytes:
    """A low-cost PNG of the framing for the modal preview. Same core, no file writes
    and no embedded metadata."""
    import matplotlib.pyplot as plt
    with session.lock.reading():
        fig, _ = _render_figure(session, spec)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=fig.dpi)
    plt.close(fig)
    return buf.getvalue()


def _metadata(session, spec: dict, display, render_meta: dict, formats: list[str]) -> dict:
    enc = display.get("encoding", {})
    recipe = [{"namespace": r["namespace"], "function": r["function"], "params": r["params"]}
              for r in session.app_state.get("compute_history", []) if r.get("status") == "completed"]
    return {
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "label": spec.get("label") or session.name,
        "created": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "dataset": session.name,
        "kind": render_meta["kind"],
        "formats": formats,
        "output": {"width_px": int(spec["width_px"]), "height_px": int(spec["height_px"]),
                   "dpi": int(spec.get("dpi", 150))},
        "viewport": spec.get("viewport") or display.get("viewport") or {},
        "encoding": enc,
        "render": render_meta,
        "recipe": recipe,
    }


def save_snapshot(session, spec: dict) -> dict:
    """Render and persist a snapshot figure. `spec`:
    {viewport:{target,zoom}, width_px, height_px, dpi, formats:['pdf'|'png'], label?,
     display_id?}. Writes the chosen formats + a thumbnail + a sidecar `.figure.json`,
     each embedding the provenance metadata."""
    import matplotlib.pyplot as plt
    if session.sdata is None:
        return {"status": "failed", "error": "no data to snapshot"}
    display = _display(session, spec.get("display_id"))
    if display is None:
        return {"status": "failed", "error": "no display to snapshot"}
    formats = [f for f in (spec.get("formats") or ["pdf"]) if f in ("pdf", "png")] or ["pdf"]

    with session.lock.reading():
        fig, render_meta = _render_figure(session, spec)
        meta = _metadata(session, spec, display, render_meta, formats)
        meta_json = json.dumps(meta)

        slug = "".join(c if c.isalnum() or c in "-_" else "-" for c in str(meta["label"]))[:48].strip("-") or "snapshot"
        digest = hashlib.sha256(meta_json.encode()).hexdigest()[:12]
        base = f"{slug}-{digest}"
        d = _dir()

        for fmt in formats:
            path = os.path.join(d, f"{base}.figure.{fmt}")
            if fmt == "pdf":
                fig.savefig(path, format="pdf", dpi=fig.dpi,
                            metadata={"Title": meta["label"], "Creator": "Spatial Data Studio",
                                      "Subject": f"snapshot of {session.name}", "Keywords": meta_json})
            else:
                fig.savefig(path, format="png", dpi=fig.dpi, metadata={"sds-snapshot": meta_json})
        # Thumbnail (always) — a small PNG the gallery grid reads.
        thumb_dpi = max(1, int(THUMB_MAX_PX / max(fig.get_size_inches())))
        fig.savefig(os.path.join(d, f"{base}{THUMB_SUFFIX}"), format="png", dpi=thumb_dpi)
        plt.close(fig)

        with open(os.path.join(d, f"{base}{FIGURE_EXT}"), "w") as f:
            f.write(meta_json)

    return {"status": "completed", "name": f"{base}{FIGURE_EXT}", "formats": formats,
            "rasterized_points": render_meta["rasterized_points"]}


def _entry(name: str, cfg: dict) -> dict:
    base = name[: -len(FIGURE_EXT)]
    return {
        "name": name,
        "base": base,
        "label": cfg.get("label", name),
        "created": cfg.get("created"),
        "kind": cfg.get("kind", "spatial"),
        "dataset": cfg.get("dataset"),
        "formats": cfg.get("formats", []),
        "output": cfg.get("output", {}),
        "thumbnail_url": f"/api/snapshots/{name}/thumbnail",
        "metadata": cfg,
    }


def list_snapshots() -> list[dict]:
    d = str(config.DATA_DIR)
    if not os.path.isdir(d):
        return []
    files = [f for f in os.listdir(d) if f.endswith(FIGURE_EXT)]
    files.sort(key=lambda f: os.path.getmtime(os.path.join(d, f)), reverse=True)
    out = []
    for f in files:
        try:
            with open(os.path.join(d, f)) as fh:
                cfg = json.load(fh)
        except (OSError, ValueError):
            continue
        out.append(_entry(f, cfg))
    return out


def artifact_path(name: str, kind: str) -> str:
    """Absolute path of a snapshot's sibling artifact. `kind` is 'pdf', 'png',
    'thumbnail', or 'json'."""
    if not name.endswith(FIGURE_EXT):
        raise ValueError(f"not a snapshot name: {name}")
    base_path = _resolve(name)
    base = str(base_path)[: -len(FIGURE_EXT)]
    suffix = {"pdf": ".figure.pdf", "png": ".figure.png",
              "thumbnail": THUMB_SUFFIX, "json": FIGURE_EXT}[kind]
    p = Path(base + suffix)
    if not within_data_dir(p):
        raise ValueError(f"invalid snapshot name: {name}")
    return str(p)


def delete_snapshot(name: str) -> bool:
    """Remove a snapshot and all its sibling artifacts. Returns False if absent."""
    if not name.endswith(FIGURE_EXT):
        raise ValueError(f"not a snapshot name: {name}")
    removed = False
    for kind in ("json", "pdf", "png", "thumbnail"):
        p = artifact_path(name, kind)
        if os.path.isfile(p):
            os.remove(p)
            removed = True
    return removed
