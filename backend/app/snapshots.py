"""Snapshots: a small JSON config describing a view (viewport + encoding) over an
immutable checkpoint. The browser snapshot viewer opens the referenced
`.zarr.zip` directly (zarrita.js over HTTP range requests) and renders it, so a
snapshot ships no pixel/data of its own — only the view config plus a baked render
manifest (image geometry + per-channel contrast limits) the browser can't derive
from the raw arrays alone.

Saving a snapshot first ensures the session is written to a content-hashed
checkpoint (so the config points at bytes that won't change under it), then bakes
the manifest — both under one continuous read lock so no compute can interleave
between the save and the bake.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
from pathlib import Path

from .config import config, within_data_dir
from . import imaging
from .persistence import store

SCHEMA = 1
# Snapshot config extension (Spatial View). Saved as `<name>-<hash>.sview.json`
# alongside checkpoints in DATA_DIR.
SNAPSHOT_EXT = ".sview.json"


def _dir() -> str:
    d = str(config.DATA_DIR)
    os.makedirs(d, exist_ok=True)
    return d


def _display(session, display_id: str | None):
    displays = session.app_state.get("displays", [])
    if display_id:
        for d in displays:
            if d.get("id") == display_id:
                return d
        return None
    # default: the first spatial canvas (back-compat with the single-canvas action)
    for d in displays:
        if d.get("type") == "spatial_canvas":
            return d
    return displays[0] if displays else None


def _checkpoint_path(session) -> str:
    """Base checkpoint path for this session (matches main._default_save_path)."""
    return str(config.DATA_DIR / f"{store.strip_content_hash(session.name)}{store.CHECKPOINT_EXT}")


def _channels_manifest(enc: dict, channel_names: list[str], limits: list[float]) -> dict:
    out = {}
    for i in range(len(channel_names)):
        st = (enc.get("channels") or {}).get(str(i), {})
        rgb = imaging.DEFAULT_CHANNEL_COLORS[i % len(imaging.DEFAULT_CHANNEL_COLORS)]
        out[str(i)] = {
            "visible": bool(st.get("visible", True)),
            "color": st.get("color") or "#%02x%02x%02x" % rgb,
            "contrast_limit": limits[i] if i < len(limits) else 255.0,
        }
    return out


def save_snapshot(session, label: str | None = None, viewport: dict | None = None,
                  display_id: str | None = None) -> dict:
    if session.sdata is None:
        return {"status": "failed", "error": "no data to snapshot"}
    display = _display(session, display_id)
    if display is None:
        return {"status": "failed", "error": "no display to snapshot"}

    enc = display.get("encoding", {})
    kind = "embedding" if display.get("type") == "embedding_canvas" else "spatial"
    vp = viewport or display.get("viewport") or {}
    view = {k: vp[k] for k in ("target", "zoom", "rotationX", "rotationOrbit") if k in vp}

    with session.lock.reading():
        # Ensure the referenced checkpoint is an up-to-date, immutable .zarr.zip.
        sp = session.store_path
        if not (session.saved and sp and sp.endswith(".zarr.zip")
                and within_data_dir(Path(sp).resolve())):
            session.store_path = session._write_checkpoint(_checkpoint_path(session), hash_name=True)
            session.saved = True
            session._clear_dirty()
        checkpoint_name = os.path.basename(session.store_path)

        table = session.active_table_key
        # The live canvas applies the editable points->global affine to obsm:spatial
        # (main.py data endpoint); the viewer reads raw obsm from zarr, so bake the
        # affine and let it apply the same transform. Identity for embeddings / no nudge.
        from .sessions import transform
        coords_transform = transform.get_affine6(session.sdata, session.active_table())
        # Embedding displays key their coordinates off obsm_key (e.g. "X_umap"),
        # not the spatial display's `coords`; the viewer reads render.coords directly.
        coords = (f"obsm:{enc.get('obsm_key', '')}" if kind == "embedding"
                  else enc.get("coords") or "obsm:spatial")
        render: dict = {
            "coords": coords,
            "coords_transform": coords_transform,
            "color_by": enc.get("color_by") or "",
            "point_size": enc.get("point_size", 4),
            "opacity": enc.get("opacity", 0.85),
            "image": None,
            "channels": {},
        }
        image_layer = enc.get("image_layer")
        if kind == "spatial" and image_layer and image_layer in getattr(session.sdata, "images", {}):
            info = imaging.image_info(session.sdata, image_layer, session.active_table())
            limits = imaging.channel_contrast_limits(session.sdata, image_layer)
            render["image"] = info
            render["channels"] = _channels_manifest(enc, info["channel_names"], limits)

    config_obj = {
        "schema": SCHEMA,
        "kind": kind,
        "label": label or session.name,
        "created": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "checkpoint": {"name": checkpoint_name, "url": f"/api/checkpoints/{checkpoint_name}"},
        "table": table,
        "viewport": view,
        "encoding": enc,
        "render": render,
    }

    # <session-name-slug>-<content-hash>.sview.json — the config JSON (which carries
    # a microsecond `created` stamp) hashed so each save gets a stable, unique name.
    slug = "".join(c if c.isalnum() or c in "-_" else "-"
                   for c in store.strip_content_hash(session.name))[:48].strip("-") or "snapshot"
    digest = hashlib.sha256(json.dumps(config_obj).encode()).hexdigest()[:store.HASH_LEN]
    name = f"{slug}-{digest}{SNAPSHOT_EXT}"
    with open(os.path.join(_dir(), name), "w") as f:
        json.dump(config_obj, f)
    return {"status": "completed", "name": name, "url": f"/snapshots/{name}"}


def list_snapshots() -> list[dict]:
    d = str(config.DATA_DIR)
    if not os.path.isdir(d):
        return []
    # Newest first by mtime — the names no longer carry a sortable timestamp prefix.
    files = [f for f in os.listdir(d) if f.endswith(SNAPSHOT_EXT)]
    files.sort(key=lambda f: os.path.getmtime(os.path.join(d, f)), reverse=True)
    out = []
    for f in files:
        try:
            with open(os.path.join(d, f)) as fh:
                cfg = json.load(fh)
        except (OSError, ValueError):
            continue
        out.append({
            "name": f,
            "url": f"/snapshots/{f}",
            "label": cfg.get("label", f),
            "created": cfg.get("created"),
            "kind": cfg.get("kind", "spatial"),
            "checkpoint_url": (cfg.get("checkpoint") or {}).get("url"),
        })
    return out
