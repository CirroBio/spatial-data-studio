"""Snapshots (v3 Part 9): a self-contained, read-only HTML view of the current
display that the user can pan and zoom but not edit. The snapshot folder is the
shareable unit — an HTML file plus an `assets/` folder of content-hashed Arrow
data fields (deduped across snapshots) and the composited image. The HTML embeds
the captured view-state and a tiny inlined canvas renderer (no external deps),
so it opens anywhere.

Note (deviation from a second compiled deck.gl bundle): the read-only viewer is an
inlined vanilla-canvas renderer that draws the captured points over the image with
pan/zoom and colors points with the same `uns` palette the live canvas uses, so the
frozen view matches without shipping a second SPA build into every snapshot folder.
"""
from __future__ import annotations

import datetime
import hashlib
import html
import json
import os

import numpy as np

from .config import config
from . import imaging
from .transport import arrow


def _dir() -> str:
    d = str(config.SNAPSHOTS_DIR)
    os.makedirs(os.path.join(d, "assets"), exist_ok=True)
    return d


def _write_asset(data: bytes, ext: str) -> str:
    """Content-hash an asset into assets/<sha256>.<ext>; dedupe; return its rel path."""
    h = hashlib.sha256(data).hexdigest()
    rel = f"assets/{h}.{ext}"
    path = os.path.join(_dir(), rel)
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(data)
    return rel


def _active_display(session):
    for d in session.app_state.get("displays", []):
        if d.get("type") == "spatial_canvas":
            return d
    return None


def _point_colors(adata, color_by: str, n: int) -> list[str]:
    """Per-point hex colors, reusing the AnnData's stored categorical palette
    (uns['<col>_colors']) so the snapshot matches the canvas; viridis-ish ramp for
    numeric fields."""
    default = ["#888888"] * n
    if not color_by or ":" not in color_by:
        return default
    kind, key = color_by.split(":", 1)
    if kind == "obs" and key in adata.obs.columns:
        col = adata.obs[key]
        if str(col.dtype) == "category" or col.dtype == object:
            cats = list(col.astype("category").cat.categories)
            palette = list(adata.uns.get(f"{key}_colors", []))
            codes = col.astype("category").cat.codes.to_numpy()
            if len(palette) < len(cats):
                import matplotlib.cm as cm
                palette = [_rgb_hex(cm.tab20(i % 20)) for i in range(len(cats))]
            return [palette[c] if 0 <= c < len(palette) else "#888888" for c in codes]
        return _numeric_hex(col.to_numpy())
    if kind == "X" and key in adata.var_names:
        x = adata[:, key].X
        vals = np.asarray(x.todense()).ravel() if hasattr(x, "todense") else np.asarray(x).ravel()
        return _numeric_hex(vals)
    return default


def _rgb_hex(rgba) -> str:
    r, g, b = (int(255 * c) for c in rgba[:3])
    return f"#{r:02x}{g:02x}{b:02x}"


def _numeric_hex(vals: np.ndarray) -> list[str]:
    import matplotlib.cm as cm
    v = np.asarray(vals, dtype="float32")
    lo, hi = float(np.nanmin(v)), float(np.nanmax(v))
    norm = (v - lo) / (hi - lo) if hi > lo else np.zeros_like(v)
    return [_rgb_hex(cm.viridis(float(t))) for t in norm]


def save_snapshot(session, label: str | None = None) -> dict:
    if session.sdata is None:
        return {"status": "failed", "error": "no data to snapshot"}
    display = _active_display(session)
    if display is None:
        return {"status": "failed", "error": "no spatial canvas display to snapshot"}
    enc = display.get("encoding", {})

    session.lock.acquire_read()
    try:
        adata = session.active_table()
        coords_key = (enc.get("coords") or "obsm:spatial").split(":", 1)[-1]
        xy = np.asarray(adata.obsm[coords_key])[:, :2]
        colors = _point_colors(adata, enc.get("color_by") or "", xy.shape[0])

        # content-hashed Arrow data assets (the durable, deduped data record)
        assets = {}
        if enc.get("coords"):
            assets["coords"] = _write_asset(arrow.to_ipc_bytes(arrow.resolve_field(adata, enc["coords"])), "arrow")
        if enc.get("color_by"):
            try:
                assets["color"] = _write_asset(arrow.to_ipc_bytes(arrow.resolve_field(adata, enc["color_by"])), "arrow")
            except (KeyError, ValueError):
                pass

        image_layer = enc.get("image_layer")
        bounds = None
        image_rel = None
        if image_layer and image_layer in getattr(session.sdata, "images", {}):
            visible = _visible_channels(enc)
            png = imaging.thumbnail_png(session.sdata, image_layer, 2048, visible)
            image_rel = _write_asset(png, "png")
            bounds = imaging.image_info(session.sdata, image_layer)["bounds"]
    finally:
        session.lock.release_read()

    if bounds is None:
        bounds = [float(xy[:, 0].min()), float(xy[:, 1].min()), float(xy[:, 0].max()), float(xy[:, 1].max())]

    view = {"encoding": enc, "viewport": display.get("viewport"), "bounds": bounds,
            "image": image_rel, "assets": assets,
            "points": {"xy": xy.astype("float32").round(2).tolist(), "colors": colors,
                       "size": enc.get("point_size", 4), "opacity": enc.get("opacity", 0.85)}}

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    slug = "".join(c if c.isalnum() or c in "-_" else "-" for c in (label or session.name))[:48]
    name = f"{stamp}_{slug}.html"
    with open(os.path.join(_dir(), name), "w") as f:
        f.write(_render_html(view, label or session.name))
    return {"status": "completed", "name": name, "url": f"/snapshots/{name}"}


def _visible_channels(enc: dict) -> list[int] | None:
    ch = enc.get("channels")
    if not ch:
        return None
    vis = [int(i) for i, st in ch.items() if st.get("visible", True)]
    return sorted(vis)


def list_snapshots(session=None) -> list[dict]:
    d = str(config.SNAPSHOTS_DIR)
    if not os.path.isdir(d):
        return []
    return [{"name": f, "url": f"/snapshots/{f}"} for f in sorted(os.listdir(d), reverse=True) if f.endswith(".html")]


def _render_html(view: dict, title: str) -> str:
    payload = json.dumps(view)
    safe_title = html.escape(title)
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{safe_title} — snapshot</title>
<style>
  html,body{{margin:0;height:100%;background:#0f1117;color:#e6e6e6;font:13px system-ui,sans-serif;overflow:hidden}}
  #bar{{position:fixed;top:0;left:0;right:0;padding:6px 10px;background:#1a1d27;border-bottom:1px solid #2a2f3a;z-index:2}}
  #bar b{{color:#a07ce0}} #bar span{{color:#8a8f9a;margin-left:8px}}
  canvas{{display:block;position:absolute;inset:0;cursor:grab}} canvas:active{{cursor:grabbing}}
</style></head>
<body>
<div id="bar"><b>{safe_title}</b><span>read-only snapshot — drag to pan, scroll to zoom</span></div>
<canvas id="c"></canvas>
<script>
const V = {payload};
const cv = document.getElementById('c'), ctx = cv.getContext('2d');
let img = null;
if (V.image) {{ img = new Image(); img.src = V.image; img.onload = draw; }}
const [x0,y0,x1,y1] = V.bounds; const wW = x1-x0, wH = y1-y0;
let scale = 1, ox = 0, oy = 0, init = false;
function resize(){{ cv.width = innerWidth; cv.height = innerHeight; if(!init){{fit(); init=true;}} draw(); }}
function fit(){{ const s = Math.min(cv.width/wW, (cv.height-30)/wH)*0.92; scale = s;
  ox = (cv.width - wW*s)/2 - x0*s; oy = 30 + (cv.height-30 - wH*s)/2 - y0*s; }}
function wx(x){{return x*scale+ox}} function wy(y){{return y*scale+oy}}
function draw(){{
  ctx.fillStyle='#0f1117'; ctx.fillRect(0,0,cv.width,cv.height);
  if(img){{ ctx.globalAlpha=1; ctx.drawImage(img, wx(x0), wy(y0), wW*scale, wH*scale); }}
  const xy=V.points.xy, cols=V.points.colors, r=Math.max(1.2, V.points.size*scale*0.5);
  ctx.globalAlpha=V.points.opacity;
  for(let i=0;i<xy.length;i++){{ ctx.fillStyle=cols[i]||'#888'; ctx.beginPath();
    ctx.arc(wx(xy[i][0]), wy(xy[i][1]), r, 0, 6.2832); ctx.fill(); }}
  ctx.globalAlpha=1;
}}
let drag=null;
cv.addEventListener('mousedown',e=>drag=[e.clientX,e.clientY,ox,oy]);
addEventListener('mouseup',()=>drag=null);
addEventListener('mousemove',e=>{{ if(!drag)return; ox=drag[2]+(e.clientX-drag[0]); oy=drag[3]+(e.clientY-drag[1]); draw(); }});
cv.addEventListener('wheel',e=>{{ e.preventDefault(); const f=e.deltaY<0?1.1:1/1.1;
  const mx=e.clientX, my=e.clientY; ox=mx-(mx-ox)*f; oy=my-(my-oy)*f; scale*=f; draw(); }},{{passive:false}});
addEventListener('resize',resize); resize();
</script></body></html>"""
