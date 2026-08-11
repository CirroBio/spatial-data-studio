import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import config, data_roots, within_data_dir
from .registry.introspect import REGISTRY
from .sessions.manager import SessionManager
from .sessions.presence import PRESENCE, clean_name
from .transport.sse import BUS
from .transport import arrow
from .transport import tables
from .transport.compression import SelectiveGZipMiddleware
from .prewarm import PREWARM
from . import datasets
from . import deps
from .deps import (_session, _writable_session, _claim_lock, _mgr, _in_executor,
                   _read_locked, bind_client_id, CLIENT_ID)
from .routers import imaging as imaging_router, cirro as cirro_router
from .routers import snapshots as snapshots_router, recipes as recipes_router

_log = logging.getLogger(__name__)

_READY = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _READY
    _log.info("container memory limit: %d MiB (source: %s)",
              config.CONTAINER_MEM_MB, config.CONTAINER_MEM_SOURCE)
    _log.info("cpu allocation: %.2f cores (source: %s); compute pool=%d workers, n_threads=%d",
              config.CPU_LIMIT, config.CPU_LIMIT_SOURCE,
              config.COMPUTE_POOL_WORKERS, config.N_THREADS)
    REGISTRY.build()
    deps.set_manager(SessionManager(REGISTRY))
    BUS.bind_loop(asyncio.get_running_loop())
    _READY = True
    sampler = asyncio.create_task(_resource_loop())
    PREWARM.start()
    _submit_prewarm_tasks()
    try:
        yield
    finally:
        sampler.cancel()
        PREWARM.stop()


def _submit_prewarm_tasks():
    """Warm the menu lists that are otherwise paid on first open (readers are
    already built by REGISTRY.build above). Best-effort and off the event loop —
    see prewarm.py."""
    PREWARM.submit("datasets", lambda: datasets.list_datasets(data_roots()))
    if config.cirro_enabled():
        from . import cirro
        PREWARM.submit("cirro.projects", cirro.list_projects)


async def _resource_loop():
    interval = 1.0 / config.RESOURCE_HZ
    relog_every = max(1, int(config.RESOURCE_HZ * 300))  # repeat the warning ~every 5 min
    failing = 0  # consecutive failed ticks; reset to 0 on success
    while True:
        try:
            # Sampling is all syscalls (RSS, statvfs, per-process CPU times), which on a
            # busy host add up to milliseconds — enough to be visible as a periodic hitch
            # in every client's request latency if run inline on the loop. Take it in a
            # worker thread and publish the finished sample.
            sample = await _in_executor(deps._mgr().resource_sample)
            BUS._publish_inloop("resource.sample", sample)
            failing = 0
        except Exception:
            # Sampling runs every tick; log with a traceback the first time it
            # starts failing and then only periodically, so a persistent failure
            # (which leaves the resource strip stuck on "waiting…") stays visible
            # in the logs instead of scrolling past as a single line.
            if failing % relog_every == 0:
                _log.warning("resource sampling failed; retrying each tick", exc_info=True)
            failing += 1
        await asyncio.sleep(interval)


# The app-wide `bind_client_id` dependency binds the calling browser client's
# identity (X-SDS-Client-Id) for every request, which is what the edit-lock guard in
# deps reads. Registered here rather than per route so no handler can forget it.
app = FastAPI(title="Spatial Data Studio", lifespan=lifespan,
              dependencies=[Depends(bind_client_id)])
app.add_middleware(SelectiveGZipMiddleware)

# Self-contained route domains live in routers/ (imports above); the rest — sessions,
# jobs, staging, plots, displays, subset/save, shape annotations, the data path, and
# SSE — stay here where they share the session/job wiring. Shared helpers (_session,
# _read_locked, _render_image, …) live in deps.py so both sides use one copy.
app.include_router(imaging_router.router)
app.include_router(cirro_router.router)
app.include_router(snapshots_router.router)
app.include_router(recipes_router.router)


# ---- health ----------------------------------------------------------------
@app.get("/api/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/api/readyz")
async def readyz():
    if not _READY:
        raise HTTPException(503, "building registry")
    return {"status": "ready", "functions": len(REGISTRY.entries)}


# ---- registry --------------------------------------------------------------
@app.get("/api/functions")
async def functions():
    return REGISTRY.public()


@app.get("/api/functions/coverage")
async def coverage():
    """Parameter-term coverage report (spec §1.9): unmatched params ranked by reuse."""
    return REGISTRY.coverage


# ---- sessions --------------------------------------------------------------
@app.get("/api/sessions")
async def sessions():
    return {"sessions": _mgr().list_summaries()}


@app.post("/api/sessions")
async def create_session(body: dict):
    source = body.get("source", {})
    name = body.get("name")
    # `load_id` is a client-minted nonce the New Session dialog subscribes to on the
    # SSE bus: the checkpoint load runs on the session's worker (Session._run_load), so
    # its `session.loading` progress + terminal (done/hash_check) events are routed by
    # this nonce. Absent for older clients, in which case the load emits nothing.
    load_id = body.get("load_id")

    try:
        if source.get("kind") == "load":
            sess = await _in_executor(_mgr().create_from_load, source["path"], name, load_id)
        elif source.get("kind") == "read":
            # squidpy `read` namespace or spatialdata-io readers (namespace `io`)
            sess = _mgr().create_from_read(
                {"namespace": source.get("namespace", "read"), "function": source["function"],
                 "params": source.get("params", {})}, name)
        else:
            raise HTTPException(400, "source.kind must be 'load' or 'read'")
    except (RuntimeError, FileNotFoundError, KeyError) as e:
        raise HTTPException(400, str(e))
    # `hash_check` now rides the terminal `session.loading` event, since the checkpoint
    # load runs asynchronously (Session._run_load) — the shell returned here always has
    # it None. Kept in the response shape for the read / older-client paths.
    return {**_mgr().summary(sess), "hash_check": sess.hash_check}


# ---- filesystem browse (for the New Session path typeahead) ----------------
@app.get("/api/fs/browse")
async def fs_browse(path: str | None = None, include_files: bool = False):
    """Navigate the raw-input data mount (DATA_DIR only) for the New Session
    import flow — never the checkpoint mount or the whole filesystem. A
    `.zarr`/`.zarr.zip` entry is a loadable dataset; other directories are
    navigable. With `include_files` (raw-data import, where the reader's input
    may be any file type), regular files are listed too."""
    roots = data_roots()
    if not path:
        return {"path": "", "parent": None,
                "entries": [{"name": str(r), "path": str(r), "kind": "dir"} for r in roots]}
    try:
        target = Path(path).resolve()
    except OSError:
        raise HTTPException(400, "bad path")
    if not within_data_dir(target):
        raise HTTPException(403, "path is outside the data directory")
    if not target.is_dir():
        raise HTTPException(404, "not a directory")

    def _list():
        out = []
        for child in sorted(target.iterdir(), key=lambda c: c.name.lower()):
            if child.name.startswith("."):
                continue
            if child.name.endswith((".zarr", ".zarr.zip", ".zarr.tar.gz", ".zarr.tgz")):
                out.append({"name": child.name, "path": str(child), "kind": "dataset"})
            elif child.is_dir():
                out.append({"name": child.name, "path": str(child), "kind": "dir"})
            elif include_files:
                out.append({"name": child.name, "path": str(child), "kind": "file"})
        return out

    try:
        entries = await _in_executor(_list)
    except OSError as e:
        raise HTTPException(400, str(e))
    parent = None if target in roots else str(target.parent)
    return {"path": str(target), "parent": parent, "entries": entries}


@app.get("/api/fs/datasets")
async def fs_datasets():
    """Every saved checkpoint (`.sdata.zarr.zip`) found by scanning DATA_DIR — the
    New Session load picker and the Cirro upload session picker show these on click,
    no typing needed. Served from the prewarmed cache (datasets.py); rescanned only
    after a save invalidates it."""
    found = await _in_executor(datasets.list_datasets, data_roots())
    return {"datasets": found}


@app.get("/api/sessions/{sid}")
async def session_state(sid: str):
    sess = _session(sid)
    return await _read_locked(sess, _mgr().state, sess)


@app.get("/api/sessions/{sid}/obs/{column}/values")
async def obs_values(sid: str, column: str):
    """Unique values (+counts) of a categorical obs column, for the Edit
    Annotations widget."""
    sess = _session(sid)

    def _values():
        obs = sess.active_table().obs
        if column not in obs.columns:
            raise KeyError(column)
        counts = obs[column].astype(str).value_counts()
        return [{"value": str(v), "count": int(n)} for v, n in counts.items()]

    try:
        values = await _read_locked(sess, _values)
    except (KeyError, RuntimeError) as e:
        raise HTTPException(404, str(e))
    return {"column": column, "values": values}


@app.delete("/api/sessions/{sid}")
async def close_session(sid: str, body: dict | None = None):
    save = bool((body or {}).get("save"))
    if save:
        _writable_session(sid)  # closing read-only is fine; overwriting its checkpoint is not
    else:
        _claim_lock(sid)  # ...but never close a session another viewer holds the lock on
    await _in_executor(_mgr().close, sid, save)
    return {"ok": True}


# ---- viewer presence + the per-session edit lock (DESIGN §16.5) -------------
@app.post("/api/presence")
async def presence_heartbeat(body: dict):
    """Heartbeat from one browser client: its client-minted id, its display name, and
    the session it is looking at (null when none). Doubles as the rename call (the name
    simply arrives changed) and as the client's initial fetch — the response is the same
    view the `presence.updated` SSE event carries. Attaching to an unlocked session takes
    that session's lock; see sessions/presence.py for the full rules."""
    client_id = str(body.get("client_id") or "").strip()
    if not client_id:
        raise HTTPException(400, "client_id is required")
    session_id = body.get("session_id")
    if session_id is not None and _mgr().get(session_id) is None:
        session_id = None  # the client is still showing a session that has since closed
    return PRESENCE.heartbeat(client_id, clean_name(body.get("name"), client_id), session_id)


def _client_id_or_400() -> str:
    client_id = CLIENT_ID.get()
    if not client_id:
        raise HTTPException(400, "X-SDS-Client-Id header is required to hold a lock")
    return client_id


@app.post("/api/sessions/{sid}/lock")
async def take_lock(sid: str):
    """Take an unlocked session's edit lock. 409 while another viewer holds it — the
    holder has to release it first (that is the whole point of the lock)."""
    _session(sid)
    holder = PRESENCE.claim(sid, _client_id_or_400())
    if holder is not None:
        raise HTTPException(409, f"session is locked by {holder.name}")
    return {"ok": True}


@app.delete("/api/sessions/{sid}/lock")
async def release_lock(sid: str):
    """Give up the lock so another viewer can take it. Only the holder may."""
    _session(sid)
    if not PRESENCE.release(sid, _client_id_or_400()):
        raise HTTPException(403, "you do not hold this session's lock")
    return {"ok": True}


# ---- jobs ------------------------------------------------------------------
def _require_known(descriptor: dict):
    if REGISTRY.get(f"{descriptor.get('namespace')}.{descriptor.get('function')}") is None:
        raise HTTPException(400, "unknown function")


@app.post("/api/sessions/{sid}/jobs")
async def enqueue_job(sid: str, descriptor: dict):
    sess = _writable_session(sid)
    _require_known(descriptor)
    job_id = sess.enqueue_descriptor(descriptor)
    return {"job_id": job_id, "status": "queued"}


@app.delete("/api/sessions/{sid}/jobs/{job_id}")
async def cancel_job(sid: str, job_id: str):
    ok = _writable_session(sid).cancel(job_id)
    if not ok:
        raise HTTPException(409, "job not cancellable (running or finished)")
    return {"ok": True}


@app.get("/api/sessions/{sid}/jobs/{job_id}")
async def job_state(sid: str, job_id: str):
    """Poll a job's status. The live frontend learns status over SSE, but "special"
    jobs (save/subset/annotate/cirro_upload/set_transform) have no
    app_state record, so this is the only way a non-SSE client can await them."""
    status = _session(sid).job_status(job_id)
    if status is None:
        raise HTTPException(404, "job not found")
    return {"job_id": job_id, "status": status}


@app.get("/api/sessions/{sid}/jobs/{job_id}/log")
async def job_log(sid: str, job_id: str):
    log, status = _session(sid).get_log(job_id)
    if log is None:
        raise HTTPException(404, "no log")
    return {"log": log, "status": status}


# ---- PENDING staging (spec §5.4) ------------------------------------------
@app.post("/api/sessions/{sid}/jobs/stage")
async def stage_job(sid: str, descriptor: dict):
    _require_known(descriptor)
    return {"step_id": _writable_session(sid).stage_descriptor(descriptor), "status": "pending"}


@app.post("/api/sessions/{sid}/pending/run-all")
async def run_all_pending(sid: str):
    return {"queued": _writable_session(sid).run_all_pending()}


@app.post("/api/sessions/{sid}/pending/{step_id}/run")
async def run_pending(sid: str, step_id: str):
    if not _writable_session(sid).run_pending(step_id):
        raise HTTPException(409, "not a pending step")
    return {"ok": True}


@app.put("/api/sessions/{sid}/pending/{step_id}")
async def edit_pending(sid: str, step_id: str, body: dict):
    if not _writable_session(sid).edit_pending(step_id, body.get("params", {})):
        raise HTTPException(409, "not a pending step")
    return {"ok": True}


@app.delete("/api/sessions/{sid}/history/{entry_id}")
async def delete_history_entry(sid: str, entry_id: str):
    """Delete a compute/plot history entry the user chose to remove (e.g. a kept
    failure, v3 Part 2). Queued/running entries can't be deleted."""
    if not _writable_session(sid).delete_entry(entry_id):
        raise HTTPException(409, "entry not found or still queued/running")
    return {"ok": True}


# ---- plots -----------------------------------------------------------------
@app.post("/api/sessions/{sid}/plots/{plot_id}/redraw")
async def redraw(sid: str, plot_id: str):
    if not _writable_session(sid).redraw_plot(plot_id):
        raise HTTPException(409, "plot not redrawable")
    return {"ok": True}


@app.get("/api/sessions/{sid}/plots/{plot_id}/figure")
async def figure(sid: str, plot_id: str, fmt: str = "svg"):
    figs = _session(sid).plot_figures.get(plot_id)
    if not figs or figs.get(fmt) is None:
        raise HTTPException(404, "figure not drawn")
    media = "image/svg+xml" if fmt == "svg" else "application/pdf"
    return Response(content=figs[fmt], media_type=media)


# ---- displays --------------------------------------------------------------
@app.post("/api/sessions/{sid}/displays")
async def add_display(sid: str, spec: dict):
    spec = _writable_session(sid).add_display(spec)
    BUS.publish("display.updated", {"session_id": sid, "display_id": spec["id"], "spec": spec})
    return spec


@app.put("/api/sessions/{sid}/displays/{display_id}")
async def update_display(sid: str, display_id: str, spec: dict):
    if not _writable_session(sid).update_display(display_id, spec):
        raise HTTPException(404, "display not found")
    BUS.publish("display.updated", {"session_id": sid, "display_id": display_id, "spec": spec})
    return {"ok": True}


# ---- subset / save ---------------------------------------------------------
@app.post("/api/sessions/{sid}/subset")
async def subset(sid: str, body: dict):
    job_id = _writable_session(sid).enqueue_special("subset", body)
    return {"job_id": job_id}


@app.post("/api/sessions/{sid}/annotate")
async def annotate(sid: str, body: dict):
    """Label the cells inside the drawn lasso into a region set (a categorical obs
    column), in place (spec §3.1). Body: {polygons, region_set, category, color?}."""
    job_id = _writable_session(sid).enqueue_special("annotate", body)
    return {"job_id": job_id}


# ---- shape annotations (arrows/lines/boxes/polygons/ellipses) -----------
@app.get("/api/sessions/{sid}/shape-annotations")
async def list_shape_annotations(sid: str):
    sess = _session(sid)

    def _list():
        from .transport import annotations
        return annotations.list_shape_annotations(sess)

    return {"shapes": await _read_locked(sess, _list)}


@app.post("/api/sessions/{sid}/shape-annotations")
async def create_shape_annotation(sid: str, body: dict):
    """Create one shape (spec: shape annotations editor). Body: a ShapeAnnotation
    (geometry/stroke/fill?/label?), persisted into `sdata.shapes["annotations"]`."""
    job_id = _writable_session(sid).enqueue_special("shape_annotate", {"op": "create", "shape": body})
    return {"job_id": job_id}


@app.put("/api/sessions/{sid}/shape-annotations/{shape_id}")
async def update_shape_annotation(sid: str, shape_id: str, body: dict):
    job_id = _writable_session(sid).enqueue_special(
        "shape_annotate", {"op": "update", "shape_id": shape_id, "shape": body})
    return {"job_id": job_id}


@app.delete("/api/sessions/{sid}/shape-annotations/{shape_id}")
async def delete_shape_annotation(sid: str, shape_id: str):
    job_id = _writable_session(sid).enqueue_special("shape_annotate", {"op": "delete", "shape_id": shape_id})
    return {"job_id": job_id}


@app.get("/api/about/licenses")
async def list_third_party_licenses():
    """Third-party libraries in use and their licenses, for the in-app
    Acknowledgements view (v2 Part 9.2)."""
    from . import acknowledgements
    return acknowledgements.catalog()


def _default_save_path(sess) -> str:
    """Checkpoint path to use when the caller doesn't give one explicitly. The
    filename's content-hash suffix is (re)computed from the written bytes on
    every save (see `_save_zip`), so this only needs the checkpoint's clean base
    name - stripping any hash a previous save already appended keeps it from
    stacking a new one on top."""
    from .persistence.store import strip_content_hash, CHECKPOINT_EXT
    return str(config.DATA_DIR / f"{strip_content_hash(sess.name)}{CHECKPOINT_EXT}")


@app.post("/api/sessions/{sid}/save")
async def save(sid: str, body: dict | None = None):
    sess = _writable_session(sid)
    explicit = (body or {}).get("path")
    path = explicit or _default_save_path(sess)
    job_id = sess.enqueue_special("save", {"path": path, "hash_name": not explicit})
    return {"job_id": job_id, "path": path}


# ---- points -> global coordinate transform ---------------------------------
@app.get("/api/sessions/{sid}/points-transform")
async def get_points_transform(sid: str):
    """Current points->global affine (6 floats) of the active table's region element."""
    sess = _session(sid)
    from .sessions import transform

    def _fields():
        return {"affine": transform.get_affine6(sess.sdata, sess.active_table()),
                "element": transform.region_name(sess.active_table())}

    return await _read_locked(sess, _fields)


@app.post("/api/sessions/{sid}/points-transform")
async def set_points_transform(sid: str, body: dict):
    """Set the points->global affine and persist to disk. body: {affine: [a,b,c,d,e,f]}."""
    sess = _writable_session(sid)
    affine = body["affine"]
    if not (isinstance(affine, list) and len(affine) == 6):
        raise HTTPException(400, "affine must be 6 floats [a, b, c, d, e, f]")
    explicit = body.get("path")
    path = explicit or _default_save_path(sess)
    job_id = sess.enqueue_special("set_transform", {"affine": affine, "path": path, "hash_name": not explicit})
    return {"job_id": job_id, "path": path}


# ---- Arrow data path -------------------------------------------------------
@app.get("/api/sessions/{sid}/data/{field_path:path}")
async def data(sid: str, field_path: str):
    sess = _session(sid)

    def _resolve():
        batch = arrow.resolve_field(sess.active_table(), field_path)
        # Canvas cell positions honor the editable points->global transform.
        if field_path == "obsm:spatial":
            from .sessions import transform
            affine6 = transform.get_affine6(sess.sdata, sess.active_table())
            if not transform.is_identity(affine6):
                batch = arrow.apply_affine_xy(batch, affine6)
        return arrow.to_ipc_bytes(batch)

    try:
        payload = await _read_locked(sess, _resolve)
    except (KeyError, ValueError) as e:
        raise HTTPException(404, str(e))
    return Response(content=payload, media_type="application/vnd.apache.arrow.stream")


@app.get("/api/sessions/{sid}/shapes/{element}/geoarrow")
async def shapes_geoarrow(sid: str, element: str, bbox: str, limit: int | None = None):
    """Viewport-clipped boundary polygons of a shapes element as GeoArrow IPC
    (geometry + int32 cell_index), transformed into the coords world space. `bbox`
    is `minx,miny,maxx,maxy` in that world space. 404 if the element is absent or
    not polygonal."""
    sess = _session(sid)
    try:
        parts = [float(x) for x in bbox.split(",")]
    except ValueError:
        raise HTTPException(400, "bbox must be four floats minx,miny,maxx,maxy")
    if len(parts) != 4:
        raise HTTPException(400, "bbox must be four floats minx,miny,maxx,maxy")

    def _build():
        from .transport import geometry
        return geometry.polygons_geoarrow(sess.sdata, sess.active_table(), element, parts, limit)

    try:
        payload = await _read_locked(sess, _build)
    except (KeyError, RuntimeError) as e:
        raise HTTPException(404, str(e))
    return Response(content=payload, media_type="application/vnd.apache.arrow.stream")


@app.get("/api/sessions/{sid}/var-names")
async def var_names(sid: str, q: str = "", limit: int = 50):
    """Search var_names (genes) for the color-by gene picker. adata can carry tens
    of thousands of genes, so match server-side and cap the result; prefix hits rank
    first, then substring hits."""
    sess = _session(sid)

    def _search():
        names = [str(v) for v in sess.active_table().var_names]
        ql = q.strip().lower()
        if not ql:
            return names[:limit]
        starts = [s for s in names if s.lower().startswith(ql)]
        if len(starts) >= limit:
            return starts[:limit]
        contains = [s for s in names if ql in s.lower() and not s.lower().startswith(ql)]
        return (starts + contains)[:limit]

    return {"names": await _read_locked(sess, _search)}


# ---- data inspector: element inventory + dataframe previews ----------------
@app.get("/api/sessions/{sid}/elements")
async def elements(sid: str):
    sess = _session(sid)

    def _build():
        return tables.describe_elements(sess.active_table(), sess.sdata, sess.active_table_key)

    return await _read_locked(sess, _build)


@app.get("/api/sessions/{sid}/table")
async def table_preview(sid: str, path: str, offset: int = 0, limit: int = 50):
    sess = _session(sid)
    offset = max(0, offset)
    limit = max(1, min(limit, 200))

    def _build():
        return tables.table_preview(sess.active_table(), sess.sdata, path, offset, limit)

    try:
        return await _read_locked(sess, _build)
    except (KeyError, ValueError) as e:
        raise HTTPException(404, str(e))


# ---- SSE -------------------------------------------------------------------
@app.get("/api/events")
async def events(request: Request):
    last = request.headers.get("Last-Event-ID")
    last_id = int(last) if last and last.isdigit() else None

    async def gen():
        async for chunk in BUS.subscribe(last_id):
            if await request.is_disconnected():
                break
            yield chunk

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/events/poll")
async def events_poll(after: int | None = None):
    """JSON polling fallback for clients behind a proxy that rejects or buffers the
    SSE stream (e.g. a gateway that only content-negotiates application/json). Returns
    the same events off the in-memory ring; the client replays them through the same
    handlers as SSE, seeding its cursor from `last_id`. Lock-free: reads the event
    ring, never a session lock, so it stays responsive while a compute job runs."""
    last_id, events = BUS.events_since(after)
    return {"last_id": last_id, "events": events}


# The backend exposes no WebSocket endpoints — live updates use SSE (/api/events).
# Dev proxies and browsers still send stray ws upgrades; without a ws route they
# fall through to the StaticFiles mounts below, which assert http scope and raise
# an unhandled 500 per connection. Registered before the mounts so it wins scope
# matching; closing before accept denies the handshake with no traceback.
@app.websocket("/{_path:path}")
async def reject_websocket(websocket: WebSocket, _path: str):
    await websocket.close(code=1000)


# Snapshot figure artifacts (`*.figure.pdf/.png/.thumb.png` + the `.figure.json`
# sidecar) and `*.zarr.zip` checkpoints are served by the name-validated
# GET /snapshots/{name}/* and GET /checkpoints/{name} routes above, not a static
# mount — DATA_DIR also holds raw datasets that must not be wholesale-exposed.

# ---- static SPA (optional; served by edge in prod) -------------------------
if config.STATIC_DIR and config.STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="spa")
