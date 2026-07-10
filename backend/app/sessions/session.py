"""A session = one in-memory SpatialData + one FIFO queue + one worker thread +
its attrs state (DESIGN §11.1). Compute mutates in place; the queue is strictly
serial (§6.2). A read/write lock keeps async data serving off a half-mutated
object (§20.2).
"""
import queue
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from . import appstate
from .adapter import ADAPTER
from ..config import within_checkpoint_dir
from ..transport.sse import BUS


class RWLock:
    """Many readers OR one writer (DESIGN §20.2)."""
    def __init__(self):
        self._cond = threading.Condition()
        self._readers = 0
        self._writer = False

    def acquire_read(self):
        with self._cond:
            while self._writer:
                self._cond.wait()
            self._readers += 1

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
    def reading(self):
        self.acquire_read()
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


def _envelope(result) -> dict:
    """The JSON-safe contract envelope (v3 Part 2) for the agent loop."""
    return {"status": result.status, "logs": result.log, "error": result.error,
            "structural_diff": result.structural_diff, "result_value": result.result_value,
            "manifest_before": result.manifest_before, "manifest_after": result.manifest_after}


class Session:
    def __init__(self, sid, name, sdata, app_state, manager, parent_id=None, store_path=None):
        self.id = sid
        self.name = name
        self.sdata = sdata
        self.app_state = app_state
        self.manager = manager
        self.parent_id = parent_id
        self.store_path = store_path
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

    def active_image(self):
        imgs = list(getattr(self.sdata, "images", {}).keys())
        return self.sdata.images[imgs[0]] if imgs else None

    def stash_result(self, key, value):
        ad = self.active_table()
        ad.uns.setdefault("_results", {})[key] = value

    # ---- enqueue / staging (PENDING lifecycle, spec §5.4) -----------------
    def _collection(self, ec: str) -> list:
        return self.app_state["plots"] if ec == "plot" else self.app_state["compute_history"]

    def _make_record(self, descriptor: dict, entry_id: str, status: str):
        fn = self.manager.registry.get(f"{descriptor['namespace']}.{descriptor['function']}")
        ec = "plot" if (fn is not None and fn.effect_class == "plot") else "compute"
        rec = {"id": entry_id, "namespace": descriptor["namespace"], "function": descriptor["function"],
               "params": descriptor.get("params", {}), "status": status,
               "squidpy_version": self.manager.registry.squidpy_version}
        if ec == "plot":
            rec["references"] = self._references(descriptor.get("params", {}))
        else:
            rec["structural_diff"] = {}
        return ec, rec

    def _enqueue_job(self, entry_id: str, ec: str, descriptor: dict, keep_failures: bool = True):
        self._jobs[entry_id] = {"kind": ec, "descriptor": descriptor, "status": "queued",
                                "keep_failures": keep_failures}
        self._queue.put((entry_id, ec, descriptor))
        BUS.publish("job.queued", {"session_id": self.id, "job_id": entry_id,
                                   "descriptor": descriptor, "position": self._queue.qsize(),
                                   "effect_class": ec})

    def enqueue_descriptor(self, descriptor: dict, keep_failures: bool = True) -> str:
        """Run-now fast path: record + submit immediately. Frontend invocations keep
        failures in history (keep_failures=True, v3 Part 2); the AI agent passes
        keep_failures=False so its exploration never clutters the audit log."""
        entry_id = str(uuid.uuid4())
        ec, rec = self._make_record(descriptor, entry_id, "queued")
        self._collection(ec).append(rec)
        self._enqueue_job(entry_id, ec, descriptor, keep_failures)
        return entry_id

    def stage_descriptor(self, descriptor: dict) -> str:
        """Stage a PENDING step: visible + editable, not submitted (spec §5.4)."""
        entry_id = str(uuid.uuid4())
        ec, rec = self._make_record(descriptor, entry_id, "pending")
        self._collection(ec).append(rec)
        return entry_id

    def run_and_wait(self, descriptor: dict, keep_failures: bool = False, timeout: float = 300) -> dict:
        """Enqueue a call and block (in the caller's thread, not the worker) until it
        reaches a terminal state, returning the contract envelope. The agent's
        run_function tool uses this with keep_failures=False (v3 Part 2/5)."""
        job_id = self.enqueue_descriptor(descriptor, keep_failures=keep_failures)
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.job_status(job_id) in ("completed", "drawn", "failed", "cancelled"):
                return self._jobs.get(job_id, {}).get("envelope") or {"status": self.job_status(job_id)}
            time.sleep(0.1)
        return {"status": "timeout", "error": f"job did not finish within {timeout}s"}

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
                self._fail(job_id, kind, "memory boundary (>=80%) reached; refused to dequeue")
                continue
            try:
                self._dispatch(job_id, kind, payload)
            except Exception as e:  # a bookkeeping error must never kill the worker
                import traceback
                traceback.print_exc()
                self._fail(job_id, kind, str(e))

    def _dispatch(self, job_id, kind, payload):
        self._jobs[job_id]["status"] = "running"
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
            elif kind == "set_transform":
                self._run_set_transform(job_id, payload)
        except Exception as e:  # worker must never die
            self._fail(job_id, kind, str(e))
        finally:
            self._jobs.get(job_id, {}).pop("started", None)
            self._prune_jobs()

    _TERMINAL_JOB_CAP = 200

    def _prune_jobs(self):
        """Bound worker job bookkeeping. Queued/running entries are always kept; the
        durable record lives in app_state. Old terminal entries (and their logs) are
        dropped beyond a recent window."""
        terminal = [jid for jid, j in list(self._jobs.items())
                    if j["status"] in ("completed", "drawn", "failed", "cancelled")]
        for jid in terminal[:-self._TERMINAL_JOB_CAP] if len(terminal) > self._TERMINAL_JOB_CAP else []:
            self._jobs.pop(jid, None)
            self._failed_logs.pop(jid, None)

    def _run_call(self, job_id, kind, descriptor):
        from ..manifest import build_manifest
        # kind is always "compute" or "plot" here (the only two _dispatch routes here);
        # both need the write lock — render_plot (registry/base.py) calls squidpy/scanpy
        # pl.* functions on the live adata, and those cache things like
        # uns['<col>_colors'] as a side effect even for a pure "plot" job.
        with self.lock.writing():
            manifest_before = build_manifest(self)  # v3 Part 2: capture before the call
            result = ADAPTER.execute(descriptor, self)
            # Adopt a returned object (read bootstrap / Edge B) while still holding
            # the write lock so readers never see a new sdata with a stale table key.
            if result.status != "failed" and result.new_object is not None:
                if self.sdata is not None and self.sdata is not result.new_object:
                    from .. import imaging
                    imaging.evict_caches(self.sdata)  # old id() is about to be freed
                self.sdata = result.new_object
                self.force_full = True  # a freshly adopted object must be written whole once
                # A reader's images/labels can be single-scale or huge-chunked; tile
                # them now so the canvas never realizes a multi-GB chunk per tile.
                from .. import rasters
                self.raster_cache_dir = rasters.normalize_rasters(self.sdata)
                self.active_table_key = self._default_table_key()
                if not self.app_state["displays"]:
                    self.manager.auto_displays(self)
                self.status = "ready"  # the read bootstrap adopted the object
            result.manifest_before = manifest_before
            result.manifest_after = build_manifest(self)

        self._jobs[job_id]["envelope"] = _envelope(result)  # for the agent loop (Part 2/5)

        if result.status == "failed":
            # A failed read bootstrap (no object ever adopted) leaves the session unusable.
            if self.sdata is None:
                self.status = "errored"
            self._fail(job_id, kind, result.error or "failed", log=result.log)
            return

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

    def _run_annotate(self, job_id, payload):
        """Region labeling: mutate obs/shapes in place under the write lock (§3.1)."""
        from . import regions
        with self.lock.writing():
            changed = (regions.promote(self, payload["obs_column"])
                       if payload.get("op") == "promote" else regions.assign(self, payload))
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
        changed table/transform elements (reusing the on-disk sharded rasters) when the
        session is still backed by the sharded store it loaded from and no raster
        changed; otherwise re-serialize the whole object. The caller holds the read
        lock and updates saved-state after this returns."""
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
        if not within_checkpoint_dir(target):
            raise ValueError("save path is outside the checkpoint directory")
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
        if not within_checkpoint_dir(target):
            raise ValueError("save path is outside the checkpoint directory")
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
        keep = self._jobs.get(job_id, {}).get("keep_failures", True)
        if kind == "compute":
            # v3 Part 2: frontend failures stay in history (keep_failures=True) for the
            # user to inspect/delete; AI failures (keep_failures=False) are dropped from
            # the audit log but still surfaced to the agent via job.failed.
            if keep:
                rec = self._find_record(job_id, "compute")
                if rec:
                    rec["status"] = "failed"
                    rec["_log"] = log or error
            else:
                self._drop_history(job_id, kind)
        elif kind == "plot":
            if keep:
                rec = self._find_record(job_id, "plot")
                if rec:
                    rec["status"] = "failed"
                    rec["_log"] = log or error
            else:
                self.app_state["plots"] = [r for r in list(self.app_state["plots"]) if r["id"] != job_id]
        descriptor = self._jobs.get(job_id, {}).get("descriptor") or {}
        source = f"{descriptor['namespace']}.{descriptor['function']}" if "function" in descriptor else kind
        BUS.publish("job.failed", {"session_id": self.id, "job_id": job_id, "error": error,
                                   "source": source, "timestamp": time.strftime("%H:%M:%S")})

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
        self._jobs[plot_id] = {"kind": "plot", "descriptor": descriptor, "status": "queued"}
        self._queue.put((plot_id, "plot", descriptor))
        BUS.publish("job.queued", {"session_id": self.id, "job_id": plot_id,
                                   "descriptor": descriptor, "position": self._queue.qsize(),
                                   "effect_class": "plot"})
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
