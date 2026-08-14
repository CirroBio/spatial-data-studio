"""Upload saved checkpoint sessions to Cirro, under each browser's own Cirro identity.

Auth is the OAuth **device code** flow, per browser, never process-wide: a client
posts a Cirro domain, the backend starts a flow and hands back the login URL, and
the user completes it in their own browser. Because this app is multiuser, a
credential is keyed by a backend-minted secret the client holds (`CREDENTIALS`) —
one connected Cirro identity per browser, held in memory only. `enable_cache=False`
is essential: the SDK's cache would otherwise persist one shared token file under
`~/.cirro/` for every user of the process.

`DeviceCodeAuth` refreshes its own access token from the refresh token, so a long
session survives access-token expiry; when the *refresh* token expires the SDK
raises and the credential is marked stale, which the frontend turns into a prompt
to reconnect.

Upload builds a temp folder of symlinks — the saved `.zarr.zip` checkpoints under
`sessions/`, plus the built SPA (`index.html` + `assets/`) and an `index.json`
listing the checkpoints — so nothing is copied, then hands that folder to the Cirro
SDK's own directory uploader. Those three pieces together are exactly the serverless
deployment layout (DESIGN §14.3), so an uploaded dataset renders itself.
"""
from __future__ import annotations

import json
import logging
import secrets
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import config
from .schemas import checkpoint as checkpoint_schemas

_log = logging.getLogger(__name__)

# The generic "Files" ingest process (accepts any file) — every upload from this
# app uses it, since a saved checkpoint isn't a bioinformatics file type any other
# process would recognize.
INGEST_PROCESS_ID = "custom_dataset"

# Cirro's portal UI groups datasets into folders via a plain dataset tag whose
# value is "folder://<path>" (nested folders use "/" as the separator) — there is
# no dedicated folder API, so both the portal and this app derive the folder list
# by scanning tags across a project's datasets. See Cirro-portal's folder.utils.ts.
FOLDER_TAG_PREFIX = "folder://"

# A connected credential is dropped after this long without use, so a walked-away
# user's Cirro token does not sit in memory for the life of the process.
IDLE_EXPIRY_S = 8 * 60 * 60


class CirroAuthError(RuntimeError):
    """The caller's Cirro credential is missing, still pending, or no longer
    refreshable — all cases where the answer is "connect to Cirro again"."""


@dataclass
class Credential:
    """One browser's Cirro identity. Created `pending` the moment a device-code flow
    starts; a background thread completes it. Everything but `login_url`/`domain` is
    only populated once connected."""

    domain: str
    login_url: str
    auth: object                       # cirro.auth.device_code.DeviceCodeAuth
    state: str = "pending"             # pending | connected | failed
    error: str | None = None
    username: str | None = None
    last_used: float = field(default_factory=time.monotonic)
    _portal: object | None = None
    _projects: list[dict] | None = None
    # project_id -> sorted folder paths (incl. ancestors). Populated lazily from
    # `datasets.list`, an expensive full per-project scan; refreshed on demand
    # rather than on every keystroke of the upload dialog's typeahead.
    _folders: dict[str, list[str]] = field(default_factory=dict)

    def portal(self):
        """The authenticated DataPortal, built on first use after the flow completes."""
        if self.state != "connected":
            raise CirroAuthError(self.error or f"Cirro login is {self.state}")
        if self._portal is None:
            from cirro import CirroApi, DataPortal
            self._portal = DataPortal(client=CirroApi(auth_info=self.auth, base_url=self.domain))
        return self._portal

    def public(self) -> dict:
        return {"state": self.state, "domain": self.domain, "username": self.username,
                "login_url": self.login_url if self.state == "pending" else None,
                "error": self.error}


class CredentialStore:
    """Browser token -> Credential. The token is minted here and returned to the
    client once; it is the only thing that names a credential, so it must be
    unguessable (the presence `client_id` is a plain localStorage value and would
    let anyone who learned it upload as that user)."""

    def __init__(self) -> None:
        # Touched from the event loop (endpoints) and from the device-code polling
        # threads, so every access takes the mutex.
        self._mutex = threading.Lock()
        self._by_token: dict[str, Credential] = {}

    def _expire(self) -> None:
        cutoff = time.monotonic() - IDLE_EXPIRY_S
        for token in [t for t, c in self._by_token.items() if c.last_used < cutoff]:
            del self._by_token[token]

    def get(self, token: str | None) -> Credential | None:
        if not token:
            return None
        with self._mutex:
            self._expire()
            cred = self._by_token.get(token)
            if cred is not None:
                cred.last_used = time.monotonic()
            return cred

    def require(self, token: str | None) -> Credential:
        cred = self.get(token)
        if cred is None:
            raise CirroAuthError("not connected to Cirro")
        return cred

    def put(self, cred: Credential) -> str:
        token = secrets.token_urlsafe(32)
        with self._mutex:
            self._expire()
            self._by_token[token] = cred
        return token

    def drop(self, token: str | None) -> None:
        if not token:
            return
        with self._mutex:
            self._by_token.pop(token, None)


CREDENTIALS = CredentialStore()


def start_login(domain: str) -> tuple[str, Credential]:
    """Begin a device-code flow against `domain` and return (browser token, credential).
    Returns as soon as Cirro issues the login URL; completion is awaited on a background
    thread, which flips the credential to connected/failed."""
    from cirro.auth.device_code import DeviceCodeAuth
    from cirro.config import AppConfig

    # AppConfig discovers the OAuth client id, region and auth endpoint from the
    # domain alone, so the domain is the only thing the user has to supply.
    app_config = AppConfig(base_url=domain)
    auth = DeviceCodeAuth(
        client_id=app_config.client_id,
        region=app_config.region,
        auth_endpoint=app_config.auth_endpoint,
        enable_cache=False,     # never share one token file across this process's users
        await_completion=False,
    )
    cred = Credential(domain=app_config.base_url, login_url=_login_url(auth.auth_message), auth=auth)
    token = CREDENTIALS.put(cred)
    threading.Thread(target=_await_login, args=(cred,), daemon=True).start()
    return token, cred


def _login_url(message: str) -> str:
    """Pull the URL out of the SDK's human-readable auth message ("To authenticate,
    visit <url> and enter the code ..."), which is the only place it is exposed."""
    for part in message.split():
        if part.startswith("http"):
            return part.rstrip(".,")
    raise RuntimeError(f"no login URL in Cirro auth message: {message}")


def _await_login(cred: Credential) -> None:
    """Block on the device-code poll until the user finishes (or it expires). Runs on
    its own thread so the flow keeps running whether or not the client is watching —
    closing the modal must not abandon a login the user is midway through."""
    try:
        cred.auth.await_completion()
        cred.username = cred.auth.get_current_user()
        cred.state = "connected"
    except Exception as e:
        cred.state = "failed"
        cred.error = str(e)
        _log.warning("Cirro device-code login failed: %s", e)


def _reauth_error(e: Exception) -> CirroAuthError:
    """A refresh-token expiry surfaces from deep inside the SDK; turn any auth-shaped
    failure into the one state the frontend acts on (reconnect)."""
    return CirroAuthError(f"Cirro session expired, reconnect required: {e}")


def list_projects(cred: Credential) -> list[dict]:
    if cred._projects is None:
        try:
            cred._projects = [{"id": p.id, "name": p.name} for p in cred.portal().list_projects()]
        except CirroAuthError:
            raise
        except Exception as e:
            raise _reauth_error(e)
    return cred._projects


def _normalize_folder_path(raw: str) -> str:
    """Strip leading/trailing slashes and drop empty segments, e.g.
    "//experiments//2024/" -> "experiments/2024"."""
    return "/".join(part.strip() for part in raw.split("/") if part.strip())


def _with_ancestors(path: str) -> set[str]:
    """"a/b/c" -> {"a", "a/b", "a/b/c"} so a typeahead offers each level."""
    parts = path.split("/")
    return {"/".join(parts[:i]) for i in range(1, len(parts) + 1)}


def list_folders(cred: Credential, project_id: str, force_refresh: bool = False) -> list[str]:
    """Every folder path in use in the project, including intermediate ancestor paths,
    for a folder typeahead. Uses the raw `datasets.list` call rather than
    `project.list_datasets()`, which additionally pulls in datasets from subscribed
    shares and so requires a `VIEW_PROJECT_SHARES` grant the user may not have; a
    dataset's own folder tags are all that matter here anyway."""
    if force_refresh or project_id not in cred._folders:
        paths: set[str] = set()
        try:
            datasets = cred.portal()._client.datasets.list(project_id=project_id)
        except CirroAuthError:
            raise
        except Exception as e:
            raise _reauth_error(e)
        for dataset in datasets:
            for tag in dataset.tags:
                if not tag.value.startswith(FOLDER_TAG_PREFIX):
                    continue
                path = _normalize_folder_path(tag.value[len(FOLDER_TAG_PREFIX):])
                if path:
                    paths.update(_with_ancestors(path))
        cred._folders[project_id] = sorted(paths)
    return cred._folders[project_id]


def upload(*, cred: Credential, project_id: str, dataset_name: str, description: str,
           upload_folder: Path, folder: str | None = None) -> dict:
    project = cred.portal().get_project_by_id(project_id)
    tags = None
    if folder:
        path = _normalize_folder_path(folder)
        if path:
            tags = [f"{FOLDER_TAG_PREFIX}{path}"]
    dataset = project.upload_dataset(name=dataset_name, description=description,
                                     process=INGEST_PROCESS_ID,
                                     upload_folder=str(upload_folder), tags=tags)
    if tags:
        # Make the new folder visible to the next typeahead lookup without a full rescan.
        known = set(cred._folders.get(project_id, []))
        known.update(_with_ancestors(tags[0][len(FOLDER_TAG_PREFIX):]))
        cred._folders[project_id] = sorted(known)
    return {"dataset_id": dataset.id, "dataset_name": dataset.name}


def _symlink(dest: Path, src: Path) -> None:
    """Symlink `dest -> src` unless `dest` already exists (dedupes a checkpoint named
    twice in one selection)."""
    if not dest.exists():
        dest.symlink_to(src)


def viewer_available() -> bool:
    """Whether a built SPA is on disk to bundle. `run.sh` builds one and sets
    `SDS_STATIC_DIR`, and Docker bakes one in; this is False only when uvicorn is
    started by hand without it (or the dev build failed) — the upload still works,
    it just can't carry the viewer, and the client says so rather than shipping a
    broken collection."""
    return bool(config.STATIC_DIR and (config.STATIC_DIR / "index.html").is_file())


def _symlink_viewer(bundle: Path) -> None:
    """Colocate the built SPA with the checkpoints: `index.html` at the bundle root and
    every asset under `assets/`. Together with `index.json` this is the serverless
    deployment layout (DESIGN §14.3), so the uploaded dataset renders itself when
    served. Never symlinks a directory itself — most upload walkers skip a symlinked
    directory's contents — only real directories of per-file symlinks."""
    static = config.STATIC_DIR
    _symlink(bundle / "index.html", static / "index.html")
    for src in sorted(p for p in static.rglob("*") if p.is_file()):
        rel = src.relative_to(static)
        if rel.parts[0] == "index.html":
            continue
        dest = bundle / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        _symlink(dest, src)


def _write_viewer_index(bundle: Path, session_paths: list[str]) -> None:
    """List the bundled checkpoints in `index.json`, the manifest the serverless viewer
    reads (`frontend/src/data/checkpointIndex.ts`). Paths are relative to the manifest,
    so the listing works wherever the bundle is served from. The label is the
    checkpoint's own name with the content hash and extension stripped — what the user
    named the session, rather than the storage filename."""
    from .persistence.store import strip_checkpoint_ext, strip_content_hash

    entries = [
        {
            "path": f"sessions/{Path(path).name}",
            "label": strip_content_hash(strip_checkpoint_ext(Path(path).name)),
        }
        for path in session_paths
    ]
    manifest = {"checkpoints": entries}
    checkpoint_schemas.validate_checkpoint_index(manifest)
    (bundle / "index.json").write_text(json.dumps(manifest, indent=2))


def build_upload_folder(session_paths: list[str]) -> Path:
    """A temp folder of symlinks: each selected checkpoint under `sessions/`, the
    `index.json` manifest, and the built SPA when one is available."""
    tmp = Path(tempfile.mkdtemp(prefix="cirro-upload-"))
    session_dir = tmp / "sessions"
    session_dir.mkdir()
    for path in session_paths:
        _symlink(session_dir / Path(path).name, Path(path).resolve())

    _write_viewer_index(tmp, session_paths)
    if viewer_available():
        _symlink_viewer(tmp)
    return tmp


def upload_selection(*, cred: Credential, project_id: str, dataset_name: str,
                     description: str, session_paths: list[str],
                     folder: str | None = None) -> dict:
    """Build the symlink folder for the selected checkpoints, upload it as one Cirro
    dataset, and clean up the temp folder."""
    upload_dir = build_upload_folder(session_paths)
    try:
        return upload(cred=cred, project_id=project_id, dataset_name=dataset_name,
                      description=description, upload_folder=upload_dir, folder=folder)
    finally:
        shutil.rmtree(upload_dir, ignore_errors=True)
