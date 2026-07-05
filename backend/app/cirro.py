"""Upload a saved session (plus selected snapshots) to Cirro.

Auth is service-account style (OAuth client-credentials): `config.cirro_enabled()`
gates the feature on three env vars being present, no interactive login. Upload
builds a temp folder of symlinks — the saved `.zarr.zip` plus the files each
selected snapshot actually references — so nothing is copied, then hands that
folder to the Cirro SDK's own directory uploader.
"""
from __future__ import annotations

import json
import re
import tempfile
from pathlib import Path

from .config import config

# The generic "Files" ingest process (accepts any file) — every upload from this
# app uses it, since a saved session/snapshot isn't a bioinformatics file type any
# other process would recognize.
INGEST_PROCESS_ID = "custom_dataset"

_client_cache = None


def _client():
    global _client_cache
    if _client_cache is None:
        if not config.cirro_enabled():
            raise RuntimeError("Cirro is not configured (CIRRO_BASE_URL/CIRRO_CLIENT_ID/CIRRO_CLIENT_SECRET)")
        from cirro import CirroApi, DataPortal
        from cirro.auth.client_creds import ClientCredentialsAuth
        from cirro.config import AppConfig

        app_config = AppConfig(base_url=config.CIRRO_BASE_URL)
        auth_info = ClientCredentialsAuth(config.CIRRO_CLIENT_ID, config.CIRRO_CLIENT_SECRET,
                                          auth_endpoint=app_config.auth_endpoint)
        _client_cache = DataPortal(client=CirroApi(auth_info=auth_info, base_url=config.CIRRO_BASE_URL))
    return _client_cache


def list_projects() -> list[dict]:
    return [{"id": p.id, "name": p.name} for p in _client().list_projects()]


def upload(*, project_id: str, dataset_name: str, upload_folder: Path) -> dict:
    project = _client().get_project_by_id(project_id)
    dataset = project.upload_dataset(name=dataset_name, process=INGEST_PROCESS_ID, upload_folder=str(upload_folder))
    return {"dataset_id": dataset.id, "dataset_name": dataset.name}


def _referenced_assets(html_path: Path) -> list[str]:
    """Snapshot HTML embeds `const V = {...}` with the specific asset/image paths
    it uses; assets/ is shared and content-hashed across every snapshot, so this
    picks out only the files this one snapshot actually needs."""
    m = re.search(r"const V = (\{.*\});\n", html_path.read_text())
    if not m:
        return []
    view = json.loads(m.group(1))
    paths = list((view.get("assets") or {}).values())
    if view.get("image"):
        paths.append(view["image"])
    return paths


def _symlink_snapshot(dest_root: Path, name: str) -> None:
    src = (config.SNAPSHOTS_DIR / name).resolve()
    if not src.is_file():
        raise ValueError(f"snapshot '{name}' not found")
    dest_dir = dest_root / Path(name).stem
    dest_dir.mkdir(parents=True)
    (dest_dir / name).symlink_to(src)
    for rel in _referenced_assets(src):
        asset_src = (config.SNAPSHOTS_DIR / rel).resolve()
        if not asset_src.is_file():
            continue
        asset_dest = dest_dir / rel
        asset_dest.parent.mkdir(parents=True, exist_ok=True)
        asset_dest.symlink_to(asset_src)


def build_upload_folder(store_path: str, snapshot_names: list[str]) -> Path:
    """A temp folder of symlinks: the saved session file under `session/`, and
    each selected snapshot (HTML + only its referenced assets) under `snapshots/`.
    Never symlinks a directory itself (most upload walkers skip symlinked dirs'
    contents) — only real directories containing per-file symlinks."""
    tmp = Path(tempfile.mkdtemp(prefix="cirro-upload-"))
    session_dir = tmp / "session"
    session_dir.mkdir()
    (session_dir / Path(store_path).name).symlink_to(Path(store_path).resolve())

    if snapshot_names:
        snap_dir = tmp / "snapshots"
        snap_dir.mkdir()
        for name in snapshot_names:
            _symlink_snapshot(snap_dir, name)
    return tmp
