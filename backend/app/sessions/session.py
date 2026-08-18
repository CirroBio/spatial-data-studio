"""A session = one in-memory SpatialData + one FIFO queue + one worker thread +
its attrs state (DESIGN §11.1). Compute mutates in place; the queue is strictly
serial (§6.2). A read/write lock keeps async data serving off a half-mutated
object (§20.2).
"""
import contextlib
import os
import queue
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

from . import appstate
from .adapter import ADAPTER
from ..config import within_data_dir
from ..registry.introspect import REGISTRY
from ..registry.reader_paths import validate_reader_params
from ..transport import livelog
from ..transport.sse import BUS


class RWLock:
    """Many readers OR one writer, writer-preferring (DESIGN §20.2): a waiting writer
    blocks NEW readers while in-flight ones drain, so sustained overlapping reads
    (deck.gl tile bursts) can't starve a compute commit/save indefinitely."""
    def __init__(self):
        self._cond = threading.Condition()
        self._readers = 0
        self._writer = False
        self._writers_waiting = 0

    def acquire_read(self, timeout=None):
        """Block until no writer holds — or is waiting for — the lock, then register a
        reader. With `timeout` (seconds), give up and return False if the writer side
        still blocks entry when it elapses; return True once the read lock is held."""
        with self._cond:
            if timeout is None:
                while self._writer or self._writers_waiting > 0:
                    self._cond.wait()
            else:
                deadline = time.monotonic() + timeout
                while self._writer or self._writers_waiting > 0:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return False
                    self._cond.wait(remaining)
            self._readers += 1
            return True

    def release_read(self):
        with self._cond:
            self._readers -= 1
            if self._readers == 0:
                self._cond.notify_all()

    def acquire_write(self):
        with self._cond:
            # Register as waiting BEFORE blocking so acquire_read stops admitting new
            # readers (writer preference). try/finally: an interrupted wait must not
            # leak the count, or readers would be locked out forever.
            self._writers_waiting += 1
            try:
                while self._writer or self._readers > 0:
                    self._cond.wait()
                self._writer = True
            finally:
                self._writers_waiting -= 1
                if not self._writer:
                    # Interrupted before taking ownership: readers this waiting
                    # writer held back may have no other notifier left, wake them.
                    self._cond.notify_all()

    def release_write(self):
        with self._cond:
            self._writer = False
            self._cond.notify_all()

    @contextmanager
    def reading(self, timeout=None):
        if not self.acquire_read(timeout):
            raise TimeoutError("read lock not acquired within timeout")
        try:
            yield
        finally:
            self.release_read()

    @contextmanager
    def writing(self):
        self.acquire_write()
        try:
            yield
        finally:
            self.release_write()


def _now():
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# Non-mutating jobs (plots, extracts) run off the serial queue on this shared pool so
# they don't wait behind a long compute (DESIGN §24). Each task blocks on the compute
# pool, so a few threads suffice — extras just queue on the compute pool.
_READ_LANE_WORKERS = 4
_read_lane_pool: "ThreadPoolExecutor | None" = None
_read_lane_lock = threading.Lock()


def _read_lane_executor() -> "ThreadPoolExecutor":
    # Lazily built the first time an extract is dispatched. Guard the init: HTTP
    # executor threads for different sessions can reach here concurrently, and an
    # unlocked check-then-create would build (and orphan) two pools.
    global _read_lane_pool
    if _read_lane_pool is None:
        with _read_lane_lock:
            if _read_lane_pool is None:
                _read_lane_pool = ThreadPoolExecutor(max_workers=_READ_LANE_WORKERS,
                                                     thread_name_prefix="readlane")
    return _read_lane_pool


def _shallow_adata(adata):
    """A container-level copy of the active table that SHARES the underlying arrays but
    has independent obs/var/obsm/... containers. Compute commits only ever rebind
    container entries (`m[k] = v`, DESIGN §24), never mutate array contents in place, so
    this snapshot stays consistent while the live object keeps changing — safe to pickle
    to the compute pool for a read-only plot/extract even as a concurrent compute commits.
    (loky pickles args asynchronously on a feeder thread, so a read lock can't cover the
    pickle; a private snapshot is what makes it race-free.)"""
    import anndata as ad
    import pandas as pd
    snap = ad.AnnData(
        X=adata.X,
        obs=adata.obs.copy(deep=False), var=adata.var.copy(deep=False),
        obsm=dict(adata.obsm), varm=dict(adata.varm),
        obsp=dict(adata.obsp), varp=dict(adata.varp),
        layers=dict(adata.layers), uns=dict(adata.uns),
    )
    if adata.raw is not None:
        # .raw is never rebound by a commit, so share its arrays too (no data copy).
        snap.raw = ad.AnnData(X=adata.raw.X, var=adata.raw.var.copy(deep=False),
                              obs=pd.DataFrame(index=adata.obs_names))
    return snap


class _ReadSnapshot:
    """The read-only slice of the `session` surface a plot/extract `execute()` touches
    (active_table/sdata/active_image), backed by a shallow table snapshot. Read-lane jobs
    are adata-only, so sdata/image are None."""
    def __init__(self, adata):
        self._adata = adata
        self.sdata = None

    def active_table(self):
        return self._adata

    def active_image(self):
        return None


class Session:
    def __init__(self, sid, name, sdata, app_state, manager, parent_id=None, store_path=None,
                read_only=False):
        self.id = sid
        self.name = name
        self.sdata = sdata
        self.app_state = app_state
        self.manager = manager
        self.parent_id = parent_id
        self.store_path = store_path
        # True for a session opened frozen (create_from_load(read_only=True)): every
        # mutating route rejects it (main.py::_writable_session) so it stays a
        # read-only view of its checkpoint.
        self.read_only = read_only
        # True when the in-memory object matches its saved checkpoint: set on load
        # (matches the file it came from) and after every save; cleared by any
        # data/history mutation. Drives the "unsaved changes" indicator.
        self.saved = store_path is not None
        # Which parts of the object changed since the last save, so a save can rewrite
        # only those (see _write_checkpoint). `force_full` trips whenever a raster or
        # other non-table element changed, since those can't be updated incrementally.
        self.dirty_tables: set[str] = set()
        self.dirty_transforms: set[str] = set()
        self.force_full = False
        # Serializes checkpoint writes. Saves hold only the RWLock read lock (so data
        # reads can continue during a multi-GB zip), but an incremental save mutates
        # the backing store in place, and snapshot saves run off the serial worker (in
        # the FastAPI thread pool) — so two saves could otherwise clobber the store.
        self._save_lock = threading.Lock()
        self.extract_dir = None  # temp dir if loaded from a .zarr.zip; cleaned on close
        self.raster_cache_dir = None  # temp store of tile-normalized rasters; cleaned on close
        self.raster_stores: dict[str, str] = {}  # element name -> its {i}.zarr store dir in raster_cache_dir
        self.raster_cache_mb = 0.0  # on-disk size of raster_cache_dir; computed once at load, surfaced in resource_sample
        self.hash_check = None  # content-hash verification result when loaded from a hash-named checkpoint (store._hash_result)
        self.created_at = _now()
        self.status = "ready" if sdata is not None else "loading"
        self.error = None  # failure message when status == "errored"; surfaced in the session summary
        self.active_table_key = self._default_table_key()

        self.lock = RWLock()
        # Guards the job/history bookkeeping (`_jobs` and the app_state collections)
        # that the event-loop thread (endpoints) and the worker thread both touch, so
        # a cancel/dequeue claim is atomic and iteration never races a mutation. It is
        # only ever held for quick dict/list operations — never across an RWLock
        # acquire — so it cannot deadlock against the compute write lock.
        self._book = threading.Lock()
        self._queue: "queue.Queue" = queue.Queue()
        self._jobs = {}                 # job_id -> {kind, descriptor, status}
        self._failed_logs = {}          # job_id -> log (FAILED vanish from history; log still fetchable)
        # plot_id -> {"svg":bytes,"pdf":bytes,"png":bytes} for the plots THIS session
        # drew; `figure`/`figure_index` fall back to the ones a loaded checkpoint carries.
        self.plot_figures = {}
        self._stop = threading.Event()
        self._worker = threading.Thread(target=self._run, name=f"worker-{sid}", daemon=True)
        self._worker.start()

    # ---- object accessors -------------------------------------------------
    def _default_table_key(self):
        if self.sdata is None:
            return None
        keys = list(getattr(self.sdata, "tables", {}).keys())
        return keys[0] if keys else None

    def active_table(self):
        if self.sdata is None or self.active_table_key is None:
            raise RuntimeError("session has no table yet")
        return self.sdata.tables[self.active_table_key]

    def _table_field_paths(self) -> list[str]:
        """Every versioned field path of the active table (`obs:`, `obsm:`, `obsp:`,
        `layers:`, plus the coarse `X:` gene-expression marker) — the set to bump when
        the whole table is replaced at once (e.g. a reshaping compute like filter_cells,
        which also changes X for every remaining cell)."""
        ad = self.active_table()
        return ([f"obs:{c}" for c in ad.obs.columns] + [f"obsm:{k}" for k in ad.obsm]
                + [f"obsp:{k}" for k in ad.obsp] + [f"layers:{k}" for k in ad.layers] + ["X:"])

    def active_image(self):
        imgs = list(getattr(self.sdata, "images", {}).keys())
        return self.sdata.images[imgs[0]] if imgs else None

    def add_display(self, spec: dict) -> dict:
        """Append a display spec (assigning it an id) under the write lock, so displays
        are mutated on the same footing as every other app_state change rather than
        being spliced from the HTTP handler."""
        spec["id"] = str(uuid.uuid4())
        with self.lock.writing():
            self.app_state["displays"].append(spec)
        return spec

    def update_display(self, display_id: str, spec: dict) -> bool:
        """Replace the display identified by `display_id` under the write lock. Returns
        False if no such display exists."""
        with self.lock.writing():
            for i, d in enumerate(self.app_state["displays"]):
                if d["id"] == display_id:
                    spec["id"] = display_id
                    self.app_state["displays"][i] = spec
                    return True
        return False

    # ---- enqueue / staging (PENDING lifecycle, spec §5.4) -----------------
    def _collection(self, ec: str) -> list:
        return self.app_state["plots"] if ec == "plot" else self.app_state["compute_history"]

    def _make_record(self, descriptor: dict, entry_id: str, status: str):
        fn = self.manager.registry.get(f"{descriptor['namespace']}.{descriptor['function']}")
        ec = "plot" if (fn is not None and fn.effect_class == "plot") else "compute"
        rec = {"id": entry_id, "namespace": descriptor["namespace"], "function": descriptor["function"],
               "params": descriptor.get("params", {}), "status": status,
               "library_versions": self.manager.registry.library_versions}
        if ec == "plot":
            rec["references"] = self._references(descriptor.get("params", {}))
        else:
            rec["structural_diff"] = {}
        return ec, rec

    def _enqueue_job(self, entry_id: str, ec: str, descriptor: dict):
        self._jobs[entry_id] = {"kind": ec, "descriptor": descriptor, "status": "queued"}
        fn = self.manager.registry.get(f"{descriptor['namespace']}.{descriptor['function']}")
        if fn is not None and fn.read_lane:
            # Extract: run it concurrently on a table snapshot instead of behind the serial
            # mutation queue, so an extract of existing data doesn't wait out a running
            # compute (DESIGN §24). Plots stay on the queue (they persist uns colors).
            BUS.publish("job.queued", {"session_id": self.id, "job_id": entry_id,
                                       "descriptor": descriptor, "position": 0, "effect_class": ec})
            _read_lane_executor().submit(self._run_read_lane, entry_id, ec, descriptor)
            return
        self._queue.put((entry_id, ec, descriptor))
        BUS.publish("job.queued", {"session_id": self.id, "job_id": entry_id,
                                   "descriptor": descriptor, "position": self._queue.qsize(),
                                   "effect_class": ec})

    def _guard_reader_paths(self, descriptor: dict):
        """Containment-check a read-effect descriptor's paths before it is recorded.

        Session creation validates its own descriptor (manager.create_from_read), but a
        reader re-run on an already-open session is a supported flow (see the re-import
        note in _run_call) and arrives here instead — from /jobs, /jobs/stage,
        /recipe/run and the MCP run_function tool. Without this, any of those reads a
        store from outside DATA_DIR and adopts it into the session. Raises RuntimeError,
        which the routes map to 400."""
        fn = self.manager.registry.get(f"{descriptor['namespace']}.{descriptor['function']}")
        if fn is not None and fn.effect_class == "read":
            validate_reader_params(descriptor.get("params", {}))

    def enqueue_descriptor(self, descriptor: dict) -> str:
        """Run-now fast path: record + submit immediately. A failed job stays in
        history for the user to inspect or delete (audit-log model, DESIGN §6.1)."""
        self._guard_reader_paths(descriptor)
        entry_id = str(uuid.uuid4())
        ec, rec = self._make_record(descriptor, entry_id, "queued")
        self._collection(ec).append(rec)
        self._enqueue_job(entry_id, ec, descriptor)
        return entry_id

    def stage_descriptor(self, descriptor: dict) -> str:
        """Stage a PENDING step: visible + editable, not submitted (spec §5.4)."""
        self._guard_reader_paths(descriptor)
        entry_id = str(uuid.uuid4())
        ec, rec = self._make_record(descriptor, entry_id, "pending")
        self._collection(ec).append(rec)
        return entry_id

    def _descriptor_of(self, rec: dict) -> dict:
        return {"namespace": rec["namespace"], "function": rec["function"], "params": rec["params"]}

    def run_pending(self, entry_id: str) -> bool:
        for ec in ("compute", "plot"):
            rec = self._find_record(entry_id, ec)
            if rec and rec["status"] == "pending":
                rec["status"] = "queued"
                self._enqueue_job(entry_id, ec, self._descriptor_of(rec))
                return True
        return False

    def run_all_pending(self) -> int:
        n = 0
        for ec in ("compute", "plot"):
            for rec in list(self._collection(ec)):
                if rec["status"] == "pending" and self.run_pending(rec["id"]):
                    n += 1
        return n

    def edit_pending(self, entry_id: str, params: dict) -> bool:
        for ec in ("compute", "plot"):
            rec = self._find_record(entry_id, ec)
            if rec and rec["status"] == "pending":
                # Re-check: this rewrites the params run_pending will later execute, so
                # a staged step validated at stage time could otherwise be edited into
                # an out-of-root path.
                self._guard_reader_paths({**self._descriptor_of(rec), "params": params})
                rec["params"] = params
                if ec == "plot":
                    rec["references"] = self._references(params)
                return True
        return False

    def delete_entry(self, entry_id: str) -> bool:
        """Remove a history entry the user chose to delete (e.g. a kept failure).
        Queued/running entries can't be deleted; cancel them first."""
        for ec in ("compute", "plot"):
            coll = self._collection(ec)
            for i, rec in enumerate(coll):
                if rec["id"] == entry_id:
                    if rec.get("status") in ("queued", "running"):
                        return False
                    coll.pop(i)
                    self.plot_figures.pop(entry_id, None)
                    # Drop the worker-side bookkeeping too, or GET /jobs/{id} and
                    # /jobs/{id}/log keep answering for an entry the user deleted.
                    self._jobs.pop(entry_id, None)
                    self._failed_logs.pop(entry_id, None)
                    return True
        return False

    def enqueue_special(self, kind: str, payload: dict) -> str:
        job_id = str(uuid.uuid4())
        self._jobs[job_id] = {"kind": kind, "descriptor": payload, "status": "queued"}
        self._queue.put((job_id, kind, payload))
        BUS.publish("job.queued", {"session_id": self.id, "job_id": job_id,
                                   "descriptor": {"kind": kind}, "position": self._queue.qsize()})
        return job_id

    def enqueue_load(self, path: str, load_id: str | None = None,
                     adopt_name: bool = True) -> str:
        """Open a saved checkpoint as this session's first job (create_from_load). The
        unzip/read/re-tile is too slow to run inside the POST — a large store blows past a
        fronting proxy's origin timeout (a 504) — so it runs here on the worker and adopts
        the object under the write lock, exactly like a read bootstrap.

        `adopt_name` lets the checkpoint's own recorded name (`app_state["name"]`, see
        `rename`) replace the filename-derived one the shell was created with; the caller
        clears it when the user named this session explicitly."""
        return self.enqueue_special("load", {"path": path, "load_id": load_id,
                                             "adopt_name": adopt_name})

    def cancel(self, job_id: str) -> bool:
        """Cancel a QUEUED job only (RUNNING is non-interruptible, §6.1). Claims the
        job under _book so it can't race the worker's dequeue: the worker flips the
        same status to "running" under _book, so exactly one of cancel/run wins."""
        with self._book:
            job = self._jobs.get(job_id)
            if not job or job["status"] != "queued":
                return False
            job["status"] = "cancelled"  # worker skips cancelled entries
            self._drop_history(job_id, job.get("kind"))
        return True

    # ---- worker loop ------------------------------------------------------
    def _run(self):
        while not self._stop.is_set():
            try:
                job_id, kind, payload = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            # Claim the job atomically against cancel(): once it flips to "running"
            # here, a concurrent cancel() sees status != "queued" and refuses, so a
            # cancelled job can never still execute and mutate the object (§6.1 audit
            # model). The old check-then-run left a window where a job cancelled after
            # the check still ran while its history record was dropped.
            with self._book:
                job = self._jobs.get(job_id)
                if job is None or job["status"] == "cancelled":
                    continue
                job["status"] = "running"
            if not self.manager.admit_job(self):
                # Memory boundary hit at dequeue: hold the job (put it back) rather than
                # fail it — admit_job reports it as "held", and the pressure (often a
                # transient tile burst) usually clears in seconds. Reset to queued so it
                # retries and stays cancellable; back off so we don't spin.
                with self._book:
                    j = self._jobs.get(job_id)
                    if j is not None and j["status"] == "running":
                        j["status"] = "queued"
                        self._queue.put((job_id, kind, payload))
                self._stop.wait(self._MEMORY_HOLD_BACKOFF_S)
                continue
            try:
                self._dispatch(job_id, kind, payload)
            except Exception as e:  # a bookkeeping error must never kill the worker
                import traceback
                traceback.print_exc()
                self._fail(job_id, kind, str(e))

    def _dispatch(self, job_id, kind, payload):
        # The job's worker-record status was already claimed "running" under _book in
        # _run (the atomic point vs cancel); here just mirror it to the durable record.
        self._set_status(job_id, kind, "running")
        BUS.publish("job.started", {"session_id": self.id, "job_id": job_id})
        try:
            if kind in ("compute", "plot"):
                self._run_call(job_id, kind, payload)
            elif kind == "save":
                self._run_save(job_id, payload)
            elif kind == "subset":
                self._run_subset(job_id, payload)
            elif kind == "annotate":
                self._run_annotate(job_id, payload)
            elif kind == "shape_annotate":
                self._run_shape_annotate(job_id, payload)
            elif kind == "set_transform":
                self._run_set_transform(job_id, payload)
            elif kind == "load":
                self._run_load(job_id, payload)
        except Exception as e:  # worker must never die
            self._fail(job_id, kind, str(e))
        finally:
            self._prune_jobs()

    _TERMINAL_JOB_CAP = 200
    _MEMORY_HOLD_BACKOFF_S = 2.0  # pause before retrying a job held at the memory boundary

    def _prune_jobs(self):
        """Bound worker job bookkeeping. Queued/running entries are always kept; the
        durable record lives in app_state. Old terminal entries (and their logs) are
        dropped beyond a recent window."""
        terminal = [jid for jid, j in list(self._jobs.items())
                    if j["status"] in ("completed", "drawn", "failed", "cancelled")]
        if len(terminal) <= self._TERMINAL_JOB_CAP:
            return
        for jid in terminal[:-self._TERMINAL_JOB_CAP]:  # all but the most recent CAP
            self._jobs.pop(jid, None)
            self._failed_logs.pop(jid, None)

    def _adopt_rasters(self, known_stores, progress=None) -> None:
        """Re-tile the live object's images/labels and take ownership of the resulting
        cache dir. Shared by the three commit paths that can introduce or replace
        rasters: whole-object adoption, in-place images/labels facet merge, and
        checkpoint load.

        A reshaping op (e.g. filter_cells) returns a new object carrying the SAME
        already-tiled refs forward, so normalize_rasters finds them canonical and
        rebuilds nothing (new_cache is None). Those refs still stream lazily from the
        previous cache, so it must be KEPT — deleting it would leave every image a
        dangling ref that zarr fills with 0 (a black canvas, no error). Only when a
        genuinely fresh, non-canonical object is adopted does normalize build a new
        store, orphaning the previous cache; drop it only then. The store map is
        assigned unconditionally — normalize_rasters can return canonical-and-local
        entries even when it builds no new dir. `known_stores` is the element-name->
        store map trusted as already-local (callers empty it when identity can't be
        trusted); `progress` streams a lengthy rebuild's log when set."""
        from .. import rasters
        prev_cache = self.raster_cache_dir
        new_cache, new_stores = rasters.normalize_rasters(self.sdata, progress, known_stores=known_stores)
        self.raster_stores = new_stores
        if new_cache is not None:
            self.raster_cache_dir = new_cache
            self.raster_cache_mb = rasters.cache_size_mb(new_cache)
            # A PARTIAL rebuild is the common case for an in-place facet merge: only the
            # changed element moves into new_cache while the rest keep the store dir
            # normalize_rasters carried forward from `known_stores` — which is prev_cache.
            # Deleting it then dangles those refs into zarr fill values, i.e. the silent
            # black canvas described above, so keep it while anything still points inside.
            if prev_cache and prev_cache != new_cache and not any(
                    str(s) == prev_cache or str(s).startswith(prev_cache + os.sep)
                    for s in new_stores.values()):
                shutil.rmtree(prev_cache, ignore_errors=True)

    def _run_call(self, job_id, kind, descriptor):
        # kind is always "compute" or "plot" here (the only two _dispatch routes here).
        # The call itself (ADAPTER.execute) runs the compute in a subprocess and holds
        # NO lock: the child works on a pickled copy (registry/kernel.py), so the live
        # object is untouched for the whole — possibly minutes-long — compute. Reads
        # (session state, obs values, image tiles, arrow data) therefore keep serving
        # the last-committed object during a job instead of blocking on the write lock
        # for its entire duration (DESIGN §20.2). Only the commit below mutates the live
        # object, held under a brief write lock.
        # A read bootstrap can run for minutes; stream its log to the client live so the
        # import spinner shows progress (transport/livelog.py). Other jobs just buffer.
        fn = REGISTRY.get(f"{descriptor['namespace']}.{descriptor['function']}")
        target = (livelog.job_target(self.id, job_id)
                  if fn is not None and fn.effect_class == "read" else contextlib.nullcontext())
        with target:
            result = ADAPTER.execute(descriptor, self)

        if result.status == "failed":
            # A failed read bootstrap (no object ever adopted) leaves the session unusable.
            if self.sdata is None:
                self.status = "errored"
                self.error = result.error or "failed"
                self._publish_summary()
            self._fail(job_id, kind, result.error or "failed", log=result.log)
            return

        with self.lock.writing():
            if result.new_object is not None:
                new_object = result.new_object
                import anndata
                if isinstance(new_object, anndata.AnnData):
                    # Reflected read.* squidpy readers (visium/vizgen/nanostring) return
                    # a bare AnnData, which has no .tables: adopting it as-is leaves
                    # _default_table_key None and the session "ready" but silently dead.
                    # Wrap it here, at the single adoption point, so the raster-collision
                    # guard and everything downstream sees a SpatialData.
                    from spatialdata import SpatialData
                    new_object = SpatialData(tables={"table": new_object})
                # Adopt a returned object (read bootstrap / Edge B) under the write lock
                # so readers never see a new sdata with a stale table key.
                replaced = self.sdata is not None and self.sdata is not new_object
                if replaced:
                    from .. import imaging
                    imaging.evict_caches(self.sdata)  # old id() is about to be freed
                self.sdata = new_object
                self.force_full = True  # a freshly adopted object must be written whole once
                # A reader's images/labels can be single-scale or huge-chunked; tile
                # them now so the canvas never realizes a multi-GB chunk per tile.
                # known_stores is keyed by element NAME, not dataset identity, so it's
                # only trustworthy on a same-object reshape: a genuine re-import (a
                # read-effect function re-run on an already-open session,
                # registry/custom/read_spatialdata.py) can hand back a fresh dataset
                # that happens to reuse a conventional image name, which would otherwise
                # be wrongly treated as "already known local" — leaving raster_stores[name]
                # pointing at the PREVIOUS dataset's cache dir. Force a from-scratch
                # locality check for that case by passing no prior knowledge at all.
                is_reimport = fn is not None and fn.effect_class == "read"
                known_stores = {} if is_reimport else self.raster_stores
                # A read bootstrap's rebuild can be lengthy (multi-GB); stream its
                # progress over the same job.log channel `target` above already taps,
                # so the import spinner keeps moving during this (write-lock-held) rebuild.
                progress = ((lambda message, pct=None: BUS.publish(
                    "job.log", {"session_id": self.id, "job_id": job_id, "chunk": f"{message}\n"}))
                            if is_reimport else None)
                self._adopt_rasters(known_stores, progress)
                self.active_table_key = self._default_table_key()
                if not self.app_state["displays"]:
                    self.manager.auto_displays(self)
                self.status = "ready"  # the read bootstrap adopted the object
                self.error = None
                self._publish_summary()
                # Replacing the live object mid-session (e.g. sc.pp.filter_cells adopted
                # whole, §4.6) changed every field: the row-count differs, so any cached
                # canvas array is now stale. The facet diff can't express a wholesale
                # swap, so bump every field path of the new table explicitly, letting the
                # canvas refetch and dependent plots invalidate.
                if replaced and not result.changed_fields:
                    result.changed_fields = self._table_field_paths()
            else:
                # The common compute/plot path: write the child's changed facets back
                # onto the live object. This is the only live-object mutation here, so it
                # alone needs the write lock.
                from ..registry import kernel
                if result.changed_facets:
                    kernel.apply_changed_facets(self.active_table(), self.sdata, result.changed_facets)
                    if "images" in result.changed_facets or "labels" in result.changed_facets:
                        # A compute that wrote an images/labels facet in place (mutating
                        # facets without reshaping the table, so it never reaches the
                        # new_object branch above) still needs tile-chunking, or it
                        # reproduces the multi-GB-chunk-per-tile OOM rasters.py exists
                        # to prevent, and the new element never gets a raster_stores
                        # entry. An ordinary in-session mutation, never a re-import, so
                        # the existing known_stores map is always trusted.
                        self._adopt_rasters(self.raster_stores)
                        # imaging's chunk/norm caches key on (id(sdata), element, ...),
                        # and an in-place facet merge keeps the same object identity —
                        # so without an eviction, raster_store would keep serving
                        # pre-compute chunk bytes under the new ETag and thumbnails
                        # would keep the stale channel norm.
                        from .. import imaging
                        imaging.evict_caches(self.sdata)

        self.saved = False  # a completed compute/plot changed the object or its cached state

        if kind == "plot":
            # A plot mutates nothing but may cache uns['<col>_colors'] on the active
            # table (see the write-lock note above), so that element is now dirty.
            if self.active_table_key:
                self.dirty_tables.add(self.active_table_key)
            self.plot_figures[job_id] = {"svg": result.figure_svg, "pdf": result.figure_pdf,
                                         "png": result.figure_png}
            self._set_status(job_id, kind, "drawn", log=result.log)
            BUS.publish("plot.drawn", {"session_id": self.id, "plot_id": job_id})
            BUS.publish("job.completed", {"session_id": self.id, "job_id": job_id, "kind": "plot",
                                          "plot_id": job_id, "data_versions": self.app_state["data_versions"]})
            return

        # compute
        self._set_status(job_id, kind, "completed", structural_diff=result.structural_diff, log=result.log)
        self._mark_dirty(result.structural_diff)
        appstate.bump_versions(self.app_state, result.changed_fields)
        invalidated = self._invalidate_plots(result.changed_fields)
        BUS.publish("job.completed", {"session_id": self.id, "job_id": job_id, "kind": "compute",
                                      "structural_diff": result.structural_diff,
                                      "data_versions": self.app_state["data_versions"]})
        if invalidated:
            BUS.publish("plot.invalidated", {"session_id": self.id, "plot_ids": invalidated})

    def _run_read_lane(self, job_id, ec, descriptor):
        """Run an extract concurrently on a shallow snapshot of the active table, off the
        serial worker (DESIGN §24). An extract reads a value out of the object (e.g.
        `sc.get.*`) and writes nothing back, so it never needs the mutation queue. Claims
        the job against cancel() like `_run`, snapshots under a brief read lock, then runs
        the call in the compute pool with NO lock held — the snapshot is private, so a
        concurrent compute commit can't corrupt its async pickle."""
        with self._book:
            job = self._jobs.get(job_id)
            if job is None or job["status"] == "cancelled":
                return
            job["status"] = "running"
        self._set_status(job_id, ec, "running")
        BUS.publish("job.started", {"session_id": self.id, "job_id": job_id})
        try:
            with self.lock.reading():
                snapshot = _ReadSnapshot(_shallow_adata(self.active_table()))
            result = ADAPTER.execute(descriptor, snapshot)  # runs in the compute pool, no lock held
            if result.status == "failed":
                self._fail(job_id, ec, result.error or "failed", log=result.log)
                return
            # Read-only: the extract's value is not written back to the live object.
            self._set_status(job_id, ec, "completed", log=result.log)
            BUS.publish("job.completed", {"session_id": self.id, "job_id": job_id, "kind": "compute",
                                          "structural_diff": {}, "data_versions": self.app_state["data_versions"]})
        except Exception as e:  # a read-lane failure must never take down the pool thread
            self._fail(job_id, ec, str(e))
        finally:
            self._prune_jobs()

    def _commit_field_changes(self, job_id, kind, changed, *, invalidate: bool = False) -> None:
        """Shared post-write bookkeeping for the annotate handlers: group changed field
        paths (`elem:key`) into a structural diff, mark dirty, bump versions, optionally
        invalidate dependent plots, and publish `job.completed`."""
        self.saved = False
        self._jobs[job_id]["status"] = "completed"
        diff: dict = {}
        for f in changed:
            elem, key = f.split(":", 1)
            diff.setdefault(elem, []).append(key)
        self._mark_dirty(diff)
        appstate.bump_versions(self.app_state, changed)
        invalidated = self._invalidate_plots(changed) if invalidate else []
        BUS.publish("job.completed", {"session_id": self.id, "job_id": job_id, "kind": kind,
                                      "structural_diff": diff,
                                      "data_versions": self.app_state["data_versions"]})
        if invalidated:
            BUS.publish("plot.invalidated", {"session_id": self.id, "plot_ids": invalidated})

    def _run_annotate(self, job_id, payload):
        """Region labeling: mutate obs/shapes in place under the write lock (§3.1)."""
        from . import regions
        with self.lock.writing():
            changed = regions.assign(self, payload)
        self._commit_field_changes(job_id, "annotate", changed, invalidate=True)

    def _run_shape_annotate(self, job_id, payload):
        """Shape-annotation editor: create/update/delete one shape in
        `sdata.shapes["annotations"]` in place, under the write lock."""
        from . import shape_annotations
        op = payload.get("op", "create")
        with self.lock.writing():
            if op == "update":
                changed = shape_annotations.update(self, payload["shape_id"], payload["shape"])
            elif op == "delete":
                changed = shape_annotations.delete(self, payload["shape_id"])
            else:
                changed = shape_annotations.create(self, payload["shape"])
        # A shapes element can't be updated incrementally (see _mark_dirty), so this
        # always forces a full save — fine since annotation counts are small relative
        # to a full checkpoint. Shape edits drive no plots, so no invalidation pass.
        self._commit_field_changes(job_id, "shape_annotate", changed)

    def _mark_dirty(self, structural_diff: dict) -> None:
        """Record which elements a data mutation touched so the next save rewrites only
        those. The mutation ran on the active table, so mark it unconditionally — an
        in-place `X`-only change is tracked only coarsely (`keyset` snapshots `X` by
        whole-matrix identity and `diff` deliberately keeps it out of the structural
        diff), and the active table is cheap to rewrite regardless. The diff is used to
        catch OTHER changed table elements (`tables` facet) and to force a full save
        when a raster or geometry element changed (those can't be updated in place)."""
        from ..registry.base import is_table_facet
        if self.active_table_key:
            self.dirty_tables.add(self.active_table_key)
        for facet, keys in structural_diff.items():
            if facet == "tables":
                self.dirty_tables.update(keys)
            elif not is_table_facet(facet):
                self.force_full = True

    def _clear_dirty(self) -> None:
        self.dirty_tables.clear()
        self.dirty_transforms.clear()
        self.force_full = False

    def _write_checkpoint(self, path: str, hash_name: bool,
                          include: dict[str, list[str]] | None = None,
                          levels: dict[str, int] | None = None,
                          figures: dict[str, dict[str, bytes]] | None = None) -> str:
        """Persist the object to `path`, incrementally when possible: rewrite only the
        changed table/transform elements (reusing the on-disk rasters untouched) when
        the session is still backed by the writable directory store it loaded from and
        no raster changed; otherwise re-serialize the whole object. The caller holds
        the read lock and updates saved-state after this returns.

        `include` writes only the named elements, `levels` writes named images at
        reduced resolution. Both short-circuit above the incremental branch because
        `update_checkpoint` reuses the on-disk rasters wholesale, which would put back
        exactly the elements and pyramid levels the caller asked to drop.

        `figures` is the complete set of rendered plots to end up in the file (see
        `figures_to_persist`) — on both routes, whatever it omits is not in the file."""
        from ..persistence.store import (save_spatialdata, update_checkpoint,
                                          can_update_incrementally)
        with self._save_lock:
            if (include is None and not levels and path.endswith(".zarr.zip")
                    and not self.force_full
                    and can_update_incrementally(self.sdata, self.extract_dir)):
                self._hold_dropped_figures(figures or {})
                return update_checkpoint(self.sdata, path, self.app_state,
                                         tables=self.dirty_tables, transforms=self.dirty_transforms,
                                         hash_name=hash_name, figures=figures)
            return save_spatialdata(self.sdata, path, self.app_state, hash_name=hash_name,
                                    include=include, levels=levels, figures=figures)

    def _hold_dropped_figures(self, keeping: dict[str, dict[str, bytes]]) -> None:
        """Read into memory any drawn plot's figure that the incremental save is about to
        prune from the store — that store is `extract_dir`, which this session also reads
        its figures through. Deselecting a figure changes what the FILE carries, not what
        the open session can still show."""
        from ..persistence.store import figure_index, read_figure
        drawn = self.drawn_plot_ids()
        for pid, sizes in figure_index(self.extract_dir).items():
            if pid in keeping or pid not in drawn:
                continue
            held = self.plot_figures.setdefault(pid, {})
            for fmt in sizes:
                if held.get(fmt) is None:
                    held[fmt] = read_figure(self.extract_dir, pid, fmt)

    def _save_and_finish(self, job_id: str, payload: dict, kind: str,
                         bump_fields: list | None = None) -> None:
        """Shared completion tail for the checkpoint-writing jobs (save, set_transform):
        validate the target path, write the checkpoint under the read lock (data reads
        keep flowing during a multi-GB zip), then flip the saved-state bookkeeping and
        publish the job's terminal event."""
        target = Path(payload["path"]).resolve()
        if not within_data_dir(target):
            raise ValueError("save path is outside the data directory")
        include, levels = payload.get("include"), payload.get("levels")
        with self.lock.reading():
            written = self._write_checkpoint(payload["path"], payload.get("hash_name", False),
                                             include=include, levels=levels,
                                             figures=self.figures_to_persist(payload.get("figures")))
        # A filtered write is an export, not this session's checkpoint: the object still
        # holds elements — or pyramid levels — the file doesn't contain, so adopting it
        # as `store_path` and calling the session saved would both be false.
        if include is None and not levels:
            self.store_path = written
            self.saved = True
            self._clear_dirty()
        self._jobs[job_id]["status"] = "completed"
        if bump_fields:
            appstate.bump_versions(self.app_state, bump_fields)
        BUS.publish("job.completed", {"session_id": self.id, "job_id": job_id, "kind": kind,
                                      "path": written,
                                      "data_versions": self.app_state["data_versions"]})

    def _run_set_transform(self, job_id, payload):
        """Set the points->global transform on the active table's region element and
        persist to disk so it survives a session restart (§3.1 mutating job)."""
        from . import transform
        with self.lock.writing():
            region = transform.set_affine6(self.sdata, self.active_table(), payload["affine"])
        if region:
            self.dirty_transforms.add(region)
        self._save_and_finish(job_id, payload, "set_transform", bump_fields=["obsm:spatial"])

    def _run_save(self, job_id, payload):
        name = payload.get("name")
        # Also renames when only `app_state` lacks the name: a session that has never
        # been renamed still needs it recorded, or a file saved under a different prefix
        # would reopen named after that prefix.
        if name and (name != self.name or name != self.app_state.get("name")):
            self.rename(name)
        self._save_and_finish(job_id, payload, "save")

    def rename(self, name: str) -> None:
        """Adopt a new display name for the session, recording it in `app_state` so the
        checkpoint carries it (`_run_load` reads it back). The filename is only a storage
        name — a save can write the same session under any prefix, or into a folder of
        many — so the name a reload shows has to travel inside the object.

        Runs on the worker as the first step of the save job, so the name in the file is
        the name the header ends up showing, and a save that fails to even start leaves
        the session named as it was."""
        with self.lock.writing():
            self.name = name
            self.app_state["name"] = name
        self.saved = False  # on disk the checkpoint still carries the old name
        self._publish_summary()

    def _run_subset(self, job_id, payload):
        # No lock held here: perform_subset reads self.sdata under its own read lock
        # and then ends by closing this session, which acquires the write lock. Holding
        # either lock across that whole call would self-deadlock (this IS that call's
        # worker thread; the RWLock isn't reentrant for the thread that already holds it).
        child = self.manager.perform_subset(self, payload)
        self._jobs[job_id]["status"] = "completed"
        BUS.publish("job.completed", {"session_id": self.id, "job_id": job_id, "kind": "subset",
                                      "child_id": child.id, "data_versions": self.app_state["data_versions"]})

    def _run_load(self, job_id, payload):
        """Open a saved checkpoint on the worker: unzip/read the archive and re-tile its
        rasters (both slow for a large Xenium store), then adopt the object under the
        write lock — the async analogue of the read-bootstrap adoption in _run_call. The
        POST that created this session already returned a `loading` shell, so progress and
        the terminal result stream over `session.loading`, keyed by the client-minted
        `load_id`; the checkpoint's own app_state replaces the shell's fresh one."""
        from ..persistence.store import load_spatialdata
        load_id = payload.get("load_id")

        def report(message, pct=None):
            if load_id:
                BUS.publish("session.loading", {"load_id": load_id, "message": message, "pct": pct})

        try:
            with livelog.forward_load_logs(load_id):
                sdata, app_state, newer, extract_dir, hash_check = load_spatialdata(payload["path"], report)
            with self.lock.writing():
                self.sdata = sdata
                self.app_state = app_state
                self.extract_dir = extract_dir
                self.hash_check = hash_check
                # The file's own name (set by a save that renamed the session) beats the
                # one derived from its filename — the two differ whenever the save used a
                # different prefix. An explicitly named session keeps the caller's name.
                if payload.get("adopt_name") and app_state.get("name"):
                    self.name = app_state["name"]
                # Older stores hold huge-chunked rasters; re-tile them so canvas tiles
                # stay cheap (a no-op for stores already in canonical form). See rasters.py.
                self._adopt_rasters(self.raster_stores, report)
                self.active_table_key = self._default_table_key()
                report("Building views…")
                if not self.app_state["displays"]:
                    self.manager.auto_displays(self)
                self.status = "ready"
                self.error = None
                self._publish_summary()
        except Exception as e:
            # Handle the failure here rather than letting it propagate to _dispatch: the
            # New Session dialog follows the load over `session.loading` (keyed by load_id),
            # not job.failed, so it needs the terminal event to surface the error.
            self.status = "errored"
            self.error = str(e)
            self._publish_summary()
            self._fail(job_id, "load", str(e))
            if load_id:
                BUS.publish("session.loading", {"load_id": load_id, "done": True,
                                                "status": "errored", "error": str(e)})
            return
        self.saved = True  # the in-memory object matches the checkpoint it was loaded from
        self._jobs[job_id]["status"] = "completed"
        if newer:
            BUS.publish("memory.warning", {"session_id": self.id,
                        "message": "app_state schema newer than app; opened read-only"})
        if load_id:
            BUS.publish("session.loading", {"load_id": load_id, "done": True, "status": "ready",
                                            "hash_check": hash_check, "message": "Ready"})

    # ---- status bookkeeping ----------------------------------------------
    def _publish_summary(self) -> None:
        """Re-publish this session's list summary after a status transition
        (loading -> ready/errored). The sessions list (GET /api/sessions) has no
        other live refresh path — it is not polled — so without this its row stays
        stuck on the initial loading status until a manual page reload."""
        BUS.publish("session.updated", {"session_id": self.id, "summary": self.manager.summary(self)})

    def _set_status(self, job_id, kind, status, structural_diff=None, log=None):
        self._jobs[job_id]["status"] = status
        rec = self._find_record(job_id, kind)
        if rec is None:
            return
        rec["status"] = status
        if status == "running":
            rec["started_at"] = _now()
        if status in ("completed", "drawn"):
            rec["finished_at"] = _now()
        if structural_diff is not None:
            rec["structural_diff"] = structural_diff
        if log is not None:
            rec["_log"] = log

    def _find_record(self, job_id, kind):
        coll = self.app_state["plots"] if kind == "plot" else self.app_state["compute_history"]
        for r in list(coll):  # snapshot: the event-loop thread may append concurrently
            if r["id"] == job_id:
                return r
        return None

    def find_record(self, job_id: str) -> dict | None:
        """Look up a job's durable history record in either collection. Public wrapper
        over `_find_record` for callers outside this package (e.g. the MCP surface),
        mirroring the is_table_facet precedent in registry/base.py."""
        for kind in ("compute", "plot"):
            rec = self._find_record(job_id, kind)
            if rec is not None:
                return rec
        return None

    def _fail(self, job_id, kind, error, log=""):
        self._jobs[job_id]["status"] = "failed"
        self._failed_logs[job_id] = log or error
        # Failed compute/plot jobs stay in history for the user to inspect or delete
        # (audit-log model, DESIGN §6.1); mark the durable record failed.
        if kind in ("compute", "plot"):
            rec = self._find_record(job_id, kind)
            if rec:
                rec["status"] = "failed"
                rec["_log"] = log or error
        descriptor = self._jobs.get(job_id, {}).get("descriptor") or {}
        source = f"{descriptor['namespace']}.{descriptor['function']}" if "function" in descriptor else kind
        BUS.publish("job.failed", {"session_id": self.id, "job_id": job_id, "kind": kind,
                                   "error": error, "source": source, "timestamp": time.strftime("%H:%M:%S")})

    def _drop_history(self, job_id, kind="compute"):
        """Cancelling a queued job (or dropping a not-kept failure) must remove its
        record from whichever collection it actually lives in — a plot job's record
        is in app_state["plots"], not compute_history, and redraw_plot/delete_entry
        both refuse queued/running records, so a plot left there is stuck forever."""
        coll_key = "plots" if kind == "plot" else "compute_history"
        # Mutate the list in place instead of rebinding app_state[coll_key]: enqueue_
        # descriptor/stage_descriptor append from the event-loop thread without _book, so
        # a rebind concurrent with a submit drops the just-appended record — the job still
        # runs, but _set_status/_find_record no longer see it and the row the frontend
        # added from `job.queued` never reaches a terminal status.
        coll = self.app_state[coll_key]
        coll[:] = [r for r in coll if r["id"] != job_id]

    def _references(self, params: dict) -> list:
        refs = []
        try:
            ad = self.active_table()
        except RuntimeError:
            return refs
        for v in list(params.values()):
            for item in (v if isinstance(v, list) else [v]):
                if not isinstance(item, str):
                    continue
                if item in ad.obs.columns:
                    refs.append(f"obs:{item}")
                elif item in ad.var_names:
                    refs.append(f"X:{item}")
        return refs

    def _invalidate_plots(self, changed_fields) -> list:
        changed = set(changed_fields)
        invalidated = []
        for p in list(self.app_state["plots"]):
            if p["status"] == "drawn" and set(p.get("references", [])) & changed:
                p["status"] = "invalidated"
                invalidated.append(p["id"])
        return invalidated

    def figure(self, plot_id: str, fmt: str) -> bytes | None:
        """One rendered figure's bytes: this session's own render when it drew the plot,
        otherwise the copy the checkpoint it was loaded from carries (read lazily, like
        `get_log`). None when neither has it."""
        blob = (self.plot_figures.get(plot_id) or {}).get(fmt)
        if blob is not None:
            return blob
        from ..persistence.store import read_figure
        return read_figure(self.extract_dir or self.store_path, plot_id, fmt)

    def drawn_plot_ids(self) -> set[str]:
        """The ids of the plots currently `drawn` — the set every figure path filters on
        (figure_index, _hold_dropped_figures, the save route's figure validation). An
        `invalidated` plot's bytes still exist but no longer match the data."""
        return {p["id"] for p in self.app_state["plots"] if p["status"] == "drawn"}

    def figure_index(self) -> dict[str, dict[str, int]]:
        """`{plot_id: {format: byte length}}` over the figures this session can serve —
        what the save dialog sizes its figures group from and what tells a client which
        plots the Plots view can render. A redrawn plot's in-memory bytes shadow the
        stale ones still in the store it was loaded from.

        Only `drawn` plots appear. The bytes of an invalidated one are still around (in
        memory, or in the store), but they no longer match the data — reporting them
        would put a stale figure on screen instead of the redraw prompt."""
        from ..persistence.store import figure_index
        drawn = self.drawn_plot_ids()
        # dict(...) first: the worker inserts into plot_figures after releasing the write
        # lock (_run_call's plot tail), so a caller's read lock does NOT exclude it and
        # iterating the live dict raises "dictionary changed size during iteration" when a
        # plot lands mid-poll — the same hazard manager.state snapshots its lists against.
        index = {pid: {fmt: len(blob) for fmt, blob in blobs.items() if blob}
                 for pid, blobs in dict(self.plot_figures).items() if pid in drawn}
        for pid, sizes in figure_index(self.extract_dir or self.store_path).items():
            if pid in drawn:
                index.setdefault(pid, sizes)
        return {pid: sizes for pid, sizes in index.items() if sizes}

    def figures_to_persist(self, keep: list[str] | None = None) -> dict[str, dict[str, bytes]]:
        """Figure bytes for the checkpoint writer: every plot currently `drawn`, or just
        those in `keep` (the save dialog's selection). An `invalidated` plot is left out
        — its figure no longer matches the data, which is the whole meaning of the
        status."""
        from ..persistence.store import FIGURE_FORMATS
        wanted = None if keep is None else set(keep)
        out: dict[str, dict[str, bytes]] = {}
        for rec in self.app_state["plots"]:
            pid = rec["id"]
            if rec["status"] != "drawn" or (wanted is not None and pid not in wanted):
                continue
            # A plot whose render produced only some formats (a backend that couldn't
            # emit PDF, say) persists the ones it has.
            blobs = {fmt: blob for fmt in FIGURE_FORMATS
                     if (blob := self.figure(pid, fmt))}
            if blobs:
                out[pid] = blobs
        return out

    def redraw_plot(self, plot_id: str) -> bool:
        rec = self._find_record(plot_id, "plot")
        if not rec or rec["status"] not in ("invalidated", "failed", "drawn"):
            return False
        descriptor = {"namespace": rec["namespace"], "function": rec["function"], "params": rec["params"]}
        # redraw reuses the SAME plot id so the figure cache key stays stable
        rec["status"] = "queued"
        self._enqueue_job(plot_id, "plot", descriptor)  # read-lane or serial, per the fn
        return True

    def job_status(self, job_id: str):
        job = self._jobs.get(job_id)
        return job["status"] if job else None

    def job_ids(self) -> list[str]:
        """Ids of every job in the bookkeeping table, whatever its status
        (`queue_view` shows only queued/running). Public for callers outside this
        package — the MCP surface reads an errored load's job id to fetch its log
        tail — mirroring `find_record`."""
        return list(self._jobs)

    def get_log(self, job_id: str):
        for kind in ("compute", "plot"):
            rec = self._find_record(job_id, kind)
            if rec is None:
                continue
            if "_log" in rec:
                return rec["_log"], rec["status"]
            # Reloaded checkpoint: the log was relocated out of app_state into the
            # store's logs/ (see persistence.store); read it back lazily.
            from ..persistence.store import read_log
            log = read_log(self.extract_dir or self.store_path, job_id)
            if log is not None:
                return log, rec["status"]
        if job_id in self._failed_logs:
            return self._failed_logs[job_id], "failed"
        return None, None

    def queue_view(self) -> list:
        return [{"job_id": jid, "status": j["status"], "kind": j["kind"]}
                for jid, j in list(self._jobs.items()) if j["status"] in ("queued", "running")]

    def shutdown(self):
        self._stop.set()
