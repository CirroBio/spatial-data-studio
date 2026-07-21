"""Live log streaming for data-loading jobs (DESIGN §14.2 addendum).

A reader (checkpoint load or a raw import) can run for minutes; without feedback
the client shows a frozen spinner. This module forwards each log line emitted
during a read to the SSE bus as it happens, so the import UI streams the reader's
progress. The captured log (collapsed and size-bounded by base.capture_log) is still
delivered at job completion as before — this only adds the live tap, which streams the
raw writes.

Two contexts publish through here:
  * A read-bootstrap job (session worker thread) sets `job_target(...)`; the
    reader's `capture_log()` picks up the ambient sink and tees each write to a
    `job.log` event. Library readers run in the loky child, so `child_log_stream`
    pipes their lines back to the parent over a Manager queue.
  * The synchronous checkpoint-load path uses `forward_load_logs(load_id)`, which
    routes lines onto the existing `session.loading` channel (keyed by the
    client-minted nonce, since no session id exists yet).
"""
from __future__ import annotations

import contextlib
import logging
from contextvars import ContextVar

from .sse import BUS

# The ambient live-log sink for the current worker thread's job, or None. A sink is
# `(chunk: str) -> None`; capture_log() (registry/base.py) consults this when given no
# explicit sink. ContextVars are per-thread, so one session's read never bleeds into
# another's, and non-read jobs (target unset) stream nothing.
_SINK: ContextVar[object | None] = ContextVar("livelog_sink", default=None)


def _job_sink(session_id: str, job_id: str):
    def publish(chunk: str) -> None:
        if chunk:
            BUS.publish("job.log", {"session_id": session_id, "job_id": job_id, "chunk": chunk})
    return publish


def _load_sink(load_id: str):
    def publish(chunk: str) -> None:
        if chunk:
            BUS.publish("session.loading", {"load_id": load_id, "message": None, "pct": None, "log": chunk})
    return publish


def current_sink():
    """The active thread's live-log sink, or None."""
    return _SINK.get()


@contextlib.contextmanager
def job_target(session_id: str, job_id: str):
    """Stream this job's captured log to the client as `job.log` events."""
    tok = _SINK.set(_job_sink(session_id, job_id))
    try:
        yield
    finally:
        _SINK.reset(tok)


class _SinkHandler(logging.Handler):
    def __init__(self, sink):
        super().__init__()
        self._sink = sink

    def emit(self, record):
        try:
            self._sink(self.format(record) + "\n")
        except Exception:
            # Streaming is best-effort telemetry; a transport failure must never
            # break the operation whose log we're tapping.
            pass


@contextlib.contextmanager
def forward_load_logs(load_id: str | None):
    """Forward root-logger records to the checkpoint-load progress channel while the
    load runs, without redirecting stdout/stderr — the load keeps logging to the
    console (Docker) as before, and also streams to the client."""
    if not load_id:
        yield
        return
    handler = _SinkHandler(_load_sink(load_id))
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    prev = root.level
    root.addHandler(handler)
    if root.level == logging.NOTSET or root.level > logging.INFO:
        root.setLevel(logging.INFO)
    try:
        yield
    finally:
        root.removeHandler(handler)
        root.setLevel(prev)


@contextlib.contextmanager
def child_log_stream(sink):
    """For a reader that runs in the loky child (library readers): hand back a Manager
    queue to pass into the child, and drain it on a background thread that forwards each
    chunk to `sink` while the child runs. Yields None when there's nothing to stream to,
    so callers pass a plain no-queue argument through unchanged."""
    if sink is None:
        yield None
        return
    import multiprocessing
    import threading

    with multiprocessing.Manager() as mgr:
        q = mgr.Queue()

        def drain():
            for chunk in iter(q.get, None):
                sink(chunk)

        t = threading.Thread(target=drain, name="livelog-drain", daemon=True)
        t.start()
        try:
            yield q
        finally:
            q.put(None)  # sentinel: stop the drainer once the child has returned
            t.join(timeout=5)
