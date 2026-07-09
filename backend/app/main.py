import asyncio
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import config, data_roots, checkpoint_roots, within_data_dir, within_checkpoint_dir
from .registry.introspect import REGISTRY
from .sessions.manager import SessionManager
from .transport.sse import BUS
from .transport import arrow
from .transport import tables
from . import imaging

MANAGER: SessionManager | None = None
_READY = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    global MANAGER, _READY
    REGISTRY.build()
    MANAGER = SessionManager(REGISTRY)
    BUS.bind_loop(asyncio.get_running_loop())
    _READY = True
    sampler = asyncio.create_task(_resource_loop())
    try:
        yield
    finally:
        sampler.cancel()


async def _resource_loop():
    interval = 1.0 / config.RESOURCE_HZ
    while True:
        try:
            BUS._publish_inloop("resource.sample", MANAGER.resource_sample())
        except Exception:
            pass
        await asyncio.sleep(interval)


app = FastAPI(title="Spatial Data Studio", lifespan=lifespan)


def _mgr() -> SessionManager:
    if MANAGER is None:
        raise HTTPException(503, "not ready")
    return MANAGER


def _session(sid: str):
    s = _mgr().get(sid)
    if s is None:
        raise HTTPException(404, "session not found")
    return s


async def _in_executor(fn, *a):
    return await asyncio.get_running_loop().run_in_executor(None, fn, *a)


async def _read_locked(sess, fn, *a):
    """Run `fn(*a)` in the executor under the session's read lock — the shape
    every read-only endpoint below needs to serve a field/manifest/preview off a
    session that a queued job may be mutating concurrently."""
    def _run():
        with sess.lock.reading():
            return fn(*a)
    return await _in_executor(_run)


# Global cap on concurrent image compositing. deck.gl fires a burst of tile
# requests on every zoom/pan, and each finest-level tile can realize a full
# multi-MB pyramid chunk; without this a burst decodes them all at once and spikes
# memory. Shared across sessions since RAM is a process-wide resource.
_IMAGE_RENDER_SEM = asyncio.Semaphore(config.IMAGE_RENDER_CONCURRENCY)


async def _render_image(sess, fn):
    """Composite a tile/thumbnail under the render semaphore, refusing once RSS is
    past the admission boundary so a zoom burst can't push an already-loaded
    container into OOM. 503 lets the frontend keep its coarse base layer and retry
    as memory frees (BitmapLayer just re-requests on the next viewport change)."""
    async with _IMAGE_RENDER_SEM:
        if _mgr().over_memory_boundary():
            raise HTTPException(503, "image render deferred: memory boundary reached")
        return await _read_locked(sess, fn)


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
    try:
        if source.get("kind") == "load":
            sess = await _in_executor(_mgr().create_from_load, source["path"], name)
        elif source.get("kind") == "read":
            # squidpy `read` namespace or spatialdata-io readers (namespace `io`)
            sess = _mgr().create_from_read(
                {"namespace": source.get("namespace", "read"), "function": source["function"],
                 "params": source.get("params", {})}, name)
        else:
            raise HTTPException(400, "source.kind must be 'load' or 'read'")
    except (RuntimeError, FileNotFoundError, KeyError) as e:
        raise HTTPException(400, str(e))
    return _mgr().summary(sess)


# ---- filesystem browse (for the New Session path typeahead) ----------------
# Dirs never worth walking for datasets (vendored/build/staging; `_`-prefixed dirs
# like a reader's raw-bundle staging folder are skipped so their internal zarrs
# don't surface as loadable sessions).
_SKIP_SCAN_DIRS = {".git", "node_modules", "__pycache__", "venv", ".cache", "dist", "build"}
_DATASET_MAX_DEPTH = 4
_DATASET_CAP = 1000


def _looks_like_sdata_zarr(p: Path) -> bool:
    if p.name.endswith(".zarr.zip"):
        return True  # a saved session / prepared bundle; can't cheaply peek inside
    # A SpatialData .zarr directory holds element groups; a bare/foreign zarr does not.
    return any((p / g).is_dir() for g in ("tables", "images", "shapes", "points", "labels"))


def _find_datasets(roots: list[Path]) -> list[dict]:
    """Recursively find loadable SpatialData datasets under the roots (flat list)."""
    import os

    def rel(p: Path) -> str:
        for r in roots:
            try:
                return str(p.relative_to(r))
            except ValueError:
                continue
        return str(p)

    found: dict[str, dict] = {}
    for root in roots:
        base = len(root.parts)
        for dirpath, dirnames, filenames in os.walk(root):
            here = Path(dirpath)
            if len(here.parts) - base >= _DATASET_MAX_DEPTH:
                dirnames[:] = []
            keep = []
            for name in sorted(dirnames, key=str.lower):
                # `.rasters` dirs are the app's own transient tile-cache stores under
                # the checkpoint mount (rasters.normalize_rasters) — internal working
                # data, never a loadable checkpoint.
                if name.startswith((".", "_")) or name in _SKIP_SCAN_DIRS or name.endswith(".rasters"):
                    continue
                full = here / name
                if name.endswith(".zarr"):
                    if not _looks_like_sdata_zarr(full):
                        continue  # never descend into a .zarr's internals
                    found.setdefault(str(full.resolve()),
                                     {"name": rel(full), "path": str(full), "mtime": _mtime(full)})
                    continue
                keep.append(name)
            dirnames[:] = keep
            for name in filenames:
                if name.endswith(".zarr.zip"):
                    full = here / name
                    found.setdefault(str(full.resolve()),
                                     {"name": rel(full), "path": str(full), "mtime": _mtime(full)})
            if len(found) >= _DATASET_CAP:
                break
    # Newest first: saved sessions the user just wrote surface at the top.
    return sorted(found.values(), key=lambda e: e["mtime"], reverse=True)


def _mtime(p: Path) -> float:
    import os
    try:
        return os.path.getmtime(p)
    except OSError:
        return 0.0


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
            if child.name.endswith((".zarr", ".zarr.zip")):
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
    """Every saved session found by scanning the checkpoint mount (CHECKPOINT_DIR
    only) — the New Session load picker and the Cirro upload session picker show
    these on click, no typing needed."""
    datasets = await _in_executor(_find_datasets, checkpoint_roots())
    return {"datasets": datasets}


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
    await _in_executor(_mgr().close, sid, save)
    return {"ok": True}


# ---- jobs ------------------------------------------------------------------
def _require_known(descriptor: dict):
    if REGISTRY.get(f"{descriptor.get('namespace')}.{descriptor.get('function')}") is None:
        raise HTTPException(400, "unknown function")


@app.post("/api/sessions/{sid}/jobs")
async def enqueue_job(sid: str, descriptor: dict):
    sess = _session(sid)
    _require_known(descriptor)
    job_id = sess.enqueue_descriptor(descriptor)
    return {"job_id": job_id, "status": "queued"}


@app.delete("/api/sessions/{sid}/jobs/{job_id}")
async def cancel_job(sid: str, job_id: str):
    ok = _session(sid).cancel(job_id)
    if not ok:
        raise HTTPException(409, "job not cancellable (running or finished)")
    return {"ok": True}


@app.get("/api/sessions/{sid}/jobs/{job_id}")
async def job_state(sid: str, job_id: str):
    """Poll a job's status. The live frontend learns status over SSE, but "special"
    jobs (save/subset/annotate/promote/cirro_upload/set_transform) have no
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
    return {"step_id": _session(sid).stage_descriptor(descriptor), "status": "pending"}


@app.post("/api/sessions/{sid}/pending/run-all")
async def run_all_pending(sid: str):
    return {"queued": _session(sid).run_all_pending()}


@app.post("/api/sessions/{sid}/pending/{step_id}/run")
async def run_pending(sid: str, step_id: str):
    if not _session(sid).run_pending(step_id):
        raise HTTPException(409, "not a pending step")
    return {"ok": True}


@app.put("/api/sessions/{sid}/pending/{step_id}")
async def edit_pending(sid: str, step_id: str, body: dict):
    if not _session(sid).edit_pending(step_id, body.get("params", {})):
        raise HTTPException(409, "not a pending step")
    return {"ok": True}


@app.delete("/api/sessions/{sid}/history/{entry_id}")
async def delete_history_entry(sid: str, entry_id: str):
    """Delete a compute/plot history entry the user chose to remove (e.g. a kept
    failure, v3 Part 2). Queued/running entries can't be deleted."""
    if not _session(sid).delete_entry(entry_id):
        raise HTTPException(409, "entry not found or still queued/running")
    return {"ok": True}


# ---- plots -----------------------------------------------------------------
@app.post("/api/sessions/{sid}/plots/{plot_id}/redraw")
async def redraw(sid: str, plot_id: str):
    if not _session(sid).redraw_plot(plot_id):
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
    sess = _session(sid)
    spec["id"] = str(uuid.uuid4())
    with sess.lock.writing():
        sess.app_state["displays"].append(spec)
    BUS.publish("display.updated", {"session_id": sid, "display_id": spec["id"], "spec": spec})
    return spec


@app.put("/api/sessions/{sid}/displays/{display_id}")
async def update_display(sid: str, display_id: str, spec: dict):
    sess = _session(sid)
    with sess.lock.writing():
        for i, d in enumerate(sess.app_state["displays"]):
            if d["id"] == display_id:
                spec["id"] = display_id
                sess.app_state["displays"][i] = spec
                found = True
                break
        else:
            found = False
    if not found:
        raise HTTPException(404, "display not found")
    BUS.publish("display.updated", {"session_id": sid, "display_id": display_id, "spec": spec})
    return {"ok": True}


# ---- subset / save ---------------------------------------------------------
@app.post("/api/sessions/{sid}/subset")
async def subset(sid: str, body: dict):
    job_id = _session(sid).enqueue_special("subset", body)
    return {"job_id": job_id}


@app.post("/api/sessions/{sid}/annotate")
async def annotate(sid: str, body: dict):
    """Label the cells inside the drawn lasso into a region set (a categorical obs
    column), in place (spec §3.1). Body: {polygons, region_set, category, color?}."""
    job_id = _session(sid).enqueue_special("annotate", body)
    return {"job_id": job_id}


@app.post("/api/sessions/{sid}/regions/promote")
async def promote_region(sid: str, body: dict):
    """Promote an existing obs categorical to a region set (spec §3.2). Body: {obs_column}."""
    job_id = _session(sid).enqueue_special("annotate", {"op": "promote", "obs_column": body["obs_column"]})
    return {"job_id": job_id}


@app.post("/api/sessions/{sid}/snapshot")
async def save_snapshot_endpoint(sid: str, body: dict | None = None):
    """Save a display as a JSON snapshot config pointing at an (auto-saved,
    content-hashed) checkpoint the browser viewer reads directly. body:
    {label?, viewport?: {target, zoom}, display_id?}."""
    sess = _session(sid)
    from . import snapshots
    b = body or {}
    result = await _in_executor(snapshots.save_snapshot, sess, b.get("label"),
                                b.get("viewport"), b.get("display_id"))
    if result.get("status") == "failed":
        raise HTTPException(400, result.get("error", "snapshot failed"))
    return result


@app.get("/api/snapshots")
async def list_snapshots_endpoint():
    from . import snapshots
    return {"snapshots": snapshots.list_snapshots()}


@app.api_route("/api/checkpoints/{name}", methods=["GET", "HEAD"])
async def get_checkpoint(name: str):
    """Serve a saved checkpoint `.zarr.zip` for direct browser reads (zarrita.js
    over HTTP range). FileResponse honors Range (206) and HEAD (zarrita probes the
    size before range-reading). Scoped to `*.zarr.zip` inside CHECKPOINT_DIR so the
    transient `.rasters` caches and the snapshots dir that also live under that
    mount are never exposed."""
    if not name.endswith(".zarr.zip") or "/" in name or "\\" in name:
        raise HTTPException(404, "not found")
    target = (config.CHECKPOINT_DIR / name).resolve()
    if not within_checkpoint_dir(target) or not target.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(str(target), media_type="application/zip")


@app.get("/api/about/licenses")
async def list_third_party_licenses():
    """Third-party libraries in use and their licenses, for the in-app
    Acknowledgements view (v2 Part 9.2)."""
    from . import acknowledgements
    return acknowledgements.catalog()


# ---- Cirro upload (service-account auth; dark unless configured) ----------
@app.get("/api/cirro/status")
async def cirro_status():
    return {"enabled": config.cirro_enabled()}


@app.get("/api/cirro/projects")
async def cirro_projects():
    if not config.cirro_enabled():
        raise HTTPException(503, "Cirro is not configured")
    from . import cirro
    return {"projects": cirro.list_projects()}


@app.get("/api/cirro/projects/{project_id}/folders")
async def cirro_folders(project_id: str, refresh: bool = False):
    if not config.cirro_enabled():
        raise HTTPException(503, "Cirro is not configured")
    from . import cirro
    return {"folders": cirro.list_folders(project_id, force_refresh=refresh)}


# ---- Cirro upload queue. Uploads run in the background with a small concurrency
# cap so several large uploads don't all realize at once; anything over the cap
# waits (pending). The uploading/pending counts are broadcast over SSE
# (cirro.upload.state) and also served by GET so a fresh page can render the
# in-progress indicator without waiting for the next state change. ----
_UPLOAD_CONCURRENCY = 2
_upload_sem: asyncio.Semaphore | None = None
_uploads_active = 0    # currently uploading
_uploads_pending = 0   # queued behind the concurrency cap


def _publish_upload_state():
    BUS.publish("cirro.upload.state", {"uploading": _uploads_active, "pending": _uploads_pending})


@app.get("/api/cirro/uploads")
async def cirro_uploads():
    return {"uploading": _uploads_active, "pending": _uploads_pending}


@app.post("/api/cirro/upload")
async def cirro_upload(body: dict):
    """Upload user-selected saved checkpoint sessions + snapshots to Cirro as one
    dataset, decoupled from any live session. Runs in the background (uploads can
    be large) and announces completion/failure over SSE — cirro.upload.completed /
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
        if not within_checkpoint_dir(target) or not target.exists():
            raise HTTPException(400, f"not a saved checkpoint session: {p}")
        resolved.append(str(target))
    asyncio.create_task(_run_cirro_upload(
        body["project_id"], body["dataset_name"], resolved, snapshot_names, body.get("folder") or None))
    return {"status": "started"}


async def _run_cirro_upload(project_id, dataset_name, session_paths, snapshot_names, folder):
    from . import cirro
    global _upload_sem, _uploads_active, _uploads_pending
    if _upload_sem is None:
        _upload_sem = asyncio.Semaphore(_UPLOAD_CONCURRENCY)  # bind to the running loop

    def _do():
        return cirro.upload_selection(project_id=project_id, dataset_name=dataset_name,
                                      session_paths=session_paths, snapshot_names=snapshot_names,
                                      folder=folder)
    _uploads_pending += 1
    _publish_upload_state()
    async with _upload_sem:
        _uploads_pending -= 1
        _uploads_active += 1
        _publish_upload_state()
        try:
            result = await _in_executor(_do)
            BUS.publish("cirro.upload.completed", {"dataset_name": result["dataset_name"]})
        except Exception as e:
            BUS.publish("cirro.upload.failed", {"error": str(e), "dataset_name": dataset_name})
        finally:
            _uploads_active -= 1
            _publish_upload_state()


def _default_save_path(sess) -> str:
    """Checkpoint path to use when the caller doesn't give one explicitly. The
    filename's content-hash suffix is (re)computed from the written bytes on
    every save (see `_save_zip`), so this only needs the checkpoint's clean base
    name - stripping any hash a previous save already appended keeps it from
    stacking a new one on top."""
    from .persistence.store import strip_content_hash
    return str(config.CHECKPOINT_DIR / f"{strip_content_hash(sess.name)}.zarr.zip")


@app.post("/api/sessions/{sid}/save")
async def save(sid: str, body: dict | None = None):
    sess = _session(sid)
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
    sess = _session(sid)
    affine = body["affine"]
    if not (isinstance(affine, list) and len(affine) == 6):
        raise HTTPException(400, "affine must be 6 floats [a, b, c, d, e, f]")
    explicit = body.get("path")
    path = explicit or _default_save_path(sess)
    job_id = sess.enqueue_special("set_transform", {"affine": affine, "path": path, "hash_name": not explicit})
    return {"job_id": job_id, "path": path}


# ---- recipes (DESIGN §10) --------------------------------------------------
@app.get("/api/recipes")
async def list_bundled_recipes():
    """Curated analysis recipes shipped with the app (run via /recipe/run)."""
    from . import recipes
    return {"recipes": recipes.catalog()}


@app.get("/api/sessions/{sid}/recipe")
async def export_recipe(sid: str):
    sess = _session(sid)
    steps = [{"namespace": r["namespace"], "function": r["function"], "params": r["params"]}
             for r in sess.app_state["compute_history"] if r["status"] == "completed"]
    return {"squidpy_version": REGISTRY.squidpy_version, "steps": steps}


@app.post("/api/sessions/{sid}/recipe/run")
async def run_recipe(sid: str, recipe: dict):
    """Import a recipe: run now (queue all steps) or stage as PENDING (spec §5.3)."""
    from . import recipes
    sess = _session(sid)
    mode = recipe.get("mode") or "run"
    n = recipes.run_steps(sess, recipe.get("steps", []), mode)
    return {"staged" if mode == "stage" else "queued": n}


def _preflight(recipe: dict) -> dict:
    """Required pre-existing keys = referenced keys − keys produced by role:output
    params (spec §5.8, using the term dictionary's output terms §1.6). Also validates
    each step's function exists in the installed registry (§5.2)."""
    produced: set[str] = set()
    referenced, unknown = [], []
    _REF_SLOTS = ("obs", "obs_categorical", "obs_numeric", "obsp", "obsm", "layers")
    for step in recipe.get("steps", []):
        e = REGISTRY.get(f"{step['namespace']}.{step['function']}")
        if e is None:
            unknown.append(f"{step['namespace']}.{step['function']}")
            continue
        by_name = {p.name: p for p in e.params}
        for name, val in step.get("params", {}).items():
            spec = by_name.get(name)
            if spec is None:
                continue
            vals = [v for v in (val if isinstance(val, list) else [val]) if isinstance(v, str) and v]
            if spec.role == "output":
                produced.update(vals)
            elif spec.bound_to in _REF_SLOTS:
                for v in vals:
                    referenced.append({"step": step["function"], "param": name,
                                       "ref": v, "bound_to": spec.bound_to})
    unresolved = [r for r in referenced if r["ref"] not in produced]
    return {"produced": sorted(produced), "unresolved": unresolved, "unknown_functions": unknown}


@app.post("/api/sessions/{sid}/recipe/preflight")
async def preflight_recipe(sid: str, recipe: dict):
    _session(sid)
    return _preflight(recipe)


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
                batch = arrow.apply_affine_xy(batch, transform.matrix3x3(affine6))
        return arrow.to_ipc_bytes(batch)

    try:
        payload = await _read_locked(sess, _resolve)
    except (KeyError, ValueError) as e:
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


# ---- image tiles -----------------------------------------------------------
@app.get("/api/sessions/{sid}/image/{element}/info")
async def image_info(sid: str, element: str):
    sess = _session(sid)

    def _info():
        table = sess.active_table() if sess.active_table_key else None
        return imaging.image_info(sess.sdata, element, table)

    try:
        return await _read_locked(sess, _info)
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.get("/api/sessions/{sid}/image/{element}/thumbnail")
async def image_thumbnail(sid: str, element: str, max_px: int = 2048, channels: str | None = None):
    sess = _session(sid)
    channel_colors = imaging.parse_channel_colors(channels)

    def _render():
        return imaging.thumbnail_png(sess.sdata, element, max_px, channel_colors)

    try:
        png = await _render_image(sess, _render)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/sessions/{sid}/image/{element}/tile/{level}/{col}/{row}")
async def image_tile(sid: str, element: str, level: int, col: int, row: int,
                     channels: str | None = None):
    sess = _session(sid)
    channel_colors = imaging.parse_channel_colors(channels)

    def _render():
        return imaging.tile_png(sess.sdata, element, level, col, row, channel_colors)

    try:
        png = await _render_image(sess, _render)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


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


# ---- snapshots (read-only JSON configs; the browser viewer reads the referenced
# checkpoint directly via /api/checkpoints) ----------------------------------
try:
    config.SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/snapshots", StaticFiles(directory=str(config.SNAPSHOTS_DIR)), name="snapshots")
except OSError:
    pass  # read-only mount; the save endpoint surfaces the error per-call

# ---- static SPA (optional; served by edge in prod) -------------------------
if config.STATIC_DIR and config.STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="spa")
