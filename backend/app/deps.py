"""Shared FastAPI dependencies: the process-wide SessionManager holder plus the
session-lookup / executor / read-lock / image-render helpers used by both main.py
and every router module. Kept out of main.py so routers can import them without a
circular dependency on the app object (main.py imports the routers, not vice versa).
Session-scoped business logic shared between a route and the MCP surface (the
var-name search) lives here too, for the same reason. The session guards below are
that as well, so they raise the session layer's own errors (sessions/session.py),
which main.py maps onto HTTP statuses.
"""
import asyncio
import contextlib
from contextvars import ContextVar

from fastapi import Header, HTTPException

from .config import config
from .sessions.manager import SessionManager
from .sessions.presence import PRESENCE
from .sessions.session import (SessionBusyError, SessionLockedError, SessionNotFoundError,
                               SessionReadOnlyError)

# The process-wide manager, bound by lifespan once the registry is built. Public
# (not underscore) because it is the canonical live-manager handle for out-of-request
# readers too — e.g. the e2e harness inspects `deps.MANAGER` after startup. Routes go
# through `get_manager()` for the not-ready guard.
MANAGER: SessionManager | None = None


def set_manager(m: SessionManager) -> None:
    """Bind the process-wide manager once the app has built the registry (lifespan)."""
    global MANAGER
    MANAGER = m


def get_manager() -> SessionManager:
    if MANAGER is None:
        raise HTTPException(503, "not ready")
    return MANAGER


@contextlib.contextmanager
def bad_request():
    """Map the domain errors a rejected request raises onto 400.

    The session/registry layers signal a caller mistake — a path outside DATA_DIR, an
    absent element, an unusable descriptor — by raising, since they are also reached
    off-HTTP (the CLI, the MCP surface) and must not import fastapi. Every route that
    can trip one wraps it here rather than restating the same except clause."""
    try:
        yield
    except (RuntimeError, FileNotFoundError, KeyError) as e:
        raise HTTPException(400, str(e))


def get_session(sid: str):
    s = get_manager().get(sid)
    if s is None:
        raise SessionNotFoundError("session not found")
    return s


def get_writable_session(sid: str):
    """Same lookup as `get_session`, plus a 403 if the session was opened read-only
    (`create_from_load(read_only=True)`) and a 423 if another viewer holds its edit
    lock. Every mutating route uses this instead of `get_session` so a frozen or
    someone-else's session stays that way even against a buggy or malicious client,
    not just an unwired UI."""
    s = get_session(sid)
    if s.read_only:
        raise SessionReadOnlyError("session is read-only")
    claim_lock(sid)
    return s


def claim_lock(sid: str):
    """The edit-lock half of the mutating-route guard (sessions/presence.py): refuse
    the write while another viewer holds the session's lock, and otherwise take the
    lock for this client, so the window after a deliberate unlock can't have two
    viewers writing at once."""
    holder = PRESENCE.claim(sid, CLIENT_ID.get())
    if holder is not None:
        raise SessionLockedError(f"session is locked by {holder.name}")


# The calling browser client's id, bound per request from the X-SDS-Client-Id header
# by the app-wide `bind_client_id` dependency. A ContextVar rather than a parameter
# on every route: the lock guard above is reached from ~20 route handlers and three
# router modules, none of which otherwise need the request. Absent (None) for the
# offline CLI, the e2e harness, and any non-browser caller.
CLIENT_ID: ContextVar[str | None] = ContextVar("sds_client_id", default=None)


async def bind_client_id(x_sds_client_id: str | None = Header(default=None)) -> None:
    """App-wide dependency (registered on the FastAPI app) that binds CLIENT_ID for
    the request. Runs in the request's own task context, so one request's identity
    never leaks into another's. Must be `async` — FastAPI runs a *sync* dependency in
    a worker thread, whose copied context would discard the set."""
    CLIENT_ID.set(x_sds_client_id)


async def in_executor(fn, *a):
    return await asyncio.get_running_loop().run_in_executor(None, fn, *a)


async def search_var_names(sess, q: str = "", limit: int = 50) -> list[str]:
    """Search the session's var_names (genes) — the color-by gene picker route and
    the MCP search_genes tool. adata can carry tens of thousands of genes, so match
    server-side and cap the result; prefix hits rank first, then substring hits."""
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

    return await read_locked(sess, _search)


async def read_locked(sess, fn, *a):
    """Run `fn(*a)` in the executor under the session's read lock — the shape every
    read-only endpoint needs to serve a field/manifest/preview off a session that a
    queued job may be mutating concurrently. A compute/plot job computes with no lock
    held and takes the write lock only to commit its result (`Session._run_call`), but a
    commit can be long: adopting a read bootstrap's or a loaded checkpoint's object
    re-tiles its rasters under the write lock (minutes for a large store), and a
    close-with-save writes the whole checkpoint under it. Rather than block past a
    fronting proxy's origin timeout (which surfaces as a 504), give up after
    READ_LOCK_TIMEOUT_S with a retryable 503 (`SessionBusyError`) the frontend re-issues
    once the lock is free."""
    def _run():
        # acquire_read reports the timeout as False rather than raising, so the 503 covers
        # ONLY the acquisition: a TimeoutError raised by fn itself (a slow network read,
        # say) is a different failure and must not be relabelled as lock contention the
        # client will retry forever.
        if not sess.lock.acquire_read(config.READ_LOCK_TIMEOUT_S):
            raise SessionBusyError("session busy: compute in progress, retry")
        try:
            return fn(*a)
        finally:
            sess.lock.release_read()
    return await in_executor(_run)


# Global cap on concurrent server-side image compositing. The only thing composited
# here is the thumbnail (routers/imaging.py; the canvas composites tiles in the browser),
# and each one decodes and composites a whole level of the image's pyramid; without
# this, several arriving together decode at once and spike memory. Shared across
# sessions since RAM is a process-wide resource.
_IMAGE_RENDER_SEM = asyncio.Semaphore(config.IMAGE_RENDER_CONCURRENCY)


async def render_image(sess, fn):
    """Composite an image thumbnail under the render semaphore, refusing once memory is
    past the admission boundary so a render can't push an already-loaded container into
    OOM. The 503 is retryable: the caller asks again once memory has freed."""
    async with _IMAGE_RENDER_SEM:
        if get_manager().over_memory_boundary():
            raise HTTPException(503, "image render deferred: memory boundary reached")
        return await read_locked(sess, fn)
