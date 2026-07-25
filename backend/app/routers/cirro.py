"""Cirro integration: status/projects/folders and background dataset uploads
(service-account auth; dark unless configured)."""
import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException

from ..config import config, within_data_dir
from ..transport.sse import BUS
from ..deps import _in_executor

router = APIRouter()


class UploadQueue:
    """Background Cirro uploads behind a small concurrency cap so several large uploads
    don't all realize at once; anything over the cap waits (pending). The
    uploading/pending counts broadcast over SSE (cirro.upload.state) and are also served
    by GET so a fresh page renders the in-progress indicator without waiting for the next
    state change."""

    def __init__(self, concurrency: int = 2):
        self._concurrency = concurrency
        self._sem: asyncio.Semaphore | None = None  # lazily bound to the running loop
        self.active = 0    # currently uploading
        self.pending = 0   # queued behind the concurrency cap

    def _publish(self):
        BUS.publish("cirro.upload.state", {"uploading": self.active, "pending": self.pending})

    def state(self) -> dict:
        return {"uploading": self.active, "pending": self.pending}

    def submit(self, project_id, dataset_name, session_paths, snapshot_names, folder):
        asyncio.create_task(self._run(project_id, dataset_name, session_paths, snapshot_names, folder))

    async def _run(self, project_id, dataset_name, session_paths, snapshot_names, folder):
        from .. import cirro
        if self._sem is None:
            self._sem = asyncio.Semaphore(self._concurrency)  # bind to the running loop

        def _do():
            return cirro.upload_selection(project_id=project_id, dataset_name=dataset_name,
                                          session_paths=session_paths, snapshot_names=snapshot_names,
                                          folder=folder)
        self.pending += 1
        self._publish()
        async with self._sem:
            self.pending -= 1
            self.active += 1
            self._publish()
            try:
                result = await _in_executor(_do)
                BUS.publish("cirro.upload.completed", {"dataset_name": result["dataset_name"]})
            except Exception as e:
                BUS.publish("cirro.upload.failed", {"error": str(e), "dataset_name": dataset_name})
            finally:
                self.active -= 1
                self._publish()


_uploads = UploadQueue()


@router.get("/api/cirro/status")
async def cirro_status():
    return {"enabled": config.cirro_enabled()}


@router.get("/api/cirro/projects")
async def cirro_projects():
    if not config.cirro_enabled():
        raise HTTPException(503, "Cirro is not configured")
    from .. import cirro
    return {"projects": cirro.list_projects()}


@router.get("/api/cirro/projects/{project_id}/folders")
async def cirro_folders(project_id: str, refresh: bool = False):
    if not config.cirro_enabled():
        raise HTTPException(503, "Cirro is not configured")
    from .. import cirro
    return {"folders": cirro.list_folders(project_id, force_refresh=refresh)}


@router.get("/api/cirro/uploads")
async def cirro_uploads():
    return _uploads.state()


@router.post("/api/cirro/upload")
async def cirro_upload(body: dict):
    """Upload user-selected saved checkpoint sessions + snapshots to Cirro as one
    dataset, decoupled from any live session. Runs in the background (uploads can be
    large) and announces completion/failure over SSE — cirro.upload.completed /
    cirro.upload.failed — since it isn't tied to a session's job queue. body:
    {project_id, dataset_name, session_paths: [str], snapshot_names: [str], folder?}."""
    if not config.cirro_enabled():
        raise HTTPException(503, "Cirro is not configured")
    session_paths = body.get("session_paths") or []
    snapshot_names = body.get("snapshot_names") or []
    if not session_paths and not snapshot_names:
        raise HTTPException(400, "select at least one session or snapshot to upload")
    resolved: list[str] = []
    for p in session_paths:
        target = Path(p).resolve()
        if not within_data_dir(target) or not target.exists():
            raise HTTPException(400, f"not a saved checkpoint session: {p}")
        resolved.append(str(target))
    _uploads.submit(body["project_id"], body["dataset_name"], resolved, snapshot_names,
                    body.get("folder") or None)
    return {"status": "started"}
