"""A session = one in-memory SpatialData + one FIFO queue + one worker thread +
its attrs state (DESIGN §11.1). Compute mutates in place; the queue is strictly
serial (§6.2). A read/write lock keeps async data serving off a half-mutated
object (§20.2).
"""
import contextlib
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
from ..transport import livelog
from ..transport.sse import BUS


class RWLock:
    """Many readers OR one writer (DESIGN §20.2)."""
    def __init__(self):
        self._cond = threading.Condition()
        self._readers = 0
        self._writer = False

    def acquire_read(self, timeout=None):
        """Block until the write lock is free, then register a reader. With `timeout`
        (seconds), give up and return False if a writer still holds the lock when it
        elapses; return True once the read lock is held."""
        with self._cond:
            if timeout is None:
                while self._writer:
                    self._cond.wait()
            else:
                deadline = time.monotonic() + timeout
                while self._writer:
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
            while self._writer or self._readers > 0:
                self._cond.wait()
            self._writer = True

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
        # True for a session opened read-only from a snapshot (create_from_snapshot):
        # every mutating route rejects it (main.py::_writable_session) so a snapshot
        # stays a frozen record of its checkpoint at the pinned view.
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
        self.active_table_key = self._default_table_key()

        self.lock = RWLock()
        # Guards the job/history bookkeeping (`_jobs` and the app_state collections)
        # that the event-loop thread (endpoints) and the worker thread both touch, so
        # a cancel/dequeue claim is atomic and iteration never races a mutation. It is
        # only ever held for quick dict/list operations — never across an RWLock
        # acquire — so it cannot deadlock against the compute write lock.
        self._book = threading.Lock()
        self._queue: "queue.Queue" = queue.Queue()
        self._jobs = {}                 # job_id -> {descriptor, status, kind, started}
        self._failed_logs = {}          # job_id -> log (FAILED vanish from history; log still fetchable)
        self.plot_figures = {}          # plot_id -> {"svg":bytes,"pdf":bytes} (never persisted)
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
        `layers:`) — the set to bump when the whole table is replaced at once."""
        ad = self.active_table()
        return ([f"obs:{c}" for c in ad.obs.columns] + [f"obsm:{k}" for k in ad.obsm]
                + [f"obsp:{k}" for k in ad.obsp] + [f"layers:{k}" for k in ad.layers])

    def active_image(self):
        imgs = list(getattr(self.sdata, "images", {}).keys())
        return self.sdata.images[imgs[0]] if imgs else None

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

    def enqueue_descriptor(self, descriptor: dict) -> str:
        """Run-now fast path: record + submit immediately. A failed job stays in
        history for the user to inspect or delete (audit-log model, DESIGN §6.1)."""
        entry_id = str(uuid.uuid4())
        ec, rec = self._make_record(descriptor, entry_id, "queued")
        self._collection(ec).append(rec)
        self._enqueue_job(entry_id, ec, descriptor)
        return entry_id

    def stage_descriptor(self, descriptor: dict) -> str:
        """Stage a PENDING step: visible + editable, not submitted (spec §5.4)."""
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
                     pinned_view: dict | None = None) -> str:
        """Open a saved checkpoint as this session's first job (create_from_load). The
        unzip/read/re-tile is too slow to run inside the POST — a large store blows past a
        fronting proxy's origin timeout (a 504) — so it runs here on the worker and adopts
        the object under the write lock, exactly like a read bootstrap. `pinned_view`
        (a saved snapshot's table/kind/encoding/viewport) makes `_run_load` build the
        session's one display straight from it instead of the auto-generated default —
        see `SessionManager.create_from_snapshot`."""
        return self.enqueue_special("load", {"path": path, "load_id": load_id,
                                             "pinned_view": pinned_view})

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
        started = time.time()
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
            self._jobs.get(job_id, {}).pop("started", None)
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
            self._fail(job_id, kind, result.error or "failed", log=result.log)
            return

        with self.lock.writing():
            if result.new_object is not None:
                # Adopt a returned object (read bootstrap / Edge B) under the write lock
                # so readers never see a new sdata with a stale table key.
                replaced = self.sdata is not None and self.sdata is not result.new_object
                if replaced:
                    from .. import imaging
                    imaging.evict_caches(self.sdata)  # old id() is about to be freed
                self.sdata = result.new_object
                self.force_full = True  # a freshly adopted object must be written whole once
                # A reader's images/labels can be single-scale or huge-chunked; tile
                # them now so the canvas never realizes a multi-GB chunk per tile.
                from .. import rasters
                # A reshaping op (e.g. filter_cells) returns a new object that carries the
                # SAME already-tiled image/label refs forward, so normalize_rasters finds
                # them canonical and rebuilds nothing (returns None). Those refs still stream
                # lazily from prev_cache, so it must be KEPT — deleting it would leave every
                # image a dangling ref that zarr fills with 0 (a black canvas, no error). Only
                # when a genuinely fresh, non-canonical object is adopted (a reader bootstrap)
                # does normalize build a new store, orphaning prev_cache; drop it only then.
                prev_cache = self.raster_cache_dir
                new_cache, new_stores = rasters.normalize_rasters(self.sdata)
                if new_cache is not None:
                    self.raster_cache_dir, self.raster_stores = new_cache, new_stores
                    self.raster_cache_mb = rasters.cache_size_mb(new_cache)
                    if prev_cache and prev_cache != new_cache:
                        shutil.rmtree(prev_cache, ignore_errors=True)
                self.active_table_key = self._default_table_key()
                if not self.app_state["displays"]:
                    self.manager.auto_displays(self)
                self.status = "ready"  # the read bootstrap adopted the object
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

        self.saved = False  # a completed compute/plot changed the object or its cached state

        if kind == "plot":
            # A plot mutates nothing but may cache uns['<col>_colors'] on the active
            # table (see the write-lock note above), so that element is now dirty.
            if self.active_table_key:
                self.dirty_tables.add(self.active_table_key)
            self.plot_figures[job_id] = {"svg": result.figure_svg, "pdf": result.figure_pdf}
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

    def _run_annotate(self, job_id, payload):
        """Region labeling: mutate obs/shapes in place under the write lock (§3.1)."""
        from . import regions
        with self.lock.writing():
            changed = regions.assign(self, payload)
        self.saved = False
        self._jobs[job_id]["status"] = "completed"
        diff: dict = {}
        for f in changed:
            elem, key = f.split(":", 1)
            diff.setdefault(elem, []).append(key)
        self._mark_dirty(diff)
        appstate.bump_versions(self.app_state, changed)
        invalidated = self._invalidate_plots(changed)
        BUS.publish("job.completed", {"session_id": self.id, "job_id": job_id, "kind": "annotate",
                                      "structural_diff": diff,
                                      "data_versions": self.app_state["data_versions"]})
        if invalidated:
            BUS.publish("plot.invalidated", {"session_id": self.id, "plot_ids": invalidated})

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
        self.saved = False
        self._jobs[job_id]["status"] = "completed"
        diff: dict = {}
        for f in changed:
            elem, key = f.split(":", 1)
            diff.setdefault(elem, []).append(key)
        # A shapes element can't be updated incrementally (see _mark_dirty below),
        # so this always forces a full save — acceptable since annotation counts
        # are small relative to a full checkpoint.
        self._mark_dirty(diff)
        appstate.bump_versions(self.app_state, changed)
        BUS.publish("job.completed", {"session_id": self.id, "job_id": job_id, "kind": "shape_annotate",
                                      "structural_diff": diff,
                                      "data_versions": self.app_state["data_versions"]})

    def _mark_dirty(self, structural_diff: dict) -> None:
        """Record which elements a data mutation touched so the next save rewrites only
        those. The mutation ran on the active table, so mark it unconditionally — the
        structural diff can't see an in-place `X`-only change (`keyset` doesn't track
        `X`), and the active table is cheap to rewrite regardless. The diff is used to
        catch OTHER changed table elements (`tables` facet) and to force a full save
        when a raster or geometry element changed (those can't be updated in place)."""
        from ..registry.base import _TABLE_FACETS
        if self.active_table_key:
            self.dirty_tables.add(self.active_table_key)
        for facet, keys in structural_diff.items():
            if facet == "tables":
                self.dirty_tables.update(keys)
            elif facet not in _TABLE_FACETS:
                self.force_full = True

    def _clear_dirty(self) -> None:
        self.dirty_tables.clear()
        self.dirty_transforms.clear()
        self.force_full = False

    def _write_checkpoint(self, path: str, hash_name: bool) -> str:
        """Persist the object to `path`, incrementally when possible: rewrite only the
        changed table/transform elements (reusing the on-disk rasters untouched) when
        the session is still backed by the writable directory store it loaded from and
        no raster changed; otherwise re-serialize the whole object. The caller holds
        the read lock and updates saved-state after this returns."""
        from ..persistence.store import (save_spatialdata, update_checkpoint,
                                          can_update_incrementally)
        with self._save_lock:
            if (path.endswith(".zarr.zip") and not self.force_full
                    and can_update_incrementally(self.sdata, self.extract_dir)):
                return update_checkpoint(self.sdata, path, self.app_state,
                                         tables=self.dirty_tables, transforms=self.dirty_transforms,
                                         hash_name=hash_name)
            return save_spatialdata(self.sdata, path, self.app_state, hash_name=hash_name)

    def _run_set_transform(self, job_id, payload):
        """Set the points->global transform on the active table's region element and
        persist to disk so it survives a session restart (§3.1 mutating job)."""
        from . import transform
        with self.lock.writing():
            region = transform.set_affine6(self.sdata, self.active_table(), payload["affine"])
        if region:
            self.dirty_transforms.add(region)
        target = Path(payload["path"]).resolve()
        if not within_data_dir(target):
            raise ValueError("save path is outside the data directory")
        with self.lock.reading():
            self.store_path = self._write_checkpoint(payload["path"], payload.get("hash_name", False))
        self.saved = True
        self._clear_dirty()
        self._jobs[job_id]["status"] = "completed"
        appstate.bump_versions(self.app_state, ["obsm:spatial"])
        BUS.publish("job.completed", {"session_id": self.id, "job_id": job_id, "kind": "set_transform",
                                      "path": self.store_path,
                                      "data_versions": self.app_state["data_versions"]})

    def _run_save(self, job_id, payload):
        target = Path(payload["path"]).resolve()
        if not within_data_dir(target):
            raise ValueError("save path is outside the data directory")
        with self.lock.reading():
            path = self._write_checkpoint(payload["path"], payload.get("hash_name", False))
        self.store_path = path
        self.saved = True
        self._clear_dirty()
        self._jobs[job_id]["status"] = "completed"
        BUS.publish("job.completed", {"session_id": self.id, "job_id": job_id, "kind": "save",
                                      "path": path, "data_versions": self.app_state["data_versions"]})

    def _run_subset(self, job_id, payload):
        # No lock held here: perform_subset reads self.sdata under its own read lock
        # and then ends by closing this session, which acquires the write lock. Holding
        # either lock across that whole call would self-deadlock (this IS that call's
        # worker thread; the RWLock isn't reentrant for the thread that already holds it).
        child = self.manager.perform_subset(self, payload)
        self._jobs[job_id]["status"] = "completed"
        BUS.publish("job.completed", {"session_id": self.id, "job_id": job_id, "kind": "subset",
                                      "child_id": child.id, "data_versions": self.app_state["data_versions"]})

    def _apply_pinned_view(self, view: dict) -> None:
        """Build this session's sole display straight from a snapshot's saved view
        (table/kind/encoding/viewport) instead of the auto-generated default — used
        by `_run_load` when opening a read-only snapshot session
        (SessionManager.create_from_snapshot). `view` is a snapshot config: the same
        shape `snapshots.save_snapshot` writes."""
        table = view.get("table")
        if table and table in getattr(self.sdata, "tables", {}):
            self.active_table_key = table
        display_type = "embedding_canvas" if view.get("kind") == "embedding" else "spatial_canvas"
        # Replace, not append: the checkpoint's own app_state (loaded moments ago by
        # load_spatialdata) already carries whatever displays were live when it was
        # saved. Appending would leave those in place ahead of this one in the list,
        # so the frontend's `displays.find(isSpatialDisplay)` would keep matching the
        # OLD display and render its (unrelated, possibly stale) viewport instead of
        # the pinned one this snapshot actually saved.
        self.app_state["displays"] = [{
            "id": str(uuid.uuid4()), "type": display_type,
            "encoding": view.get("encoding") or {},
            "viewport": view.get("viewport") or None,
        }]

    def _run_load(self, job_id, payload):
        """Open a saved checkpoint on the worker: unzip/read the archive and re-tile its
        rasters (both slow for a large Xenium store), then adopt the object under the
        write lock — the async analogue of the read-bootstrap adoption in _run_call. The
        POST that created this session already returned a `loading` shell, so progress and
        the terminal result stream over `session.loading`, keyed by the client-minted
        `load_id`; the checkpoint's own app_state replaces the shell's fresh one."""
        from ..persistence.store import load_spatialdata
        from .. import rasters
        load_id = payload.get("load_id")
        pinned_view = payload.get("pinned_view")

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
                # Older stores hold huge-chunked rasters; re-tile them so canvas tiles
                # stay cheap (a no-op for stores already in canonical form). See rasters.py.
                self.raster_cache_dir, self.raster_stores = rasters.normalize_rasters(sdata, report)
                self.raster_cache_mb = rasters.cache_size_mb(self.raster_cache_dir)
                self.active_table_key = self._default_table_key()
                report("Building views…")
                if pinned_view is not None:
                    self._apply_pinned_view(pinned_view)
                elif not self.app_state["displays"]:
                    self.manager.auto_displays(self)
                self.status = "ready"
        except Exception as e:
            # Handle the failure here rather than letting it propagate to _dispatch: the
            # New Session dialog follows the load over `session.loading` (keyed by load_id),
            # not job.failed, so it needs the terminal event to surface the error.
            self.status = "errored"
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
        self.app_state[coll_key] = [r for r in list(self.app_state[coll_key]) if r["id"] != job_id]

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
