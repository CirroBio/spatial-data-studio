"""The MCP assistant surface: a FastMCP server mounted inside the backend at
/api/mcp (see main.py), giving an AI agent the same machinery the SPA drives —
sessions, the reflected function registry, queued compute/plot jobs, displays,
region annotation/subsetting, checkpoints — plus vision (`view_display`,
`view_plot`) with the pixel<->world coordinate contract from mcp/vision.py.

Design rules:
- Tools are thin wrappers over the exact functions the REST routes call
  (deps guards, Session.enqueue_*, regions, recipes, snapshots, tables), so every
  mutation flows through the ordinary job queue and SSE bus — a browser watching
  the session sees the agent's work live.
- Stateless JSON transport (`stateless_http` + `json_response`): every exchange is
  one POST, no SSE dependency, so it survives buffering proxies and is trivially
  testable.
- The assistant participates in presence/locking as a first-class viewer
  (mcp/agent.py); mutating tools surface the 423 "locked by <name>" as a clean
  error with the takeover hint.
- Guidance for the agent (domain + app) ships as markdown in mcp/guides/, served
  by `read_guide` and indexed in the server instructions below.
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from fastapi import HTTPException
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.utilities.types import Image
from mcp.server.transport_security import TransportSecuritySettings

from . import agent, vision
from .. import datasets, recipes, snapshots
from ..config import config, data_roots
from ..registry.introspect import REGISTRY
from ..registry.reader_paths import reader_namespace
from ..transport import tables
from ..transport.sse import BUS
from .. import deps
from ..deps import _in_executor, _read_locked, default_save_path, search_var_names

GUIDES_DIR = Path(__file__).parent / "guides"
GUIDE_TOPICS = {
    "studio": "studio.md",
    "spatial-biology": "spatial-biology.md",
    "analysis-playbooks": "analysis-playbooks.md",
    "vision-and-selection": "vision-and-selection.md",
}

LOG_TAIL_CHARS = 4000

INSTRUCTIONS = f"""You are connected to Spatial Data Studio: an interactive app for
analyzing spatial transcriptomics/proteomics data (squidpy/scanpy/spatialdata on the
backend, a WebGL canvas in the user's browser). You share live sessions with human
viewers: every change you make appears in their browser in real time.

Before real work, read the guides (read_guide): 'studio' (how the app works),
'spatial-biology' (domain interpretation), 'analysis-playbooks' (research question ->
workflow), 'vision-and-selection' (how to see the data and select cells — read this
before using view_display/annotate_region/subset_to_region).

Core loop: list_sessions -> set_active_session (take_control=True if a viewer holds
the edit lock — announce it to the user first) -> inspect (get_session, view_display,
list_plots) -> act (run_function/run_recipe, update_display, annotate_region) ->
verify visually (view_display, view_plot) -> save_checkpoint. Release control
(release_control) when you finish.

Coordinates: view_display returns the image plus a pixel_to_world affine and a
world-labeled grid; annotate/subset/inspect take polygons in that world space
(embedding views use space='embedding'). Verify a selection with mark_polygons +
inspect_region before mutating. There is no undo — compute mutates the session
in place (audit-log model).

The user's browser: {config.APP_URL or 'ask the user for the studio URL'} — tell the
user which session to open there; you cannot navigate their browser."""

mcp_server = FastMCP(
    "spatial-data-studio",
    instructions=INSTRUCTIONS,
    stateless_http=True,
    json_response=True,
    # Mounted into the FastAPI app under /api (main.py); the endpoint is /api/mcp.
    streamable_http_path="/mcp",
    # The SDK would otherwise default to a localhost-only Host allowlist (DNS
    # rebinding protection), which breaks any deployment reached through a real
    # hostname. The app's trust model (like its REST API) is that anything able to
    # reach the port is authorized, so the check is off. Reviewed and accepted as a
    # deliberate trade-off for the deployment model this app targets: a single
    # scientist on a single machine, with no untrusted origin sharing the host.
    # Revisit only if the app is ever served to multiple users or exposed beyond a
    # trusted network.
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


# ---- plumbing -------------------------------------------------------------------
def _mgr():
    if deps.MANAGER is None:
        raise RuntimeError("backend not ready yet (registry still building)")
    return deps.MANAGER


def _sid(session_id: str | None) -> str:
    sid = session_id or agent.active_session_id()
    if sid is None:
        raise ValueError("no session_id given and no active session — call "
                         "set_active_session first (see list_sessions)")
    return sid


def _sess(session_id: str | None = None):
    sess = _mgr().get(_sid(session_id))
    if sess is None:
        raise ValueError("session not found (it may have been closed or subset-evicted; "
                         "check list_sessions)")
    return sess


def _writable(session_id: str | None = None):
    """The mutating-tool guard: same checks as the REST routes (read-only + edit
    lock), with the HTTPException translated into an agent-actionable error."""
    try:
        return deps._writable_session(_sid(session_id))
    except HTTPException as e:
        hint = (" — call set_active_session(session_id, take_control=True) to take the "
                "edit lock (tell the user first; they keep watching read-only)"
                if e.status_code == 423 else "")
        raise RuntimeError(f"{e.detail}{hint}")


_TERMINAL = ("completed", "failed", "cancelled", "drawn", "invalidated")


async def _await_job(sess, job_id: str, timeout_s: float) -> str:
    """Poll a job to a terminal status (the assistant has no SSE); refreshes the
    agent's activity so its presence outlives a long compute."""
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout_s:
        status = sess.job_status(job_id)
        if status is None or status in _TERMINAL:
            return status or "completed"
        agent.touch()
        await asyncio.sleep(0.4)
    return "running"


async def _await_queue_drain(sess, timeout_s: float) -> bool:
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout_s:
        if not sess.queue_view():
            return True
        agent.touch()
        await asyncio.sleep(0.5)
    return False


def _log_tail(sess, job_id: str) -> str | None:
    log, _status = sess.get_log(job_id)
    if not log:
        return None
    return log[-LOG_TAIL_CHARS:]


def _record(sess, job_id: str) -> dict | None:
    rec = sess.find_record(job_id)
    if rec is None:
        return None
    return {k: v for k, v in rec.items() if k != "_log"}


def _job_report(sess, job_id: str, status: str) -> dict:
    out = {"job_id": job_id, "status": status}
    rec = _record(sess, job_id)
    if rec:
        out["entry"] = rec
        if rec.get("status") == "failed" or status == "failed":
            out["log_tail"] = _log_tail(sess, job_id)
    elif status == "failed":
        out["log_tail"] = _log_tail(sess, job_id)
    if status == "running":
        out["note"] = ("still running past the wait timeout — check list_jobs / "
                       "get_job(job_id) later; the queue keeps going")
    return out


def _meta_block(meta: dict) -> str:
    return json.dumps(meta, indent=1)


# ---- guidance ---------------------------------------------------------------------
@mcp_server.tool()
async def read_guide(topic: str) -> str:
    """Read one of the bundled guides. Topics: 'studio' (what the app is and how its
    sessions/jobs/plots/displays/locks work), 'spatial-biology' (domain primer:
    platforms, QC, interpretation), 'analysis-playbooks' (research question ->
    analysis workflow, recipes to use, plots to inspect, questions to ask the user),
    'vision-and-selection' (REQUIRED before view_display + annotate/subset: the
    coordinate contract and the verify-then-act loop)."""
    agent.bind_agent()
    fname = GUIDE_TOPICS.get(topic)
    if fname is None:
        raise ValueError(f"unknown topic '{topic}'; choose one of {sorted(GUIDE_TOPICS)}")
    return (GUIDES_DIR / fname).read_text()


# ---- sessions ----------------------------------------------------------------------
@mcp_server.tool()
async def list_sessions() -> dict:
    """All live sessions (id, name, status, parent, saved) plus who is viewing and
    who holds each edit lock, which session is the assistant's active one, and the
    URL where the user can watch."""
    agent.bind_agent()
    from ..sessions.presence import PRESENCE
    presence = PRESENCE.view()["sessions"]
    sessions = []
    for s in _mgr().list_summaries():
        p = presence.get(s["id"], {})
        lock = p.get("lock")
        sessions.append({**s, "viewers": p.get("viewers", []),
                         "locked_by": lock["name"] if lock else None})
    return {"sessions": sessions,
            "active_session_id": agent.active_session_id(),
            "app_url": config.APP_URL or None,
            "note": "the user picks which session their browser shows; tell them the "
                    "session name to switch to"}


@mcp_server.tool()
async def get_session(session_id: str | None = None, history_limit: int = 25) -> dict:
    """A session's full working state: data fields (obs/obsm/var/obsp/layers/images/
    shapes), displays with their encodings, the job queue, plots, region sets, and the
    tail of the compute history (capped at history_limit; get_job fetches any entry's
    log)."""
    agent.bind_agent()
    sess = _sess(session_id)
    state = await _read_locked(sess, _mgr().state, sess)
    app_state = state["app_state"]
    history = app_state.get("compute_history", [])
    return {
        "summary": state["summary"],
        "fields": state["fields"],
        "queue": state["queue"],
        "displays": app_state.get("displays", []),
        "plots": app_state.get("plots", []),
        "regions": app_state.get("regions", []),
        "compute_history": history[-history_limit:],
        "compute_history_total": len(history),
        "active_table": sess.active_table_key,
    }


@mcp_server.tool()
async def create_session(checkpoint_path: str | None = None, reader: dict | None = None,
                         name: str | None = None, wait: bool = True,
                         timeout_s: float = 900) -> dict:
    """Create a session from a saved checkpoint (checkpoint_path: a .zarr/.zarr.zip
    under the data dir — see list_datasets) OR by importing raw data with a reader
    (reader: {"namespace": "io"|"read", "function": e.g. "xenium", "params": {...}} —
    namespace is required, since several reader names exist in both; see
    list_readers/browse_data_dir). Waits until the load finishes by default and
    makes the new session the assistant's active one."""
    agent.bind_agent()
    if (checkpoint_path is None) == (reader is None):
        raise ValueError("give exactly one of checkpoint_path or reader")
    try:
        if checkpoint_path is not None:
            sess = await _in_executor(_mgr().create_from_load, checkpoint_path, name, None)
        else:
            descriptor = {"namespace": reader_namespace(reader),
                          "function": reader["function"], "params": reader.get("params", {})}
            if REGISTRY.get(f"{descriptor['namespace']}.{descriptor['function']}") is None:
                raise RuntimeError(f"unknown reader {descriptor['namespace']}.{descriptor['function']}"
                                   " (see list_readers)")
            sess = _mgr().create_from_read(descriptor, name)
    except (RuntimeError, FileNotFoundError, KeyError) as e:
        raise ValueError(str(e))
    agent.set_active(sess.id)
    if wait:
        t0 = time.monotonic()
        while sess.status == "loading" and time.monotonic() - t0 < timeout_s:
            agent.touch()
            await asyncio.sleep(0.5)
    out = {**_mgr().summary(sess), "active": True}
    if sess.status == "loading":
        out["note"] = "still loading; poll list_sessions until status is 'ready'"
    if sess.status == "errored":
        job_ids = sess.job_ids()
        out["log_tail"] = _log_tail(sess, job_ids[0]) if job_ids else None
    return out


@mcp_server.tool()
async def set_active_session(session_id: str, take_control: bool = False) -> dict:
    """Point the assistant at a session: subsequent tools default to it, and the
    assistant appears in its viewer list. take_control=True also takes the edit lock
    even if a human viewer holds it (they keep watching read-only; tell them first).
    Without it, mutations only work while the session is unlocked."""
    agent.bind_agent()
    sess = _sess(session_id)
    if take_control:
        result = agent.take_control(sess.id, force=True)
    else:
        agent.set_active(sess.id)
        result = {"ok": True, "locked_by": agent.lock_holder_name(sess.id)}
    return {**result, "session": _mgr().summary(sess)}


@mcp_server.tool()
async def release_control() -> dict:
    """Detach from the active session and release any edit lock the assistant holds,
    so human viewers can edit again. Call this when you finish working."""
    agent.bind_agent()
    agent.release()
    return {"ok": True}


@mcp_server.tool()
async def save_checkpoint(session_id: str | None = None, path: str | None = None,
                          wait: bool = True, timeout_s: float = 600) -> dict:
    """Save the session to a .zarr.zip checkpoint (reloadable via create_session).
    Default path: <data dir>/<session name> with a content-hash suffix."""
    agent.bind_agent()
    sess = _writable(session_id)
    target = path or default_save_path(sess)
    job_id = sess.enqueue_special("save", {"path": target, "hash_name": not path})
    status = await _await_job(sess, job_id, timeout_s) if wait else "queued"
    out = {"job_id": job_id, "status": status, "path": sess.store_path if status == "completed" else target}
    if status == "failed":
        out["log_tail"] = _log_tail(sess, job_id)
    return out


@mcp_server.tool()
async def close_session(session_id: str, save: bool = False) -> dict:
    """Close a session, optionally saving it back to its checkpoint first. Ask the
    user before closing a session you did not create."""
    agent.bind_agent()
    if save:
        _writable(session_id)
    else:
        try:
            deps._claim_lock(session_id)
        except HTTPException as e:
            raise RuntimeError(str(e.detail))
    if agent.active_session_id() == session_id:
        agent.release()
    await _in_executor(_mgr().close, session_id, save)
    return {"ok": True}


@mcp_server.tool()
async def list_datasets() -> dict:
    """Saved checkpoints (.zarr / .zarr.zip) found under the data roots — the inputs
    create_session(checkpoint_path=...) accepts. Raw (unconverted) data folders are
    found with browse_data_dir instead."""
    agent.bind_agent()
    found = await _in_executor(datasets.list_datasets, data_roots())
    return {"datasets": found}


@mcp_server.tool()
async def browse_data_dir(path: str | None = None, include_files: bool = False) -> dict:
    """Navigate the data directory (the only filesystem the backend may read).
    Entries are dirs, loadable datasets (.zarr/.zarr.zip), and — with include_files —
    plain files. Use to locate a raw vendor bundle for a reader import."""
    agent.bind_agent()
    return await _in_executor(datasets.browse, data_roots(), path, include_files)


@mcp_server.tool()
async def list_readers() -> dict:
    """Raw-data readers (squidpy `read` + spatialdata-io `io` namespaces) usable as
    create_session(reader=...): key, summary, and each parameter with its type,
    whether it's required, and its filesystem role (folder/file) when it is a path."""
    agent.bind_agent()
    readers = []
    for e in REGISTRY.public()["functions"]:
        if e["namespace"] not in ("read", "io"):
            continue
        schema, ui = e.get("json_schema", {}), e.get("ui_schema", {})
        required = set(schema.get("required", []))
        params = {n: {"type": p.get("type"), "required": n in required,
                      "path_kind": (ui.get(n) or {}).get("path_kind")}
                  for n, p in schema.get("properties", {}).items()}
        readers.append({"key": e["key"], "summary": e.get("summary", ""), "params": params})
    return {"readers": readers}


# ---- the function registry / analyses ------------------------------------------------
@mcp_server.tool()
async def search_functions(query: str = "", namespace: str | None = None,
                           limit: int = 25) -> dict:
    """Search the reflected function registry (squidpy gr/im/pl, scanpy sc.pp/sc.tl/
    sc.pl/sc.get, readers, custom methods). Matches key + summary text. Returns key,
    effect_class ('compute'|'plot'|'extract'|'read') and summary; use
    describe_function(key) for the parameter schema."""
    agent.bind_agent()
    q = query.strip().lower()
    hits = []
    for e in REGISTRY.public()["functions"]:
        if namespace and e["namespace"] != namespace:
            continue
        if q and q not in e["key"].lower() and q not in (e.get("summary") or "").lower():
            continue
        hits.append({"key": e["key"], "namespace": e["namespace"],
                     "effect_class": e.get("effect_class"), "summary": e.get("summary", "")})
    return {"total": len(hits), "functions": hits[:limit],
            "library_versions": REGISTRY.library_versions}


@mcp_server.tool()
async def describe_function(key: str) -> dict:
    """Full registry entry for one function key (e.g. 'gr.spatial_neighbors'):
    parameter JSON schema, widget hints (which params bind to obs columns/genes/
    layers), citation, documentation URL, and any locked/unsupported params."""
    agent.bind_agent()
    for e in REGISTRY.public()["functions"]:
        if e["key"] == key:
            return e
    raise ValueError(f"unknown function '{key}' (see search_functions)")


@mcp_server.tool()
async def run_function(namespace: str, function: str, params: dict | None = None,
                       session_id: str | None = None, wait: bool = True,
                       timeout_s: float = 600) -> dict:
    """Run one registry function on the session as a queued job — a compute (mutates
    the object in place; no undo) or a plot (namespace 'pl'/'sc.pl'/..., drawn
    server-side; view it with view_plot(job_id)). Returns the history entry with
    status, structural_diff, and a log tail on failure."""
    agent.bind_agent()
    if REGISTRY.get(f"{namespace}.{function}") is None:
        raise ValueError(f"unknown function {namespace}.{function} (see search_functions)")
    sess = _writable(session_id)
    try:
        job_id = sess.enqueue_descriptor({"namespace": namespace, "function": function,
                                          "params": params or {}})
    except RuntimeError as e:  # e.g. a reader param pointing outside the data dir
        raise ValueError(str(e))
    status = await _await_job(sess, job_id, timeout_s) if wait else "queued"
    return _job_report(sess, job_id, status)


@mcp_server.tool()
async def list_jobs(session_id: str | None = None, limit: int = 30) -> dict:
    """The session's analyses with their statuses: currently queued/running jobs plus
    the tail of the compute history and every plot entry
    (pending|queued|running|completed|drawn|invalidated|failed)."""
    agent.bind_agent()
    sess = _sess(session_id)
    state = await _read_locked(sess, _mgr().state, sess)
    history = state["app_state"].get("compute_history", [])
    return {"queue": state["queue"],
            "compute_history": history[-limit:], "compute_history_total": len(history),
            "plots": state["app_state"].get("plots", [])}


@mcp_server.tool()
async def get_job(job_id: str, session_id: str | None = None) -> dict:
    """One analysis in detail: its descriptor (namespace/function/params), status,
    structural diff, and the full captured log (stdout/stderr of the library call)."""
    agent.bind_agent()
    sess = _sess(session_id)
    rec = _record(sess, job_id)
    log, status = sess.get_log(job_id)
    if rec is None and log is None:
        raise ValueError("job not found (queued 'special' jobs — save/subset/annotate — "
                         "report through their own tools)")
    return {"entry": rec, "status": (rec or {}).get("status") or status, "log": log}


@mcp_server.tool()
async def list_recipes() -> dict:
    """Curated multi-step analysis recipes bundled with the app (each a list of
    registry-function steps, with optional recipe-level params). Run with run_recipe."""
    agent.bind_agent()
    return {"recipes": recipes.catalog()}


@mcp_server.tool()
async def run_recipe(name: str, param_values: dict | None = None,
                     session_id: str | None = None, mode: str = "run",
                     wait: bool = True, timeout_s: float = 1800) -> dict:
    """Run a bundled recipe by name on the session (mode='run' queues every step now;
    mode='stage' stages them as editable PENDING steps instead). With wait, blocks
    until the queue drains and reports each step's terminal status."""
    agent.bind_agent()
    sess = _writable(session_id)
    pre = {r["id"] for r in list(sess.app_state.get("compute_history", []))} | \
          {r["id"] for r in list(sess.app_state.get("plots", []))}
    result = recipes.apply_recipe(sess, name, mode, param_values)
    if result.get("status") == "failed":
        raise ValueError(result.get("error", "recipe failed"))
    if mode != "run" or not wait:
        return result
    drained = await _await_queue_drain(sess, timeout_s)
    state = await _read_locked(sess, _mgr().state, sess)
    steps = [{"id": r["id"], "function": f"{r['namespace']}.{r['function']}", "status": r["status"]}
             for r in (state["app_state"].get("compute_history", []) + state["app_state"].get("plots", []))
             if r["id"] not in pre]
    return {**result, "drained": drained, "steps": steps}


# ---- plots -----------------------------------------------------------------------
@mcp_server.tool()
async def list_plots(session_id: str | None = None) -> dict:
    """Every plot in the session with its state (queued|running|drawn|invalidated|
    failed — 'invalidated' means an upstream field changed since it was drawn) and
    whether a rendered figure is available to look at (this session's own render, or one
    the checkpoint it was loaded from carries)."""
    agent.bind_agent()
    sess = _sess(session_id)
    state = await _read_locked(sess, _mgr().state, sess)
    available = state["figures"]
    plots = [{**p, "figure_available": "png" in available.get(p["id"], {})}
             for p in state["app_state"].get("plots", [])]
    return {"plots": plots}


@mcp_server.tool()
async def view_plot(plot_id: str, session_id: str | None = None,
                    redraw_if_missing: bool = True, timeout_s: float = 300):
    """Look at a drawn plot (returns the figure as an image). If no rendered figure is
    available — neither in memory nor in the checkpoint the session was loaded from — or
    the plot is invalidated, redraws it first (a queued job) unless
    redraw_if_missing=False."""
    agent.bind_agent()
    sess = _sess(session_id)
    rec = sess.find_record(plot_id)
    if rec is None:
        raise ValueError("no such plot (see list_plots)")
    png = sess.figure(plot_id, "png")
    if (png is None or rec.get("status") == "invalidated") and redraw_if_missing:
        _writable(session_id)  # a redraw is a mutation (queued job + uns color cache)
        if not sess.redraw_plot(plot_id):
            raise ValueError(f"plot is {rec.get('status')} and cannot be redrawn")
        status = await _await_job(sess, plot_id, timeout_s)
        if status != "drawn":
            report = _job_report(sess, plot_id, status)
            raise ValueError(f"redraw did not complete: {json.dumps(report)}")
        png = sess.figure(plot_id, "png")
        rec = sess.find_record(plot_id) or rec
    if png is None:
        raise ValueError("figure not available (status: %s); pass redraw_if_missing=True"
                         % rec.get("status"))
    caption = {"plot_id": plot_id, "function": f"{rec['namespace']}.{rec['function']}",
               "params": rec.get("params", {}), "status": rec.get("status")}
    return [Image(data=png, format="png"), _meta_block(caption)]


# ---- displays + vision --------------------------------------------------------------
@mcp_server.tool()
async def view_display(session_id: str | None = None, display_id: str | None = None,
                       viewport: dict | str | None = None,
                       width_px: int = vision.DEFAULT_WIDTH_PX,
                       height_px: int = vision.DEFAULT_HEIGHT_PX,
                       include_grid: bool = True,
                       mark_points: list | None = None,
                       mark_polygons: list | None = None):
    """Look at a display (the canvas the user sees): renders it server-side and
    returns the image plus a coordinate contract (pixel_to_world affine, world
    window, grid intervals). viewport: {"target":[x,y],"zoom":z}, "fit" (frame all
    data), or omitted (the display's saved viewport). The world-labeled grid is drawn
    unless include_grid=False. mark_points=[[x,y]|{"x","y","label"}] and
    mark_polygons=[[[x,y],...]|{"points":...,"label"}] draw verification overlays at
    world coordinates — use them to confirm a selection before annotating. Read the
    'vision-and-selection' guide first."""
    agent.bind_agent()
    sess = _sess(session_id)
    png, meta = await _in_executor(
        lambda: vision.render_view(sess, display_id, viewport, width_px, height_px,
                                   include_grid, mark_points, mark_polygons))
    return [Image(data=png, format="png"), _meta_block(meta)]


@mcp_server.tool()
async def update_display(encoding: dict | None = None, viewport: dict | None = None,
                         display_id: str | None = None,
                         session_id: str | None = None) -> dict:
    """Change display settings — the user's canvas restyles live. `encoding` merges
    key-by-key into the current encoding (pass a key as null to clear it): e.g.
    {"color_by": "X:Sox17"} or {"color_by": "obs:leiden"}, {"point_size": 6},
    {"colormap": "viridis"}, {"image_layer": null}, {"render_mode": "points+shapes"}.
    `viewport` ({target, zoom}) repositions the saved camera."""
    agent.bind_agent()
    sess = _writable(session_id)
    display = snapshots.resolve_display(sess, display_id)
    if display is None:
        raise ValueError("display not found (see get_session)")
    spec = {**display, "encoding": {**display.get("encoding", {}), **(encoding or {})}}
    if viewport is not None:
        spec["viewport"] = viewport
    if not sess.update_display(display["id"], spec):
        raise ValueError("display not found")
    BUS.publish("display.updated", {"session_id": sess.id, "display_id": display["id"],
                                    "spec": spec})
    return {"display": spec}


@mcp_server.tool()
async def add_display(type: str, encoding: dict, session_id: str | None = None) -> dict:
    """Add a display: type 'spatial_canvas' (encoding: coords/color_by/image_layer/
    point_size/...) or 'embedding_canvas' (encoding: obsm_key/x_component/y_component/
    color_by/...). Useful after computing a new embedding (e.g. X_umap)."""
    agent.bind_agent()
    if type not in ("spatial_canvas", "embedding_canvas"):
        raise ValueError("type must be spatial_canvas or embedding_canvas")
    sess = _writable(session_id)
    spec = sess.add_display({"type": type, "encoding": encoding, "viewport": None})
    BUS.publish("display.updated", {"session_id": sess.id, "display_id": spec["id"],
                                    "spec": spec})
    return {"display": spec}


# ---- selections: inspect / annotate / subset ----------------------------------------
async def _selection_payload(sess, polygons: list | None, cell_indices: list | None,
                             space: str, display_id: str | None) -> dict:
    """The selection half of an annotate/subset job payload: enforces the
    exactly-one-of contract, coerces explicit indices, and resolves an
    embedding-space polygon selection to cell indices here (the worker resolves
    world-space polygons itself)."""
    if (polygons is None) == (cell_indices is None):
        raise ValueError("give exactly one of polygons or cell_indices")
    if cell_indices is not None:
        return {"cell_indices": [int(i) for i in cell_indices]}
    if space == "embedding":
        display = snapshots.resolve_display(sess, display_id)
        mask = await _read_locked(sess, vision.cells_in_polygons, sess, display, polygons, "embedding")
        return {"cell_indices": [int(i) for i in mask.nonzero()[0]]}
    return {"polygons": polygons}


@mcp_server.tool()
async def inspect_region(polygons: list, space: str = "spatial",
                         session_id: str | None = None, display_id: str | None = None,
                         by: str | None = None, genes: list | None = None) -> dict:
    """Dry-run a selection WITHOUT changing anything: how many cells the polygon(s)
    contain, their composition by a categorical obs column (default: the first
    categorical), and mean expression of named genes inside vs outside.
    space='spatial': polygons are world coordinates (the space view_display reports).
    space='embedding': polygons are embedding coordinates of display_id's axes."""
    agent.bind_agent()
    sess = _sess(session_id)
    display = snapshots.resolve_display(sess, display_id) if space == "embedding" else None

    def _run():
        mask = vision.cells_in_polygons(sess, display, polygons, space)
        return vision.region_stats(sess, mask, by, genes)

    return await _read_locked(sess, _run)


@mcp_server.tool()
async def annotate_region(region_set: str, category: str, polygons: list | None = None,
                          cell_indices: list | None = None, color: str | None = None,
                          space: str = "spatial", session_id: str | None = None,
                          display_id: str | None = None, wait: bool = True,
                          timeout_s: float = 300) -> dict:
    """Label cells into a region set (a categorical obs column; created if new) —
    e.g. annotate_region("tissue_region", "tumor", polygons=[[[x,y],...]],
    color="#c1432b"). Cells inside the polygons get the category; every display
    switches its coloring to the region set so the user (and your next view_display)
    sees the labeled cells immediately. Polygons are world coordinates; for a
    selection made on an embedding view pass space='embedding' (resolved to
    cell_indices) or cell_indices directly. Verify with inspect_region first."""
    agent.bind_agent()
    sess = _writable(session_id)
    payload: dict = {"region_set": region_set, "category": category}
    if color:
        payload["color"] = color
    payload.update(await _selection_payload(sess, polygons, cell_indices, space, display_id))
    job_id = sess.enqueue_special("annotate", payload)
    status = await _await_job(sess, job_id, timeout_s) if wait else "queued"
    out = {"job_id": job_id, "status": status}
    if status == "completed":
        def _counts():
            col = sess.active_table().obs[region_set].astype(str)
            return {v: int(n) for v, n in col.value_counts().items()}
        out["region_set_counts"] = await _read_locked(sess, _counts)
        out["note"] = "all displays now color by this region set"
    elif status == "failed":
        out["log_tail"] = _log_tail(sess, job_id)
    return out


@mcp_server.tool()
async def subset_to_region(polygons: list | None = None, cell_indices: list | None = None,
                           invert: bool = False, space: str = "spatial",
                           session_id: str | None = None, display_id: str | None = None,
                           wait: bool = True, timeout_s: float = 600) -> dict:
    """Carve the selection out into a NEW child session and CLOSE the parent (the
    child replaces it — save_checkpoint first if you need to return to the full
    data!). invert=True keeps the cells OUTSIDE the selection instead. Polygons are
    world coordinates; embedding-view selections use space='embedding' or explicit
    cell_indices. The child becomes the assistant's active session."""
    agent.bind_agent()
    sess = _writable(session_id)
    payload: dict = {"invert": bool(invert),
                     **await _selection_payload(sess, polygons, cell_indices, space, display_id)}
    parent_id = sess.id
    job_id = sess.enqueue_special("subset", payload)
    if not wait:
        return {"job_id": job_id, "status": "queued",
                "note": "the child session arrives via list_sessions once done"}
    status = await _await_job(sess, job_id, timeout_s)
    if status != "completed":
        return _job_report(sess, job_id, status)
    child = next((s for s in _mgr().list_summaries() if s["parent_id"] == parent_id), None)
    if child is not None and agent.active_session_id() in (parent_id, None):
        agent.set_active(child["id"])
    return {"job_id": job_id, "status": status, "child_session": child,
            "note": "the parent session was closed and replaced by this child"}


# ---- shape annotations (figure markup) ----------------------------------------------
@mcp_server.tool()
async def list_shape_annotations(session_id: str | None = None) -> dict:
    """Drawn figure-markup shapes on the session (arrows/lines/boxes/polygons/
    ellipses/text), with ids for update/delete."""
    agent.bind_agent()
    sess = _sess(session_id)
    # Aliased: the bare name `annotations` is already bound module-wide by
    # `from __future__ import annotations` at the top of this file.
    from ..transport import annotations as shape_annotations
    return {"shapes": await _read_locked(sess, shape_annotations.list_shape_annotations, sess)}


_STROKE_DEFAULTS = {"color": "#ffcc00", "width": 2.0, "dash": "solid",
                    "arrowStart": False, "arrowEnd": False, "arrowSize": 12.0, "z": 0}


@mcp_server.tool()
async def add_shape_annotation(shape: dict, session_id: str | None = None,
                               wait: bool = True, timeout_s: float = 120) -> dict:
    """Draw one markup shape in world coordinates (persisted with the session; shown
    on every viewer's canvas). Shape: {"label"?: str, "geometry": <one of:
    {"kind":"line","vertices":[[x,y],[x,y]]} (an arrow when stroke.arrowEnd is true) |
    {"kind":"box","vertices":[4 corners]} | {"kind":"polygon","vertices":[[x,y],...]} |
    {"kind":"ellipse","center":[x,y],"radiusX":r,"radiusY":r,"rotation":rad} |
    {"kind":"text","position":[x,y],"text":str,"fontSize":world_units}>,
    "stroke"?: {"color":"#rrggbb","width":px,"dash":"solid"|"dashed"|"dotted",
    "arrowStart":bool,"arrowEnd":bool,"arrowSize":n,"z":int} (missing stroke fields
    get sensible defaults), "fill"?: {"enabled":bool,"color":"#rrggbb","alpha":0-1,
    "z":int}}. E.g. an arrow pointing at a structure you're discussing with the user."""
    agent.bind_agent()
    sess = _writable(session_id)
    shape = {**shape, "stroke": {**_STROKE_DEFAULTS, **(shape.get("stroke") or {})}}
    job_id = sess.enqueue_special("shape_annotate", {"op": "create", "shape": shape})
    status = await _await_job(sess, job_id, timeout_s) if wait else "queued"
    out = {"job_id": job_id, "status": status}
    if status == "failed":
        out["log_tail"] = _log_tail(sess, job_id)
    return out


@mcp_server.tool()
async def delete_shape_annotation(shape_id: str, session_id: str | None = None,
                                  wait: bool = True, timeout_s: float = 120) -> dict:
    """Remove one markup shape by id (see list_shape_annotations)."""
    agent.bind_agent()
    sess = _writable(session_id)
    job_id = sess.enqueue_special("shape_annotate", {"op": "delete", "shape_id": shape_id})
    status = await _await_job(sess, job_id, timeout_s) if wait else "queued"
    return {"job_id": job_id, "status": status}


# ---- data access ---------------------------------------------------------------------
@mcp_server.tool()
async def get_obs_summary(column: str, session_id: str | None = None) -> dict:
    """Summarize one obs column: categorical -> values with counts; numeric -> min/
    max/mean/median. Use get_session's fields list to see what exists."""
    agent.bind_agent()
    sess = _sess(session_id)

    def _summarize():
        import pandas as pd
        obs = sess.active_table().obs
        if column not in obs.columns:
            raise KeyError(f"no obs column '{column}'")
        col = obs[column]
        if isinstance(col.dtype, pd.CategoricalDtype) or col.dtype == object or col.dtype == bool:
            counts = col.astype(str).value_counts()
            return {"column": column, "kind": "categorical", "n_unique": int(counts.size),
                    "values": [{"value": str(v), "count": int(n)} for v, n in counts.head(60).items()]}
        vals = pd.to_numeric(col, errors="coerce")
        return {"column": column, "kind": "numeric",
                "min": float(vals.min()), "max": float(vals.max()),
                "mean": float(vals.mean()), "median": float(vals.median()),
                "n_nan": int(vals.isna().sum())}

    try:
        return await _read_locked(sess, _summarize)
    except KeyError as e:
        raise ValueError(str(e))


@mcp_server.tool()
async def get_table(path: str, offset: int = 0, limit: int = 50,
                    session_id: str | None = None) -> dict:
    """Page through a dataframe: path is 'obs', 'var', 'tables:<name>:obs',
    'tables:<name>:var', 'shapes:<name>', or 'points:<name>' (bare obs/var read
    the active table). Returns columns with dtypes and the requested row page —
    e.g. read QC metrics from obs or gene stats from var."""
    agent.bind_agent()
    sess = _sess(session_id)
    offset, limit = max(0, offset), max(1, min(limit, 200))

    def _page():
        return tables.table_preview(sess.active_table(), sess.sdata, path, offset, limit)

    try:
        return await _read_locked(sess, _page)
    except (KeyError, ValueError) as e:
        raise ValueError(str(e))


@mcp_server.tool()
async def search_genes(query: str = "", session_id: str | None = None,
                       limit: int = 50) -> dict:
    """Search the session's gene names (var_names); prefix matches rank first. Use a
    hit as 'X:<gene>' in a display's color_by, or in analysis params."""
    agent.bind_agent()
    return {"names": await search_var_names(_sess(session_id), query, limit)}


# ---- publication figures --------------------------------------------------------------
@mcp_server.tool()
async def export_figure(session_id: str | None = None, display_id: str | None = None,
                        viewport: dict | None = None, width_px: int = 1600,
                        height_px: int = 1200, dpi: int = 200,
                        formats: list | None = None, label: str | None = None,
                        include_minimap: bool = False) -> dict:
    """Export a publication-quality snapshot figure of a display (vector PDF and/or
    PNG with embedded provenance) into the studio's snapshot gallery. Unlike
    view_display this writes files the user keeps. viewport defaults to the
    display's saved camera."""
    agent.bind_agent()
    sess = _writable(session_id)
    spec = {"viewport": viewport, "width_px": width_px, "height_px": height_px,
            "dpi": dpi, "formats": formats or ["pdf", "png"], "label": label,
            "display_id": display_id, "include_minimap": include_minimap}
    result = await _in_executor(snapshots.save_snapshot, sess, spec)
    if result.get("status") == "failed":
        raise ValueError(result.get("error", "snapshot failed"))
    return result
