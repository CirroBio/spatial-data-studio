import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from .config import config
from .registry.introspect import REGISTRY
from .sessions.manager import SessionManager
from .transport.sse import BUS
from .transport import arrow
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


app = FastAPI(title="squidpy-viewer", lifespan=lifespan)


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


@app.get("/api/functions/{key}")
async def function(key: str):
    e = REGISTRY.get(key)
    if e is None:
        raise HTTPException(404, "unknown function")
    return e.to_public()


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
            sess = _mgr().create_from_read(
                {"namespace": "read", "function": source["function"], "params": source.get("params", {})}, name)
        else:
            raise HTTPException(400, "source.kind must be 'load' or 'read'")
    except (RuntimeError, FileNotFoundError, KeyError) as e:
        raise HTTPException(400, str(e))
    return _mgr().summary(sess)


# ---- filesystem browse (for the New Session path typeahead) ----------------
def _browse_roots() -> list[Path]:
    seen, roots = set(), []
    for p in (config.DATA_DIR, config.CHECKPOINT_DIR):
        try:
            rp = p.resolve()
        except OSError:
            continue
        if rp.exists() and rp.is_dir() and rp not in seen:
            seen.add(rp)
            roots.append(rp)
    return roots


def _within_roots(target: Path, roots: list[Path]) -> bool:
    return any(target == r or r in target.parents for r in roots)


@app.get("/api/fs/browse")
async def fs_browse(path: str | None = None):
    """List datasets and subfolders under the configured data roots, for the
    New Session path picker. Scoped to DATA_DIR / CHECKPOINT_DIR — never the
    whole filesystem. A `.zarr`/`.zarr.zip` entry is a loadable dataset; other
    directories are navigable."""
    roots = _browse_roots()
    if not path:
        return {"path": "", "parent": None,
                "entries": [{"name": str(r), "path": str(r), "kind": "dir"} for r in roots]}
    try:
        target = Path(path).resolve()
    except OSError:
        raise HTTPException(400, "bad path")
    if not _within_roots(target, roots):
        raise HTTPException(403, "path is outside the allowed data roots")
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
        return out

    try:
        entries = await _in_executor(_list)
    except OSError as e:
        raise HTTPException(400, str(e))
    parent = None if target in roots else str(target.parent)
    return {"path": str(target), "parent": parent, "entries": entries}


@app.get("/api/sessions/{sid}")
async def session_state(sid: str):
    return _mgr().state(_session(sid))


@app.delete("/api/sessions/{sid}")
async def close_session(sid: str, body: dict | None = None):
    save = bool((body or {}).get("save"))
    await _in_executor(_mgr().close, sid, save)
    return {"ok": True}


# ---- jobs ------------------------------------------------------------------
@app.post("/api/sessions/{sid}/jobs")
async def enqueue_job(sid: str, descriptor: dict):
    sess = _session(sid)
    if descriptor.get("namespace") not in ("gr", "im", "tl", "read", "pl"):
        raise HTTPException(400, "bad namespace")
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
    import uuid
    sess = _session(sid)
    spec["id"] = spec.get("id") or str(uuid.uuid4())
    sess.app_state["displays"].append(spec)
    BUS.publish("display.updated", {"session_id": sid, "display_id": spec["id"], "spec": spec})
    return spec


@app.put("/api/sessions/{sid}/displays/{display_id}")
async def update_display(sid: str, display_id: str, spec: dict):
    sess = _session(sid)
    for i, d in enumerate(sess.app_state["displays"]):
        if d["id"] == display_id:
            spec["id"] = display_id
            sess.app_state["displays"][i] = spec
            BUS.publish("display.updated", {"session_id": sid, "display_id": display_id, "spec": spec})
            return {"ok": True}
    raise HTTPException(404, "display not found")


# ---- subset / save ---------------------------------------------------------
@app.post("/api/sessions/{sid}/subset")
async def subset(sid: str, body: dict):
    job_id = _session(sid).enqueue_special("subset", body)
    return {"job_id": job_id}


@app.post("/api/sessions/{sid}/save")
async def save(sid: str, body: dict | None = None):
    sess = _session(sid)
    path = (body or {}).get("path")
    if not path:
        path = str(config.CHECKPOINT_DIR / f"{sess.name}-{sid[:8]}.zarr.zip")
    job_id = sess.enqueue_special("save", {"path": path})
    return {"job_id": job_id, "path": path}


# ---- recipes (DESIGN §10) --------------------------------------------------
@app.get("/api/sessions/{sid}/recipe")
async def export_recipe(sid: str):
    sess = _session(sid)
    steps = [{"namespace": r["namespace"], "function": r["function"], "params": r["params"]}
             for r in sess.app_state["compute_history"] if r["status"] == "completed"]
    return {"squidpy_version": REGISTRY.squidpy_version, "steps": steps}


@app.post("/api/sessions/{sid}/recipe/run")
async def run_recipe(sid: str, recipe: dict):
    sess = _session(sid)
    n = 0
    for step in recipe.get("steps", []):
        sess.enqueue_descriptor(step)
        n += 1
    return {"queued": n}


@app.post("/api/sessions/{sid}/recipe/preflight")
async def preflight_recipe(sid: str, recipe: dict):
    """Statically flag references nothing in the recipe will create (DESIGN §10)."""
    produced = set()
    unresolved = []
    for step in recipe.get("steps", []):
        e = REGISTRY.get(f"{step['namespace']}.{step['function']}")
        for name, val in step.get("params", {}).items():
            spec = next((p for p in (e.params if e else []) if p.name == name), None)
            if spec and spec.bound_to in ("obs", "obs_categorical", "obsp", "obsm", "layers"):
                for v in (val if isinstance(val, list) else [val]):
                    if isinstance(v, str) and v not in produced:
                        unresolved.append({"step": step["function"], "param": name, "ref": v})
        # crude: outputs are key_added-style; record any string values as potentially produced
        produced.update(str(v) for v in step.get("params", {}).values() if isinstance(v, str))
    return {"unresolved": unresolved}


# ---- Arrow data path -------------------------------------------------------
@app.get("/api/sessions/{sid}/data/{field_path:path}")
async def data(sid: str, field_path: str):
    sess = _session(sid)

    def _resolve():
        sess.lock.acquire_read()
        try:
            batch = arrow.resolve_field(sess.active_table(), field_path)
            return arrow.to_ipc_bytes(batch)
        finally:
            sess.lock.release_read()

    try:
        payload = await _in_executor(_resolve)
    except (KeyError, ValueError) as e:
        raise HTTPException(404, str(e))
    return Response(content=payload, media_type="application/vnd.apache.arrow.stream")


# ---- image tiles -----------------------------------------------------------
@app.get("/api/sessions/{sid}/image/{element}/info")
async def image_info(sid: str, element: str):
    sess = _session(sid)
    try:
        return await _in_executor(imaging.image_info, sess.sdata, element)
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.get("/api/sessions/{sid}/image/{element}/thumbnail")
async def image_thumbnail(sid: str, element: str, max_px: int = 2048):
    sess = _session(sid)

    def _render():
        sess.lock.acquire_read()
        try:
            return imaging.thumbnail_png(sess.sdata, element, max_px)
        finally:
            sess.lock.release_read()

    try:
        png = await _in_executor(_render)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return Response(content=png, media_type="image/png")


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


# ---- static SPA (optional; served by edge in prod) -------------------------
if config.STATIC_DIR and config.STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="spa")
