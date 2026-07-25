"""Figure-snapshot lifecycle (render/save, preview, list, download, delete) and
direct checkpoint `.zarr.zip` serving for the in-SPA zarrita viewer."""
import os

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse

from .. import snapshots
from ..config import config, within_data_dir
from ..deps import _session, _writable_session, _in_executor

router = APIRouter()


@router.post("/api/sessions/{sid}/snapshot")
async def save_snapshot_endpoint(sid: str, body: dict):
    """Render and save a high-quality figure snapshot (vector PDF and/or raster PNG) of
    a display. body: {viewport:{target,zoom}, width_px, height_px, dpi,
    formats:['pdf'|'png'], label?, display_id?}."""
    sess = _writable_session(sid)
    result = await _in_executor(snapshots.save_snapshot, sess, body)
    if result.get("status") == "failed":
        raise HTTPException(400, result.get("error", "snapshot failed"))
    return result


@router.post("/api/sessions/{sid}/snapshot/preview")
async def snapshot_preview_endpoint(sid: str, body: dict):
    """A low-cost PNG preview of the snapshot framing for the export modal. Same body as
    the save endpoint; renders small and returns image bytes, writing nothing."""
    sess = _session(sid)
    try:
        png = await _in_executor(snapshots.render_preview, sess, body)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))
    return Response(content=png, media_type="image/png")


@router.get("/api/snapshots")
async def list_snapshots_endpoint():
    return {"snapshots": snapshots.list_snapshots()}


@router.get("/api/snapshots/{name}/file")
async def get_snapshot_file(name: str, fmt: str = "pdf"):
    """Serve a snapshot's rendered PDF or PNG for download."""
    if fmt not in ("pdf", "png"):
        raise HTTPException(400, "fmt must be pdf or png")
    try:
        path = snapshots.artifact_path(name, fmt)
    except (ValueError, KeyError):
        raise HTTPException(404, "not found")
    if not os.path.isfile(path):
        raise HTTPException(404, "not found")
    media = "application/pdf" if fmt == "pdf" else "image/png"
    return FileResponse(path, media_type=media, filename=os.path.basename(path))


@router.get("/api/snapshots/{name}/thumbnail")
async def get_snapshot_thumbnail(name: str):
    try:
        path = snapshots.artifact_path(name, "thumbnail")
    except (ValueError, KeyError):
        raise HTTPException(404, "not found")
    if not os.path.isfile(path):
        raise HTTPException(404, "not found")
    return FileResponse(path, media_type="image/png")


@router.delete("/api/snapshots/{name}")
async def delete_snapshot_endpoint(name: str):
    try:
        removed = await _in_executor(snapshots.delete_snapshot, name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not removed:
        raise HTTPException(404, "not found")
    return {"status": "deleted"}


@router.api_route("/api/checkpoints/{name}", methods=["GET", "HEAD"])
async def get_checkpoint(name: str):
    """Serve a saved checkpoint `.zarr.zip` for direct browser reads (zarrita.js over
    HTTP range). FileResponse honors Range (206) and HEAD (zarrita probes the size
    before range-reading). Scoped to a single `*.zarr.zip` file name inside DATA_DIR —
    the transient `.rasters`/`.save-` caches (directories) and the `.figure.*` snapshot
    artifacts are never matched by name here."""
    if not name.endswith(".zarr.zip") or "/" in name or "\\" in name:
        raise HTTPException(404, "not found")
    target = (config.DATA_DIR / name).resolve()
    if not within_data_dir(target) or not target.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(str(target), media_type="application/zip")
