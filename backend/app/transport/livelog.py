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
    pipes their lines back to the parent over a Manager queue. A reader that runs in
    the API process itself captures through `own_thread_logs`, like the load path.
  * The synchronous checkpoint-load path uses `forward_load_logs(load_id)`, which
    routes lines onto the existing `session.loading` channel (keyed by the
    client-minted nonce, since no session id exists yet).
"""
from __future__ import annotations

import contextlib
import logging
import threading
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


class _OwnThreadOnly(logging.Filter):
    """Admit only records emitted by the thread that opened the capture. The handler goes
    on the ROOT logger, so with two reads in flight every record in the process would
    otherwise be published to BOTH sinks — each client watching the other's reader.
    Reads run one per session worker thread, so thread identity is the routing key,
    matching how `_SINK` routes the job path per thread."""
    def __init__(self, thread_id: int, helper_threads: tuple[str, ...] = ()):
        super().__init__()
        self._thread_id = thread_id
        self._helper_threads = helper_threads

    def filter(self, record):
        return record.thread == self._thread_id or record.threadName in self._helper_threads


# Guards the root level below, which is process-global while `own_thread_logs` is
# per-read. `_level_depth` counts the reads currently holding a level override and
# `_level_prev` is the level the OUTERMOST one found: without the refcount, two
# overlapping reads each capture-and-restore, so the first to finish drops the level
# back and silences the second's live log — and if it captured after the second had
# already lowered it, the root logger is left lowered for the life of the process.
_LEVEL_LOCK = threading.Lock()
_level_depth = 0
_level_prev = logging.NOTSET


@contextlib.contextmanager
def own_thread_logs(sink, level: int, fmt: str | None = None, *, detached: bool = False,
                    helper_threads: tuple[str, ...] = ()):
    """Send this thread's root-logger records, one formatted line per `sink` call, for
    the length of the block, without redirecting stdout/stderr: those are process-global,
    so swapping them here in the API process would pull every other thread's output into
    this read and, when two reads overlap, leave them bound to a finished read's buffer.
    The console keeps what it had. Safe to run concurrently with other reads: each gets
    its own handler, records are routed by emitting thread, and the root level — lowered
    to `level` while any read needs it — is restored once the last one leaves.

    `detached` also taps the loggers that do not propagate to the root (spatialdata's
    own, which is where a store read reports its progress, writes to a console handler
    and stops there), at whatever level each already has. `helper_threads` names
    threads a library runs this thread's work on, whose records are admitted too: they
    are shared by every read in the process, so two overlapping reads see each other's
    lines from them, which is the price of seeing any."""
    global _level_depth, _level_prev
    handler = _SinkHandler(sink)
    handler.setLevel(level)
    if fmt is not None:
        handler.setFormatter(logging.Formatter(fmt))
    handler.addFilter(_OwnThreadOnly(threading.get_ident(), helper_threads))
    root = logging.getLogger()
    tapped = [root]
    if detached:
        tapped += [named for named in logging.root.manager.loggerDict.values()
                   if isinstance(named, logging.Logger) and not named.propagate]
    for logger in tapped:
        logger.addHandler(handler)
    with _LEVEL_LOCK:
        if _level_depth == 0:
            _level_prev = root.level
        if root.level == logging.NOTSET or root.level > level:
            root.setLevel(level)
        _level_depth += 1
    try:
        yield
    finally:
        for logger in tapped:
            logger.removeHandler(handler)
        with _LEVEL_LOCK:
            _level_depth -= 1
            if _level_depth == 0:
                root.setLevel(_level_prev)


@contextlib.contextmanager
def forward_load_logs(load_id: str | None):
    """Forward this thread's root-logger records to the checkpoint-load progress channel
    while the load runs (see `own_thread_logs`) — the load keeps logging to the console
    (Docker) as before, and also streams to the client."""
    if not load_id:
        yield
        return
    with own_thread_logs(_load_sink(load_id), logging.INFO, "%(levelname)s %(name)s: %(message)s"):
        yield


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
