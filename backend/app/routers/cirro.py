"""Cirro integration: per-browser device-code login, project/folder lookups, and
background dataset uploads.

Every endpoint here is scoped to the calling browser's own Cirro identity, named by
the `X-SDS-Cirro-Token` header the connect call mints (see `cirro.CredentialStore`).
There is no server-side Cirro credential and nothing is shared between browsers.
"""
import logging
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException

from ..cirro import CREDENTIALS, UPLOADS, CirroAuthError, Credential
from ..config import config, within_data_dir
from ..deps import _in_executor

_log = logging.getLogger(__name__)

router = APIRouter()


# The `x_sds_cirro_token` header every endpoint below takes is the minted credential
# token. Distinct from X-SDS-Client-Id (the presence/lock id), which is a plain
# localStorage value and so cannot name a credential — see cirro.CredentialStore.
def _require(token: str | None) -> Credential:
    """The caller's connected credential, or a 401 the frontend turns into a prompt
    to (re)connect. 401 rather than 403 so one status covers never-connected, still
    pending, and refresh-token-expired alike."""
    try:
        cred = CREDENTIALS.require(token)
        if cred.state != "connected":
            raise CirroAuthError(cred.error or f"Cirro login is {cred.state}")
        return cred
    except CirroAuthError as e:
        raise HTTPException(401, str(e))


# ---- auth ------------------------------------------------------------------
@router.get("/api/cirro/auth")
async def cirro_auth_status(x_sds_cirro_token: str | None = Header(default=None)):
    """This browser's Cirro login state. `default_domain` lets the connect dialog
    prefill without a second call; `viewer_bundled` tells the upload dialog whether
    the built SPA can ride along (see cirro.viewer_available)."""
    from .. import cirro
    cred = CREDENTIALS.get(x_sds_cirro_token)
    auth = cred.public() if cred else {"state": "disconnected", "domain": None,
                                       "username": None, "login_url": None, "error": None}
    return {**auth, "default_domain": config.CIRRO_BASE_URL,
            "viewer_bundled": cirro.viewer_available()}


@router.post("/api/cirro/auth")
async def cirro_auth_start(body: dict, x_sds_cirro_token: str | None = Header(default=None)):
    """Start a device-code login against `domain`. Returns the login URL immediately;
    the flow completes on a background thread, so the client polls for the state to
    flip to connected. body: {domain}."""
    from .. import cirro
    domain = (body.get("domain") or "").strip()
    if not domain:
        raise HTTPException(400, "a Cirro domain is required")
    try:
        domain = cirro.validate_domain(domain)
    except ValueError as e:
        # Safe to reflect: validate_domain's messages describe the required input
        # format only, never whether anything was reachable.
        raise HTTPException(400, str(e))
    try:
        token, cred = await _in_executor(cirro.start_login, domain)
    except Exception as e:
        # Never echo the failure detail (or the domain) back to the client — for an
        # attacker-supplied domain it would act as a reachability oracle. The real
        # error goes to the server log instead.
        _log.warning("could not start Cirro login against %s: %s", domain, e)
        raise HTTPException(502, "could not reach Cirro")
    # Retrying (or switching domains) replaces this browser's credential rather than
    # leaving the abandoned one to sit until it idles out.
    CREDENTIALS.drop(x_sds_cirro_token)
    return {"token": token, **cred.public()}


@router.delete("/api/cirro/auth")
async def cirro_auth_disconnect(x_sds_cirro_token: str | None = Header(default=None)):
    """Forget this browser's Cirro credential. In-flight uploads hold their own
    reference and run to completion."""
    CREDENTIALS.drop(x_sds_cirro_token)
    return {"state": "disconnected"}


# ---- lookups ---------------------------------------------------------------
@router.get("/api/cirro/projects")
async def cirro_projects(x_sds_cirro_token: str | None = Header(default=None)):
    from .. import cirro
    cred = _require(x_sds_cirro_token)
    try:
        return {"projects": await _in_executor(cirro.list_projects, cred)}
    except CirroAuthError as e:
        raise HTTPException(401, str(e))


@router.get("/api/cirro/projects/{project_id}/folders")
async def cirro_folders(project_id: str, refresh: bool = False,
                        x_sds_cirro_token: str | None = Header(default=None)):
    from .. import cirro
    cred = _require(x_sds_cirro_token)
    try:
        folders = await _in_executor(cirro.list_folders, cred, project_id, refresh)
    except CirroAuthError as e:
        raise HTTPException(401, str(e))
    return {"folders": folders}


# ---- upload ----------------------------------------------------------------
@router.get("/api/cirro/uploads")
async def cirro_uploads(x_sds_cirro_token: str | None = Header(default=None)):
    """The caller's own uploads. Scoped rather than global: a row names a Cirro project
    and dataset, which is not something to hand to every browser sharing this app."""
    return UPLOADS.state(x_sds_cirro_token)


@router.delete("/api/cirro/uploads/{upload_id}")
async def cirro_dismiss_upload(upload_id: int,
                               x_sds_cirro_token: str | None = Header(default=None)):
    UPLOADS.dismiss(upload_id, x_sds_cirro_token)
    return UPLOADS.state(x_sds_cirro_token)


@router.post("/api/cirro/upload")
async def cirro_upload(body: dict, x_sds_cirro_token: str | None = Header(default=None)):
    """Upload user-selected saved checkpoints to Cirro as one dataset, decoupled from
    any live session. The bundle also carries `index.json` and the built SPA, so the
    dataset is a self-hosting serverless viewer (DESIGN §14.3). Runs in the background
    (uploads can be large) and announces state over SSE — cirro.upload.state /
    .completed / .failed — since it isn't tied to a session's job queue.
    body: {project_id, dataset_name, description?, session_paths: [str], folder?}."""
    cred = _require(x_sds_cirro_token)
    session_paths = body.get("session_paths") or []
    if not session_paths:
        raise HTTPException(400, "select at least one saved session to upload")
    if not (body.get("project_id") and (body.get("dataset_name") or "").strip()):
        raise HTTPException(400, "a project and dataset name are required")
    resolved: list[str] = []
    for p in session_paths:
        target = Path(p).resolve()
        if not within_data_dir(target) or not target.exists():
            raise HTTPException(400, f"not a saved checkpoint session: {p}")
        resolved.append(str(target))
    upload_id = UPLOADS.submit(x_sds_cirro_token, cred, body["project_id"],
                               body["dataset_name"].strip(),
                               (body.get("description") or "").strip(), resolved,
                               body.get("folder") or None)
    return {"status": "started", "id": upload_id}
