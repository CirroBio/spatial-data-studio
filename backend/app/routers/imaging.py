"""Image tiles + raw raster zarr serving (client-side Viv compositing)."""
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response

from .. import imaging
from ..config import _within_dir, config
from ..deps import _session, _read_locked, _render_image

router = APIRouter()


@router.get("/api/sessions/{sid}/image/{element}/info")
async def image_info(sid: str, element: str):
    sess = _session(sid)

    def _info():
        table = sess.active_table() if sess.active_table_key else None
        # Base manifest (dims/levels/pixel_to_world/channels/contrast) from
        # imaging.image_info; only the session-specific fields below are added here.
        info = imaging.image_info(sess.sdata, element, table)
        # Client (Viv) compositing is possible when the feature is on AND we have an
        # on-disk store to serve for this element — normalize_rasters registers one for
        # every image, whether freshly rebuilt (non-canonical) or already tile-chunked
        # (canonical, e.g. reopened from a checkpoint: it points at sdata.path). Without
        # the store the raster_base_url would 404, so gate on it here. Channel count is
        # NOT gated: the frontend displays up to MAX_VISIBLE_CHANNELS of the image's
        # channels at once (the picker caps it), so an image with more channels still
        # composites client-side — the user just chooses which ones to show.
        has_store = element in sess.raster_stores
        client_compositing = bool(config.CLIENT_IMAGE_COMPOSITING and has_store)
        info["client_compositing"] = client_compositing
        info["raster_base_url"] = f"/api/sessions/{sid}/raster/{element}"
        info["zarr_group_path"] = f"images/{element}"
        return info

    try:
        return await _read_locked(sess, _info)
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.get("/api/sessions/{sid}/image/{element}/thumbnail")
async def image_thumbnail(sid: str, element: str, max_px: int = 2048, channels: str | None = None):
    sess = _session(sid)
    channel_colors = imaging.parse_channel_colors(channels)

    def _render():
        return imaging.thumbnail_image(sess.sdata, element, max_px, channel_colors)

    try:
        image = await _render_image(sess, _render)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return Response(content=image, media_type=imaging.TILE_IMAGE_MEDIA_TYPE,
                    headers={"Cache-Control": "public, max-age=3600"})


# Serves the session's on-disk normalized raster zarr store so the browser (zarrita
# FetchStore rooted at .../raster/{element}) can read raw per-channel chunks and
# composite on the GPU, instead of fetching server-composited PNG tiles. The PNG tile
# path above stays the fallback. See image_info's client_compositing field.
def _raster_file(store_dir: str, rel: str) -> Path | None:
    """Resolve zarr key `rel` under `store_dir`, or None if it escapes the store
    (absolute, backslash, or `..`) — containment via the shared config._within_dir
    guard. The store dir is under DATA_DIR but this bounds reads to the one
    element's store."""
    if rel.startswith("/") or "\\" in rel or ".." in rel.split("/"):
        return None
    root = Path(store_dir).resolve()
    target = (root / rel).resolve()
    if not _within_dir(target, root):
        return None
    return target


def _byte_range_response(data: bytes, media: str, range_header: str | None, is_head: bool,
                         etag: str) -> Response:
    """Serve in-memory `data` with HTTP Range/HEAD support. The bytes are read under the
    session read lock (see raster_store) and handed here already in memory, so a
    concurrent rmtree of the live store can't race a lazily-streamed file read. `etag` is
    a weak validator computed fresh per request from the backing file's current
    mtime/size (not a session-lifetime assumption), so a swapped store's new file
    naturally gets a new ETag — a client that already has this exact file cached can 304
    (see raster_store), one that doesn't gets a normal 200/206."""
    total = len(data)
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-cache", "ETag": etag}
    if range_header and range_header.startswith("bytes="):
        spec = range_header[len("bytes="):].split(",")[0].strip()
        start_s, _, end_s = spec.partition("-")
        if start_s == "":  # suffix range: last N bytes
            start, end = max(0, total - int(end_s)), total - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else total - 1
        if start > end or start >= total:
            return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{total}"})
        end = min(end, total - 1)
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
        headers["Content-Length"] = str(end - start + 1)
        return Response(content=b"" if is_head else data[start:end + 1], status_code=206,
                        media_type=media, headers=headers)
    headers["Content-Length"] = str(total)
    return Response(content=b"" if is_head else data, media_type=media, headers=headers)


@router.api_route("/api/sessions/{sid}/raster/{element}/{path:path}", methods=["GET", "HEAD"])
async def raster_store(sid: str, element: str, path: str, request: Request):
    sess = _session(sid)
    is_head = request.method == "HEAD"
    range_header = request.headers.get("range")

    def _read():
        # Resolve AND read while holding the read lock (via _read_locked): object-adoption
        # (session.py::_run_call), perform_subset, and close() all rmtree/replace the
        # raster cache dir under the write lock, so reading the bytes into memory here
        # (rather than streaming a FileResponse lazily after the handler returns) is what
        # guarantees the store can't be deleted mid-read. Files are one 512-chunk each
        # (<= a few MB), so a single in-memory read never stalls a writer.
        store_dir = sess.raster_stores.get(element)
        if store_dir is None or not Path(store_dir).is_dir():
            return None
        target = _raster_file(store_dir, path)
        # A missing chunk file is a zarr empty/fill chunk: 404 is correct (zarrita reads
        # it as the array's fill value). Same for a bad key or a gone store.
        if target is None or not target.is_file():
            return None
        media = "application/json" if target.name.endswith(".json") else "application/octet-stream"
        st = target.stat()
        etag = f'W/"{st.st_mtime_ns:x}-{st.st_size:x}"'
        cached = imaging.raster_chunk_get(sess.sdata, element, path)
        if cached is not None:
            return cached, media, etag
        data = target.read_bytes()
        imaging.raster_chunk_put(sess.sdata, element, path, data)
        return data, media, etag

    result = await _read_locked(sess, _read)
    if result is None:
        raise HTTPException(404, "not found")
    data, media, etag = result
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
    return _byte_range_response(data, media, range_header, is_head, etag)
