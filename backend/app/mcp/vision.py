"""Vision for the MCP assistant: render a display to a PNG a vision model can read,
with an exact, machine-usable mapping between the PNG's pixels and the session's
world coordinates.

Built on the snapshot render core (`snapshots._render_figure`), which already
reproduces any spatial/embedding display — image compositing, palette-matched cells,
boundary polygons — for a given viewport. This module adds what an *agent* needs on
top of a human-facing figure:

- a coordinate-labeled grid drawn into the image (vision models ground far better
  against labeled rulers than against bare pixels);
- optional marker overlays (`mark_points`/`mark_polygons`) so the agent can verify
  its coordinate math visually before mutating anything;
- a metadata contract: the world-space window, and a `pixel_to_world` affine for the
  returned PNG, composed through the image's own pixel->world transform when the
  display renders in image-pixel space. "World" is always the space the
  annotate/subset endpoints take polygons in (obsm['spatial'] after the points->global
  affine — the same space `/data/obsm:spatial` serves). For an embedding display the
  "world" is the chosen obsm components, and selections must go through
  `cell_indices` instead (see `cells_in_polygons`).

Locking: `render_view` takes `session.lock.reading()` itself (mirroring
`snapshots.render_preview`); the membership/stats helpers read the table without
acquiring anything and must be called under `deps._read_locked` (server.py does).
"""
from __future__ import annotations

import io
import math

import numpy as np

from .. import imaging, snapshots

# Claude reads images best around ~1.15 megapixels; anything past ~1568 px on the
# long side is downscaled by the model anyway, so cap requests there.
MAX_RENDER_PX = 1568
DEFAULT_WIDTH_PX = 1024
DEFAULT_HEIGHT_PX = 768
RENDER_DPI = 100

GRID_TARGET_LINES = 6  # aim for about this many gridlines per axis
MARKER_COLOR = "#00e5ff"  # cyan: visible over viridis, H&E, and both backdrops


# ---- viewports ----------------------------------------------------------------
def _view_extent(session, enc: dict, kind: str) -> tuple[np.ndarray, np.ndarray]:
    """(mins, maxs) of the display's content in its *view* space — image-pixel space
    when the display carries an image, else world/embedding space."""
    xy = snapshots._point_coords(session, enc, kind)
    element = snapshots._image_element(session, enc) if kind == "spatial" else None
    if element is not None:
        w2p = np.linalg.inv(imaging.pixel_to_world(session.sdata, element, session.active_table()))
        pts = (w2p[:2, :2] @ xy.T).T + w2p[:2, 2] if len(xy) else xy
        w0, h0 = imaging.image_dims(session.sdata, element)
        corners = [pts] if len(pts) else []
        corners.append(np.array([[0.0, 0.0], [float(w0), float(h0)]]))
        allpts = np.vstack(corners)
    else:
        allpts = xy
    if len(allpts) == 0:
        raise ValueError("display has nothing to render (no coordinates)")
    return allpts.min(axis=0), allpts.max(axis=0)


def fit_viewport(session, display: dict, width_px: int, height_px: int) -> dict:
    """A viewport framing the whole display content with a 5% margin — the deck.gl
    convention: 2**zoom output pixels per view-space unit, centered on target."""
    enc = display.get("encoding", {})
    kind = "embedding" if display.get("type") == "embedding_canvas" else "spatial"
    mins, maxs = _view_extent(session, enc, kind)
    spans = np.maximum(maxs - mins, 1e-9)
    zoom = math.log2(min(width_px / spans[0], height_px / spans[1]) * 0.95)
    center = (mins + maxs) / 2.0
    return {"target": [float(center[0]), float(center[1])], "zoom": float(zoom)}


# ---- overlays -------------------------------------------------------------------
def _nice_step(raw: float) -> float:
    """Round `raw` to a 1/2/2.5/5 x 10^k gridline interval."""
    if raw <= 0 or not math.isfinite(raw):
        return 1.0
    mag = 10.0 ** math.floor(math.log10(raw))
    for m in (1.0, 2.0, 2.5, 5.0, 10.0):
        if raw <= m * mag:
            return m * mag
    return 10.0 * mag


def _fmt(v: float) -> str:
    return f"{v:.10g}"


def _halo(line_color):
    import matplotlib.patheffects as pe
    stroke = "black" if line_color != "black" else "white"
    return [pe.withStroke(linewidth=2.2, foreground=stroke, alpha=0.85)]


def _draw_grid(ax, view_bbox, p2w: np.ndarray, w2v: np.ndarray, color) -> dict:
    """World-coordinate gridlines + labels inside the full-bleed figure. Lines are
    generated in world space and mapped through `w2v` (world -> view), so they stay
    correct under a rotating image transform. Labels sit where each line crosses the
    image's bottom (x values) / left (y values) edge."""
    corners = np.array([[view_bbox[0], view_bbox[1]], [view_bbox[2], view_bbox[1]],
                        [view_bbox[2], view_bbox[3]], [view_bbox[0], view_bbox[3]]])
    wc = (p2w[:2, :2] @ corners.T).T + p2w[:2, 2]
    (wx0, wy0), (wx1, wy1) = wc.min(axis=0), wc.max(axis=0)
    xstep = _nice_step((wx1 - wx0) / GRID_TARGET_LINES)
    ystep = _nice_step((wy1 - wy0) / GRID_TARGET_LINES)

    # The label anchors in view space: matplotlib's bottom/left of the axes as set
    # (get_xlim/get_ylim reflect invert_x/invert_y).
    xlim, ylim = ax.get_xlim(), ax.get_ylim()

    def to_view(pts_world: np.ndarray) -> np.ndarray:
        return (w2v[:2, :2] @ pts_world.T).T + w2v[:2, 2]

    def cross(v0, v1, axis: int, at: float):
        """Point where segment v0->v1 crosses `axis`==at (None if parallel)."""
        dv = v1[axis] - v0[axis]
        if abs(dv) < 1e-12:
            return None
        t = (at - v0[axis]) / dv
        return v0 + t * (v1 - v0)

    for wx in np.arange(math.ceil(wx0 / xstep) * xstep, wx1 + xstep * 1e-6, xstep):
        v = to_view(np.array([[wx, wy0], [wx, wy1]]))
        ax.plot(v[:, 0], v[:, 1], color=color, linewidth=0.6, alpha=0.35, zorder=4)
        anchor = cross(v[0], v[1], 1, ylim[0])
        if anchor is not None:
            ax.annotate(_fmt(wx), (anchor[0], ylim[0]), xytext=(2, 4),
                        textcoords="offset points", ha="left", va="bottom",
                        fontsize=7, color=color, path_effects=_halo(color),
                        annotation_clip=True, zorder=5)
    for wy in np.arange(math.ceil(wy0 / ystep) * ystep, wy1 + ystep * 1e-6, ystep):
        v = to_view(np.array([[wx0, wy], [wx1, wy]]))
        ax.plot(v[:, 0], v[:, 1], color=color, linewidth=0.6, alpha=0.35, zorder=4)
        anchor = cross(v[0], v[1], 0, xlim[0])
        if anchor is not None:
            ax.annotate(_fmt(wy), (xlim[0], anchor[1]), xytext=(4, 2),
                        textcoords="offset points", ha="left", va="bottom",
                        fontsize=7, color=color, path_effects=_halo(color),
                        annotation_clip=True, zorder=5)
    return {"x_interval": float(xstep), "y_interval": float(ystep)}


def _norm_points(items) -> list[tuple[float, float, str | None]]:
    out = []
    for i, p in enumerate(items or []):
        if isinstance(p, dict):
            out.append((float(p["x"]), float(p["y"]), str(p.get("label") or i + 1)))
        else:
            out.append((float(p[0]), float(p[1]), str(i + 1)))
    return out


def _norm_polygons(items) -> list[tuple[np.ndarray, str | None]]:
    out = []
    for i, p in enumerate(items or []):
        ring, label = (p.get("points"), p.get("label")) if isinstance(p, dict) else (p, None)
        arr = np.asarray(ring, dtype=float)
        if arr.ndim != 2 or arr.shape[0] < 3 or arr.shape[1] != 2:
            raise ValueError(f"polygon {i} must be [[x,y], ...] with at least 3 vertices")
        out.append((arr, str(label) if label is not None else str(i + 1)))
    return out


def _draw_marks(ax, w2v: np.ndarray, mark_points, mark_polygons) -> None:
    """Labeled crosshair rings / dashed outlines at world-space marks. Two-tone
    (black underlay + cyan) so they read on any backdrop or colormap."""

    def to_view(pts_world: np.ndarray) -> np.ndarray:
        return (w2v[:2, :2] @ pts_world.T).T + w2v[:2, 2]

    for x, y, label in _norm_points(mark_points):
        v = to_view(np.array([[x, y]]))[0]
        ax.scatter([v[0]], [v[1]], s=170, facecolors="none", edgecolors="black",
                   linewidths=3.2, zorder=6)
        ax.scatter([v[0]], [v[1]], s=170, facecolors="none", edgecolors=MARKER_COLOR,
                   linewidths=1.4, zorder=7)
        ax.annotate(label, (v[0], v[1]), xytext=(7, 7), textcoords="offset points",
                    fontsize=8, color=MARKER_COLOR, path_effects=_halo(MARKER_COLOR),
                    zorder=7)
    for ring, label in _norm_polygons(mark_polygons):
        closed = np.vstack([ring, ring[:1]])
        v = to_view(closed)
        ax.plot(v[:, 0], v[:, 1], color="black", linewidth=2.8, zorder=6)
        ax.plot(v[:, 0], v[:, 1], color=MARKER_COLOR, linewidth=1.3,
                linestyle=(0, (4, 2)), zorder=7)
        c = to_view(ring.mean(axis=0, keepdims=True))[0]
        ax.annotate(label, (c[0], c[1]), ha="center", va="center", fontsize=8,
                    color=MARKER_COLOR, path_effects=_halo(MARKER_COLOR), zorder=7)


# ---- the render + its coordinate contract ---------------------------------------
def render_view(session, display_id: str | None = None, viewport=None,
                width_px: int = DEFAULT_WIDTH_PX, height_px: int = DEFAULT_HEIGHT_PX,
                include_grid: bool = True, mark_points=None, mark_polygons=None) -> tuple[bytes, dict]:
    """Render one display to (png_bytes, coordinate_meta). `viewport` is
    {target, zoom}, the string "fit", or None (the display's own viewport, falling
    back to fit)."""
    width_px = int(min(max(width_px, 64), MAX_RENDER_PX))
    height_px = int(min(max(height_px, 64), MAX_RENDER_PX))

    display = snapshots.resolve_display(session, display_id)
    if display is None:
        raise ValueError("session has no display to render" if display_id is None
                         else f"display {display_id} not found")
    enc = display.get("encoding", {})
    kind = "embedding" if display.get("type") == "embedding_canvas" else "spatial"

    with session.lock.reading():
        if viewport == "fit" or (viewport is None and not display.get("viewport")):
            viewport = fit_viewport(session, display, width_px, height_px)
        elif viewport is None:
            viewport = display["viewport"]
        spec = {"display_id": display.get("id"), "viewport": viewport,
                "width_px": width_px, "height_px": height_px, "dpi": RENDER_DPI}
        # _render_figure builds a bare (non-pyplot) Figure — no Gcf registration, so
        # nothing to close and concurrent renders can't corrupt shared figure state.
        fig, render_meta = snapshots._render_figure(session, spec)
        ax = fig.axes[0]
        target, zoom = viewport["target"], float(viewport["zoom"])
        bbox = snapshots._window(target, zoom, width_px, height_px)

        # view -> world: identity unless the display renders in image-pixel space.
        element = snapshots._image_element(session, enc) if kind == "spatial" else None
        p2w = (imaging.pixel_to_world(session.sdata, element, session.active_table())
               if element is not None else np.eye(3))
        w2v = np.linalg.inv(p2w)

        grid_meta = None
        if include_grid:
            is_dark = (enc.get("background") or "dark") == "dark"
            grid_meta = _draw_grid(ax, bbox, p2w, w2v, "white" if is_dark else "black")
        if mark_points or mark_polygons:
            _draw_marks(ax, w2v, mark_points, mark_polygons)

        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=fig.dpi)

        meta = _coordinate_meta(ax, p2w, width_px, height_px, viewport, enc, kind,
                                render_meta, grid_meta)
    return buf.getvalue(), meta


def _coordinate_meta(ax, p2w, width_px, height_px, viewport, enc, kind,
                     render_meta, grid_meta) -> dict:
    """The pixel->world contract for the PNG just saved. Derived from the axes limits
    as rendered (so invert_x/invert_y are already folded in) plus the view->world
    affine; validated end to end by test_e2e's run_mcp_flow."""
    (xl0, xl1), (yl0, yl1) = ax.get_xlim(), ax.get_ylim()
    # pixel center (px+0.5, py+0.5) -> view coords; PNG rows run top-down, and the
    # top of the axes is ylim[1] as set.
    sx = (xl1 - xl0) / width_px
    cx = xl0 + 0.5 * sx
    sy = -(yl1 - yl0) / height_px
    cy = yl1 + 0.5 * sy
    M, t = p2w[:2, :2], p2w[:2, 2]
    affine = [float(M[0, 0] * sx), float(M[0, 1] * sy), float(M[0, 0] * cx + M[0, 1] * cy + t[0]),
              float(M[1, 0] * sx), float(M[1, 1] * sy), float(M[1, 0] * cx + M[1, 1] * cy + t[1])]

    def px_to_world(px: float, py: float) -> list[float]:
        return [affine[0] * px + affine[1] * py + affine[2],
                affine[3] * px + affine[4] * py + affine[5]]

    corners_world = np.array([px_to_world(0, 0), px_to_world(width_px - 1, 0),
                              px_to_world(0, height_px - 1), px_to_world(width_px - 1, height_px - 1)])
    space = ("world (obsm:spatial after the points->global transform — the space "
             "annotate/subset polygons use)") if kind == "spatial" else (
        f"embedding obsm:{enc.get('obsm_key', 'X_umap')} components "
        f"[{enc.get('x_component', 0)}, {enc.get('y_component', 1)}] — selections on this view "
        "must use cell_indices (inspect_region/annotate_region with space='embedding')")
    return {
        "image_px": [width_px, height_px],
        "space": space,
        "viewport": viewport,
        "pixel_to_world": affine,
        "formula": ("world_x = A*px + B*py + C; world_y = D*px + E*py + F for pixel column px, "
                    "row py counted from the image's top-left; [A,B,C,D,E,F] = pixel_to_world"),
        "corner_world_coords": {
            "top_left": corners_world[0].tolist(), "top_right": corners_world[1].tolist(),
            "bottom_left": corners_world[2].tolist(), "bottom_right": corners_world[3].tolist()},
        "world_window": {"x": [float(corners_world[:, 0].min()), float(corners_world[:, 0].max())],
                         "y": [float(corners_world[:, 1].min()), float(corners_world[:, 1].max())]},
        "grid": grid_meta,
        "render": render_meta,
        "encoding": {k: enc.get(k) for k in ("color_by", "colormap", "point_size", "opacity",
                                             "image_layer", "render_mode", "background",
                                             "invert_x", "invert_y", "obsm_key",
                                             "x_component", "y_component") if k in enc},
    }


# ---- region membership (shared by inspect/annotate/subset) ----------------------
def cells_in_polygons(session, display: dict | None, polygons, space: str = "spatial") -> np.ndarray:
    """Boolean mask of active-table cells inside any of the polygon rings.
    space='spatial': rings are world coordinates (reuses regions._membership, the
    same math the annotate endpoint applies). space='embedding': rings are embedding
    coordinates of the display's obsm components — resolved here because the backend
    annotate/subset endpoints only take embedding selections as cell_indices."""
    from ..sessions import regions, transform

    adata = session.active_table()
    if space == "spatial":
        affine6 = transform.get_affine6(session.sdata, adata)
        return regions._membership(adata, {"polygons": polygons}, affine6)

    from matplotlib.path import Path as MplPath
    enc = (display or {}).get("encoding", {})
    key = enc.get("obsm_key") or "X_umap"
    if key not in adata.obsm:
        raise ValueError(f"table has no obsm['{key}'] for an embedding selection")
    arr = np.asarray(adata.obsm[key])
    xi, yi = int(enc.get("x_component", 0)), int(enc.get("y_component", 1))
    coords = np.column_stack([arr[:, xi], arr[:, yi]])
    inside = np.zeros(len(coords), dtype=bool)
    for ring in polygons:
        if len(ring) >= 3:
            inside |= MplPath(np.asarray(ring, dtype=float)).contains_points(coords)
    if not inside.any():
        raise ValueError("selection contains zero cells")
    return inside


def region_stats(session, mask: np.ndarray, by: str | None = None,
                 genes: list[str] | None = None) -> dict:
    """Numeric dry-run of a selection: cell count, composition of a categorical obs
    column inside vs overall, and mean expression (inside vs outside) per gene."""
    import pandas as pd

    adata = session.active_table()
    out: dict = {"n_selected": int(mask.sum()), "n_total": int(adata.n_obs)}
    if by is None:
        by = next((c for c in adata.obs.columns
                   if isinstance(adata.obs[c].dtype, pd.CategoricalDtype)), None)
    if by is not None:
        if by not in adata.obs.columns:
            raise ValueError(f"no obs column '{by}'")
        col = adata.obs[by].astype(str)
        inside = col[mask].value_counts()
        overall = col.value_counts()
        out["composition_by"] = by
        out["composition"] = [
            {"value": str(v), "selected": int(inside.get(v, 0)), "total": int(n)}
            for v, n in overall.head(25).items()]
    for gene in genes or []:
        if gene not in adata.var_names:
            raise ValueError(f"no gene '{gene}' in var_names")
        x = adata[:, gene].X
        vals = np.asarray(x.todense() if hasattr(x, "todense") else x, dtype=float).ravel()
        out.setdefault("gene_means", {})[gene] = {
            "selected": float(vals[mask].mean()) if mask.any() else None,
            "elsewhere": float(vals[~mask].mean()) if (~mask).any() else None}
    return out
