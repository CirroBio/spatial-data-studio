"""Snapshots: a `<name>.sview.json` view config (viewport + encoding + a baked
render manifest) over an immutable checkpoint, saved alongside it in DATA_DIR.
Opening a snapshot (`SessionManager.create_from_snapshot`) loads its referenced
checkpoint as a read-only, in-app session pinned to the saved view — the same way
any other checkpoint opens, just read-only and with a pinned display instead of the
auto-generated default. There is no standalone viewer: a snapshot is only viewable
through this running app, not shipped as an independent static page.

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

# Snapshot config extension (Spatial View). Saved as `<name>-<hash>.sview.json`
# alongside the checkpoint it references, in DATA_DIR.
SNAPSHOT_EXT = ".sview.json"

# Informational only (no compatibility gate reads this): bumped when the config
# shape changes, so a raw file on disk shows which version wrote it.
SNAPSHOT_CONFIG_VERSION = "2.0"


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


def load_config(name: str) -> dict:
    """Read a saved snapshot's `.sview.json` by name (as returned by
    `list_snapshots`), raising ValueError if it doesn't exist or escapes DATA_DIR."""
    path = _resolve(name)
    if not path.is_file():
        raise ValueError(f"snapshot not found: {name}")
    return json.loads(path.read_text())


def checkpoint_path(cfg: dict) -> str:
    """Resolve a snapshot config's referenced checkpoint to an absolute path under
    DATA_DIR, mirroring `_checkpoint_path`'s naming (both live directly under DATA_DIR,
    never a subfolder — see `save_snapshot`)."""
    name = (cfg.get("checkpoint") or {}).get("name")
    if not name:
        raise ValueError("snapshot config has no checkpoint name")
    return str(_resolve(name))


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
        # Ensure the referenced checkpoint is an up-to-date, immutable .zarr.zip that
        # lives directly under DATA_DIR — checkpoint_path() resolves `checkpoint.name`
        # against DATA_DIR only (no subfolder), so reusing one from elsewhere would
        # bake a name create_from_snapshot can't resolve back — re-save to root.
        sp = session.store_path
        direct_child = sp and Path(sp).resolve().parent == config.DATA_DIR.resolve()
        if not (session.saved and sp and sp.endswith(".zarr.zip") and direct_child):
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
            # Spatial view orientation + backdrop (spatial displays; ignored by the
            # embedding viewer). `background` follows the app's default theme when the
            # user never pinned one — save has no access to the live theme.
            "invert_x": bool(enc.get("invert_x", False)),
            "invert_y": bool(enc.get("invert_y", False)),
            "background": enc.get("background") or "dark",
            "image": None,
            "channels": {},
        }
        image_layer = enc.get("image_layer")
        if kind == "spatial" and image_layer and image_layer in getattr(session.sdata, "images", {}):
            info = imaging.image_info(session.sdata, image_layer, session.active_table())
            limits = imaging.channel_contrast_limits(session.sdata, image_layer)
            render["image"] = info
            render["channels"] = _channels_manifest(enc, info["channel_names"], limits)

    snap_label = label or session.name
    config_obj = {
        "schema_version": SNAPSHOT_CONFIG_VERSION,
        "kind": kind,
        "label": snap_label,
        "created": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "checkpoint": {"name": checkpoint_name},
        "table": table,
        "viewport": view,
        "encoding": enc,
        "render": render,
    }

    # <session-name-slug>-<content-hash> — the config JSON (which carries a microsecond
    # `created` stamp) hashed so each save gets a stable, unique name.
    slug = "".join(c if c.isalnum() or c in "-_" else "-"
                   for c in store.strip_content_hash(session.name))[:48].strip("-") or "snapshot"
    digest = hashlib.sha256(json.dumps(config_obj).encode()).hexdigest()[:store.HASH_LEN]
    name = f"{slug}-{digest}{SNAPSHOT_EXT}"
    with open(os.path.join(_dir(), name), "w") as f:
        json.dump(config_obj, f)
    return {"status": "completed", "name": name, "url": f"/api/snapshots/{name}/open"}


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
            "url": f"/api/snapshots/{f}/open",
            "label": cfg.get("label", f),
            "created": cfg.get("created"),
            "kind": cfg.get("kind", "spatial"),
            "schema_version": cfg.get("schema_version"),
            "checkpoint_name": (cfg.get("checkpoint") or {}).get("name"),
        })
    return out
