"""Upload a saved session (plus selected snapshots) to Cirro.

Auth is service-account style (OAuth client-credentials): `config.cirro_enabled()`
gates the feature on three env vars being present, no interactive login. Upload
builds a temp folder of symlinks — the saved `.zarr.zip` checkpoints under
`sessions/`, and each selected snapshot's `.sview.json` config plus the `.zarr.zip`
checkpoint it references, colocated at the bundle root — so nothing is copied, then
hands that folder to the Cirro SDK's own directory uploader. A snapshot isn't
independently viewable in Cirro (it only opens through this running app, read-only —
see `snapshots.py`); its config travels along as a labeled view-pointer for
provenance, not as a standalone viewer.
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

from .config import config, within_data_dir

# The generic "Files" ingest process (accepts any file) — every upload from this
# app uses it, since a saved session/snapshot isn't a bioinformatics file type any
# other process would recognize.
INGEST_PROCESS_ID = "custom_dataset"

# Cirro's portal UI groups datasets into folders via a plain dataset tag whose
# value is "folder://<path>" (nested folders use "/" as the separator) — there is
# no dedicated folder API, so both the portal and this app derive the folder list
# by scanning tags across a project's datasets. See Cirro-portal's folder.utils.ts.
FOLDER_TAG_PREFIX = "folder://"

_client_cache = None
# The project list, cached after the first (network + auth) fetch. Prewarmed at
# startup when Cirro is configured (see prewarm.py) so the upload dialog's project
# dropdown is populated the moment it opens; changes rarely within a run.
_projects_cache: list[dict] | None = None
# project_id -> sorted list of known folder paths (including ancestor paths).
# Populated lazily from `list_datasets()`, which is otherwise an expensive full
# per-project scan; refreshed on demand rather than on every keystroke of the
# upload dialog's typeahead.
_folders_cache: dict[str, list[str]] = {}


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


def list_projects(force_refresh: bool = False) -> list[dict]:
    global _projects_cache
    if force_refresh or _projects_cache is None:
        _projects_cache = [{"id": p.id, "name": p.name} for p in _client().list_projects()]
    return _projects_cache


def _normalize_folder_path(raw: str) -> str:
    """Strip leading/trailing slashes and drop empty segments, e.g.
    "//experiments//2024/" -> "experiments/2024"."""
    return "/".join(part.strip() for part in raw.split("/") if part.strip())


def list_folders(project_id: str, force_refresh: bool = False) -> list[str]:
    """Every folder path in use in the project, including intermediate ancestor
    paths (so "a/b/c" also contributes "a" and "a/b"), for a folder typeahead.
    Uses the raw `datasets.list` call rather than `project.list_datasets()`,
    which additionally pulls in datasets from subscribed shares and so requires
    a `VIEW_PROJECT_SHARES` grant the upload service account may not have; a
    dataset's own folder tags are all that matter here anyway."""
    if force_refresh or project_id not in _folders_cache:
        paths: set[str] = set()
        for dataset in _client()._client.datasets.list(project_id=project_id):
            for tag in dataset.tags:
                if not tag.value.startswith(FOLDER_TAG_PREFIX):
                    continue
                path = _normalize_folder_path(tag.value[len(FOLDER_TAG_PREFIX):])
                if not path:
                    continue
                parts = path.split("/")
                paths.update("/".join(parts[:i]) for i in range(1, len(parts) + 1))
        _folders_cache[project_id] = sorted(paths)
    return _folders_cache[project_id]


def upload(*, project_id: str, dataset_name: str, upload_folder: Path, folder: str | None = None) -> dict:
    project = _client().get_project_by_id(project_id)
    tags = None
    if folder:
        path = _normalize_folder_path(folder)
        if path:
            tags = [f"{FOLDER_TAG_PREFIX}{path}"]
    dataset = project.upload_dataset(name=dataset_name, process=INGEST_PROCESS_ID,
                                     upload_folder=str(upload_folder), tags=tags)
    if tags:
        # Make the new folder visible to the next typeahead lookup without a full rescan.
        _folders_cache.setdefault(project_id, [])
        parts = tags[0][len(FOLDER_TAG_PREFIX):].split("/")
        known = set(_folders_cache[project_id])
        known.update("/".join(parts[:i]) for i in range(1, len(parts) + 1))
        _folders_cache[project_id] = sorted(known)
    return {"dataset_id": dataset.id, "dataset_name": dataset.name}


def _referenced_checkpoint(config_path: Path) -> str | None:
    """The checkpoint `.zarr.zip` filename a JSON snapshot config points at."""
    try:
        cfg = json.loads(config_path.read_text())
    except (OSError, ValueError):
        return None
    return (cfg.get("checkpoint") or {}).get("name")


def _snapshot_src(name: str) -> Path:
    """Resolve a client-supplied snapshot name under DATA_DIR, rejecting any that
    escapes it (a `../`/absolute name) so an upload can't symlink or read an arbitrary
    host file into the bundle sent off-box to Cirro."""
    src = (config.DATA_DIR / name).resolve()
    if not within_data_dir(src):
        raise ValueError(f"invalid snapshot name: {name}")
    return src


def _symlink(dest: Path, src: Path) -> None:
    """Symlink `dest -> src` unless `dest` already exists (dedupes a checkpoint
    referenced by several snapshots or also selected as a session)."""
    if not dest.exists():
        dest.symlink_to(src)


def _symlink_snapshot(bundle: Path, name: str) -> None:
    """Colocate a snapshot's `.sview.json` config and the `.zarr.zip` checkpoint it
    references as siblings at the bundle root — provenance for the uploaded dataset,
    not a standalone viewer (a snapshot only opens read-only through this app)."""
    src = _snapshot_src(name)
    if not src.is_file():
        raise ValueError(f"snapshot '{name}' not found")
    _symlink(bundle / name, src)
    ckpt = _referenced_checkpoint(src)
    if ckpt:
        ckpt_src = _snapshot_src(ckpt)
        if ckpt_src.is_file():
            _symlink(bundle / ckpt, ckpt_src)


def build_upload_folder(session_paths: list[str], snapshot_names: list[str]) -> Path:
    """A temp folder of symlinks: each selected saved checkpoint under `sessions/`,
    and each selected snapshot's `.sview.json` config plus the `.zarr.zip` it
    references, colocated at the bundle root. Never symlinks a directory itself (most
    upload walkers skip symlinked dirs' contents) — only real directories of
    per-file symlinks."""
    tmp = Path(tempfile.mkdtemp(prefix="cirro-upload-"))
    session_dir = tmp / "sessions"
    session_dir.mkdir()
    for path in session_paths:
        _symlink(session_dir / Path(path).name, Path(path).resolve())

    for name in snapshot_names:
        _symlink_snapshot(tmp, name)

    if not any(session_dir.iterdir()):
        session_dir.rmdir()  # no sessions selected
    return tmp


def upload_selection(*, project_id: str, dataset_name: str, session_paths: list[str],
                     snapshot_names: list[str], folder: str | None = None) -> dict:
    """Build the symlink folder for the selected sessions + snapshots, upload it
    as one Cirro dataset, and clean up the temp folder."""
    import shutil
    upload_dir = build_upload_folder(session_paths, snapshot_names)
    try:
        return upload(project_id=project_id, dataset_name=dataset_name,
                      upload_folder=upload_dir, folder=folder)
    finally:
        shutil.rmtree(upload_dir, ignore_errors=True)
