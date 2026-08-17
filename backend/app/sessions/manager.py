"""Session manager (DESIGN §11). Owns the session table, load-admission and the
80% boundary check (§11.3), lasso subset → child session (§8), and the resource
sampler (§11.3). One shared process; one worker thread per session.
"""
import copy
import os
import time
import uuid
from pathlib import Path

import psutil

from . import appstate
from .presence import PRESENCE
from .session import Session
from ..config import cgroup_mem_usage, config, within_data_dir
from ..persistence.store import estimate_resident_mb, save_spatialdata
from ..registry.reader_paths import ABSOLUTE_PATH_PARAMS, RELATIVE_FILE_PARAMS
from ..transport.sse import BUS

# Reader params that are absolute filesystem paths (the primary acquisition path
# plus image_path/alignment_file). Any of these passed to a read-effect function
# is validated against the allowed data roots before the reader ever runs. Source
# of truth (shared with the form's per-param path pickers): registry/reader_paths.py.
_READ_PATH_PARAMS = ABSOLUTE_PATH_PARAMS

# Secondary filename params that readers resolve relative to their own primary path
# param (squidpy.read.vizgen/nanostring/visium, spatialdata_io.visium/visium_hd/
# merscope all do `Path(path) / counts_file` or similar internally). `Path(base) /
# value` silently DISCARDS `base` when `value` is itself absolute — so without this,
# an absolute counts_file/meta_file/etc. reads an arbitrary host path regardless of
# how well `path` itself is sandboxed. Validated below by reproducing the same join
# against the descriptor's own primary path and running it through the same
# _resolve_or_raise check, which catches both that discard and a "../.." traversal.
_READ_AUX_PATH_PARAMS = RELATIVE_FILE_PARAMS


# Backstop cadence for re-scanning compute-worker child processes; see
# `SessionManager._refresh_cpu_procs` for why this is much slower than the sample rate.
# A job starting forces a scan of its own (`admit_job`), so this only has to reap
# workers loky retired while nothing was running.
_CPU_PROC_SCAN_S = 10.0


def _resolve_or_raise(path: str) -> Path:
    """Resolve `path` and ensure it falls within DATA_DIR — the single on-disk root
    for reader inputs, loads, and saves; raises RuntimeError otherwise (both callers
    below surface it as-is)."""
    try:
        target = Path(path).resolve()
    except OSError:
        raise RuntimeError(f"bad path: {path}")
    if not within_data_dir(target):
        raise RuntimeError(f"path is outside the data directory: {path}")
    return target


class SessionManager:
    def __init__(self, registry):
        self.registry = registry
        self.sessions: dict[str, Session] = {}
        self._proc = psutil.Process()
        # Cache of Process handles for the CPU rollup (see _cpu_pct): the API process
        # plus its compute-worker children. Kept across samples because psutil's
        # non-blocking cpu_percent() measures the delta since the *previous* call on the
        # same object, so a fresh handle each tick would always read 0.
        self._cpu_procs: dict[int, psutil.Process] = {self._proc.pid: self._proc}
        self._cpu_procs_at = 0.0  # monotonic time of the last child scan (_refresh_cpu_procs)

    # ---- creation ---------------------------------------------------------
    def create_from_load(self, path: str, name: str | None = None,
                         load_id: str | None = None, read_only: bool = False) -> Session:
        """Open a saved checkpoint. The unzip/read/re-tile is slow (tens of seconds to
        minutes for a large Xenium store), so — like create_from_read — this returns a
        `loading` shell immediately and runs the heavy load as the session's first worker
        job (Session._run_load), which adopts the object under the write lock and streams
        progress + a terminal result over the `session.loading` SSE channel keyed by
        `load_id`. Only the cheap admission checks run here, so a bad path / over-capacity
        / over-budget load still fails fast with a clear 400 instead of a background
        session that never becomes ready. `read_only` opens the session frozen — it rejects
        every mutating route once adopted."""
        self._check_capacity()
        resolved = str(_resolve_or_raise(path))  # validated, resolved path for every fs op below
        self._check_admission(estimate_resident_mb(resolved))
        sid = str(uuid.uuid4())
        sess = Session(sid, name or _basename(resolved), None, appstate.fresh(), self,
                      store_path=resolved, read_only=read_only)
        self.sessions[sid] = sess
        # heavy load is the first queue job (§12)
        sess.enqueue_load(resolved, load_id, adopt_name=name is None)
        BUS.publish("session.created", {"session_id": sid, "summary": self.summary(sess)})
        return sess

    def create_from_read(self, descriptor: dict, name: str | None = None) -> Session:
        self._check_capacity()
        # No cheap size estimate exists for a raw reader input (the bulk is a lazy
        # image, not resident), so gate on current headroom instead: refuse to start
        # a read when we're already at the admission boundary. create_from_load has
        # its own size-based _check_admission since a saved store's table cost is known.
        if self.over_memory_boundary():
            pct = self._mem_fraction()
            raise RuntimeError(
                f"read blocked: memory at {pct*100:.0f}% (>= {config.ADMISSION_PCT*100:.0f}%)")
        params = descriptor.get("params", {})
        for k, v in params.items():
            if k not in _READ_PATH_PARAMS or not isinstance(v, str):
                continue
            _resolve_or_raise(v)
        base_path = params.get("path")
        if isinstance(base_path, str):
            for k, v in params.items():
                if k not in _READ_AUX_PATH_PARAMS or not isinstance(v, str) or not v:
                    continue
                _resolve_or_raise(str(Path(base_path) / v))
        sid = str(uuid.uuid4())
        sess = Session(sid, name or descriptor.get("function", "session"), None, appstate.fresh(), self)
        self.sessions[sid] = sess
        sess.enqueue_descriptor(descriptor)  # read bootstrap is the first queue job (§12)
        BUS.publish("session.created", {"session_id": sid, "summary": self.summary(sess)})
        return sess

    def auto_displays(self, sess: Session):
        """Generate a default spatial canvas (DESIGN §9.1). Called on session
        creation from a saved store (create_from_load) and again once a read
        bootstrap job adopts its SpatialData (Session._run_call), since the
        latter has no sdata/table to build a display from until that job runs."""
        try:
            ad = sess.active_table()
        except RuntimeError:
            return
        import pandas as pd
        color = None
        for c in ad.obs.columns:
            if isinstance(ad.obs[c].dtype, pd.CategoricalDtype):
                color = f"obs:{c}"
                break
        coords = "obsm:spatial" if "spatial" in ad.obsm else (
            f"obsm:{next(iter(ad.obsm))}" if len(ad.obsm) else None)
        images = list(getattr(sess.sdata, "images", {}).keys())
        sess.app_state["displays"].append({
            "id": str(uuid.uuid4()), "type": "spatial_canvas",
            "encoding": {"coords": coords, "color_by": color,
                         "image_layer": images[0] if images else None, "shapes_layer": None,
                         "render_mode": "points", "point_marker": "circle",
                         "point_size": 4, "opacity": 0.85, "colormap": "viridis",
                         "legend_visible": True, "legend_title": ""},
            "viewport": None,
        })

        emb_key = next((k for k in ad.obsm if k != "spatial"), None)
        if emb_key is not None:
            sess.app_state["displays"].append({
                "id": str(uuid.uuid4()), "type": "embedding_canvas",
                "encoding": {"obsm_key": emb_key, "x_component": 0, "y_component": 1,
                             "z_component": 2, "is_3d": False, "color_by": color,
                             "point_size": 4, "opacity": 0.85, "colormap": "viridis",
                             "legend_visible": True, "legend_title": ""},
                "viewport": None,
            })

    # ---- queries ----------------------------------------------------------
    def get(self, sid: str) -> Session | None:
        return self.sessions.get(sid)

    def summary(self, sess: Session) -> dict:
        return {"id": sess.id, "name": sess.name, "status": sess.status,
                "resident_mb": self._resident_mb(sess), "parent_id": sess.parent_id,
                "created_at": sess.created_at, "saved": sess.saved, "read_only": sess.read_only,
                "error": sess.error}

    def list_summaries(self) -> list:
        return [self.summary(s) for s in list(self.sessions.values())]

    def state(self, sess: Session) -> dict:
        from ..transport.arrow import describe_fields
        fields = {}
        app_state = sess.app_state
        with sess.lock.reading():
            try:
                # Read the live AnnData under the read lock: the worker mutates obs/obsm
                # under the write lock, so an unguarded describe_fields can hit a torn read
                # or "dict changed size during iteration" mid-compute.
                fields = describe_fields(sess.active_table(), sess.sdata)
            except RuntimeError:
                pass
            # regions.assign (sessions/regions.py) mutates app_state["regions"] and each
            # display's nested `encoding` IN PLACE under the write lock — appending
            # region entries, rebinding entry["categories"], writing enc["color_by"] and
            # nested enc["category_colors"][...] — so the shallow dict(d) display copies
            # below would still share (and FastAPI would serialize, post-lock) the live
            # sub-dicts mid-mutation. Deep-copy just those substructures, under the read
            # lock so the copy itself can't tear either; plots/history can be huge, so
            # the whole app_state is deliberately NOT deep-copied.
            regions_copy = copy.deepcopy(app_state.get("regions", []))
            displays_copy = [
                {**d, "encoding": copy.deepcopy(d["encoding"])}
                if d.get("encoding") is not None else dict(d)
                for d in list(app_state.get("displays", []))
            ]
        # Snapshot the mutable collections: the worker thread appends to / rewrites
        # compute_history/plots and bumps data_versions as bookkeeping AFTER releasing
        # the write lock, so returning the live app_state would let FastAPI serialize
        # it (post-lock) mid-mutation — a torn read or "changed size during iteration".
        # list(<list>) is a single atomic C copy under the GIL; the per-record dict()
        # then iterates that snapshot, never the live list.
        # Drop each record's full captured log (`_log`) from this polled response: the
        # frontend fetches a job's log on demand via GET /api/sessions/{id}/jobs/{job_id}/log
        # (get_log reads `_log` straight from app_state) and streams it live over `job.log`,
        # so inlining it here only bloated every refetch — a verbose scanpy run (e.g. neighbors)
        # leaves tens of MB of log on a single record.
        def _public(rec):
            return {k: v for k, v in rec.items() if k != "_log"}
        safe_state = {
            **app_state,
            "compute_history": [_public(r) for r in list(app_state.get("compute_history", []))],
            "plots": [_public(r) for r in list(app_state.get("plots", []))],
            "displays": displays_copy,
            "regions": regions_copy,
            "data_versions": dict(app_state.get("data_versions", {})),
        }
        return {"summary": self.summary(sess), "app_state": safe_state,
                "queue": sess.queue_view(), "fields": fields,
                "figures": sess.figure_index(),
                "data_versions": safe_state["data_versions"]}

    # ---- subset → child (DESIGN §8) --------------------------------------
    def _select_by_indices(self, parent: Session, payload: dict):
        """Embedding-view subset: mask the active table by explicit row indices (its lasso
        lives in embedding/screen space, not a spatial coordinate system) and let
        spatialdata filter the linked elements to match. `invert` (remove) keeps the
        complement; a table with no linked elements becomes a table-only child. Runs
        under the caller's read lock."""
        import numpy as np
        import spatialdata as sd
        from spatialdata.models import get_table_keys
        tkey = parent.active_table_key or (list(getattr(parent.sdata, "tables", {})) or [None])[0]
        if tkey is None:
            raise ValueError("no table to subset")
        adata = parent.sdata.tables[tkey]
        idx = np.asarray(payload["cell_indices"], dtype=int)
        idx = idx[(idx >= 0) & (idx < adata.n_obs)]
        keep = not payload.get("invert")
        mask = np.zeros(adata.n_obs, dtype=bool) if keep else np.ones(adata.n_obs, dtype=bool)
        mask[idx] = keep
        if not mask.any():
            raise ValueError("selection contains zero observations; no child created")
        sub = adata[mask].copy()
        try:
            get_table_keys(sub)  # linked to elements -> filter them to match the subset
            return sd.match_sdata_to_table(parent.sdata, table=sub, table_name=tkey)
        except (ValueError, KeyError):
            return sd.SpatialData(tables={tkey: sub})

    def _select_by_polygon(self, parent: Session, payload: dict):
        """Spatial-view subset: parse the lasso rings and resolve them against a
        coordinate system with polygon_query. `invert` (remove) queries the data extent
        with the selection cut out (box-minus-selection). Runs under the caller's read
        lock."""
        import spatialdata as sd
        from shapely.geometry import Polygon, MultiPolygon
        polys = []
        for r in payload["polygons"]:
            if len(r) < 3:
                continue
            p = Polygon(r)
            if not p.is_valid:           # repair self-intersecting / degenerate lassos
                p = p.buffer(0)
            if not p.is_empty:
                polys.append(p)
        if not polys:
            raise ValueError("no valid polygon in selection")
        geom = polys[0] if len(polys) == 1 else MultiPolygon(polys)
        systems = parent.sdata.coordinate_systems
        if not (payload.get("coordinate_system") or systems):
            raise ValueError("object has no coordinate system to subset in")
        cs = payload.get("coordinate_system") or systems[0]
        # "remove" mode (invert): the box must contain every cell, so use the whole
        # object's extent, padded slightly so cells on the edge aren't dropped.
        if payload.get("invert"):
            from spatialdata import get_extent
            from shapely.geometry import box
            ext = get_extent(parent.sdata, coordinate_system=cs)
            x0, y0, x1, y1 = float(ext["x"][0]), float(ext["y"][0]), float(ext["x"][1]), float(ext["y"][1])
            padx = (x1 - x0) * 0.01 or 1.0
            pady = (y1 - y0) * 0.01 or 1.0
            comp = box(x0 - padx, y0 - pady, x1 + padx, y1 + pady).difference(geom)
            if comp.is_empty:
                raise ValueError("the selection covers the whole section; nothing left to keep")
            query_geom = comp
            query_polys = list(comp.geoms) if comp.geom_type == "MultiPolygon" else [comp]
        else:
            query_geom, query_polys = geom, polys
        try:
            return sd.polygon_query(parent.sdata, query_geom, target_coordinate_system=cs, filter_table=True)
        except Exception:
            # MultiPolygon rejected by this version: per-polygon query + concat (§8.1)
            parts = [sd.polygon_query(parent.sdata, p, target_coordinate_system=cs, filter_table=True) for p in query_polys]
            return sd.concatenate(parts) if len(parts) > 1 else parts[0]

    def perform_subset(self, parent: Session, payload: dict) -> Session:
        # The embedding view selects by explicit table-row indices; the spatial view sends
        # lasso rings resolved with polygon_query. Both the query and the image/label
        # re-attach read parent.sdata under parent's own read lock. close() below acquires
        # parent's write lock itself, so it must run AFTER this block releases the read
        # lock — the caller (Session._run_subset) runs on parent's own worker thread, and
        # the RWLock isn't reentrant: holding either lock across close() would self-deadlock.
        with parent.lock.reading():
            result = (self._select_by_indices(parent, payload)
                      if payload.get("cell_indices") is not None
                      else self._select_by_polygon(parent, payload))

            tkeys = list(getattr(result, "tables", {}).keys())
            if not tkeys or result.tables[tkeys[0]].n_obs == 0:
                raise ValueError("selection contains zero observations; no child created")

            # polygon_query crops images/labels to the polygon's bounding box; subsetting cells
            # should NOT crop the tissue raster, so re-attach the parent's full image/label
            # elements (lazy refs, same 'global' transform). Shapes/points stay subset.
            for kind in ("images", "labels"):
                for name, elem in getattr(parent.sdata, kind, {}).items():
                    getattr(result, kind)[name] = elem

            child_state = copy.deepcopy(parent.app_state)  # deep-copy, then diverge (§8.2)
            child_state["compute_history"] = []
            child_state["plots"] = []
            child_state["data_versions"] = {}
            result.attrs["app_state"] = child_state

        cid = str(uuid.uuid4())
        child = Session(cid, f"{parent.name}-subset", result, child_state, self, parent_id=parent.id)
        self.sessions[cid] = child
        BUS.publish("session.created", {"session_id": cid, "summary": self.summary(child)})

        # The re-attached images/labels above are lazy refs that still read chunks from
        # parent.extract_dir (unpacked .zarr.zip) and parent.raster_cache_dir (tiled
        # rasters); transfer ownership to the child so closing the parent below doesn't
        # rmtree a directory the child still depends on.
        child.extract_dir = parent.extract_dir
        child.raster_cache_dir = parent.raster_cache_dir
        child.raster_stores = parent.raster_stores
        child.raster_cache_mb = parent.raster_cache_mb
        parent.extract_dir = parent.raster_cache_dir = None
        parent.raster_stores = {}
        parent.raster_cache_mb = 0.0

        self.close(parent.id, save=False, reason="subset")
        return child

    # ---- close / evict ----------------------------------------------------
    def close(self, sid: str, save: bool = False, reason: str = "closed"):
        sess = self.sessions.pop(sid, None)
        if sess is None:
            return
        # shutdown() only sets a stop flag (no join), so it can't deadlock against
        # the worker holding the lock below; the save-then-null-out sequence below is
        # the part that races with an in-flight read (/manifest, /table, /data) or
        # write (a genuine job on this session's own worker thread), so it needs the
        # write lock.
        sess.shutdown()
        with sess.lock.writing():
            # A session whose load is still in flight or errored has no object in
            # memory (sess.sdata is None) even though store_path is set; there is
            # nothing to save and the on-disk checkpoint is already its latest
            # state, so skip the save — the temp-dir/presence/session.removed
            # cleanup below must still run.
            if save and sess.store_path and sess.sdata is not None:
                save_spatialdata(sess.sdata, sess.store_path, sess.app_state,
                                 figures=sess.figures_to_persist())
            # Evict this object's image caches before releasing it — they key on
            # id(sdata), which a later session's object could reuse (imaging.py).
            if sess.sdata is not None:
                from .. import imaging
                imaging.evict_caches(sess.sdata)
            sess.sdata = None
        import shutil
        for d in (sess.extract_dir, sess.raster_cache_dir):  # unpacked .zarr.zip + tiled-raster temps (DESIGN §13)
            if d:
                shutil.rmtree(d, ignore_errors=True)
        # Drop the edit lock and everyone's attachment to it, so a closed session never
        # lingers in the viewer/lock lists (presence.py).
        PRESENCE.drop_session(sid)
        # Tell every viewer the session is gone so it drops out of their session list.
        # reason="subset" marks a lasso eviction: the parent's viewers are moved to the
        # child by the job.completed(child_id) handler, so they must NOT be nulled/notified
        # here — only other viewers prune it from their list.
        BUS.publish("session.removed", {"session_id": sid, "reason": reason})

    # ---- memory (DESIGN §11.3) -------------------------------------------
    def _rss_mb(self) -> float:
        """Anonymous memory the app holds. Inside a memory-limited container that is the
        whole cgroup's `anon` — the API process *and* its compute-pool workers, shared
        pages charged once (see config.cgroup_mem_usage). A worker holds a full pickled
        copy of the table for a job's duration and the largest raster during an ingest
        re-tile, so counting only this process under-reports exactly when the container is
        closest to its limit. Outside a cgroup (local dev) it falls back to this process
        alone, where the workers stay invisible."""
        usage = cgroup_mem_usage()
        return usage[0] if usage is not None else self._proc.memory_info().rss / 1e6

    def _work_dir_mb(self) -> float:
        """RAM held by the working set (unpacked archives + raster caches) when
        WORK_DIR is tmpfs-backed. tmpfs pages don't show up in process RSS but do
        count against the cgroup limit the OOM killer enforces, so the boundary and
        admission math must add them in — otherwise it would keep admitting loads,
        jobs and tile renders until the OOM killer fires. 0.0 when WORK_DIR is on
        disk (the default), where it isn't spending the RAM budget.

        Inside a container this is the cgroup's own `shmem`: the same quantity, read
        from the kernel's accounting instead of inferred, so it needs neither the
        WORK_DIR_IN_RAM flag nor the assumption that WORK_DIR is a dedicated mount —
        it is simply 0 when nothing is on tmpfs. The statvfs estimate below is the
        fallback outside a cgroup (local dev). O(1) either way, so it stays cheap at
        the resource-sample cadence."""
        usage = cgroup_mem_usage()
        if usage is not None:
            return usage[1]
        if not config.WORK_DIR_IN_RAM:
            return 0.0
        try:
            st = os.statvfs(config.WORK_DIR)
        except OSError:
            return 0.0
        return (st.f_blocks - st.f_bfree) * st.f_frsize / 1e6

    def _effective_mb(self) -> float:
        """Anonymous memory plus the RAM-backed working set — the real memory pressure
        spent against the container limit. In a container both halves are the cgroup's
        own, so this covers the compute-pool workers too (see `_rss_mb`); outside one it
        is this process plus the statvfs working-set estimate."""
        return self._rss_mb() + self._work_dir_mb()

    def _mem_fraction(self) -> float:
        """Effective memory (anon + RAM-backed working set) as a fraction of the
        container memory limit. Returns 0.0 (unknown) when the limit is non-positive
        — e.g. SDS_CONTAINER_MEM_MB=0 in the task definition — so a misconfigured
        limit degrades to "no percentage / never blocks" instead of a
        ZeroDivisionError that would wedge the sampler and admission on every call."""
        if config.CONTAINER_MEM_MB <= 0:
            return 0.0
        return self._effective_mb() / config.CONTAINER_MEM_MB

    def _refresh_cpu_procs(self) -> None:
        """Re-scan which compute-worker children exist. `children(recursive=True)` walks
        every process on the host (~10 ms with a few hundred processes around) and holds
        the GIL for it, which at the sampler's cadence was enough to show up as a periodic
        hitch in every client's request latency. So it runs on its own slow cadence rather
        than every sample: the child set only changes when loky spawns or retires workers,
        and `admit_job` forces a scan when a job is about to start. A child that exits
        between scans just raises NoSuchProcess in the rollup below and is skipped until
        the next one prunes it."""
        live = {self._proc.pid}
        try:
            for child in self._proc.children(recursive=True):
                live.add(child.pid)
                self._cpu_procs.setdefault(child.pid, child)
        except psutil.Error:
            pass
        for pid in [p for p in self._cpu_procs if p not in live]:
            del self._cpu_procs[pid]
        self._cpu_procs_at = time.monotonic()

    def _cpu_pct(self) -> float:
        """Summed CPU% across the API process and its compute-worker children (the loky
        pool in compute_pool.py). The API process itself sits mostly idle during a job,
        blocked on the worker's future, so measuring it alone (the old reading) badly
        under-reported real CPU use; the heavy squidpy/scanpy work runs in the children.
        100% == one core fully busy, so the total can exceed 100% on a multi-core box
        (the resource strip shows it against the core count, see config.CPU_LIMIT).
        A newly seen child reads 0.0 for one tick while its baseline primes."""
        if time.monotonic() - self._cpu_procs_at >= _CPU_PROC_SCAN_S:
            self._refresh_cpu_procs()
        total = 0.0
        for proc in self._cpu_procs.values():
            try:
                total += proc.cpu_percent()
            except psutil.Error:
                pass
        return total

    def _resident_mb(self, sess: Session) -> float:
        if sess.sdata is None:
            return 0.0
        try:
            ad = sess.active_table()
        except RuntimeError:
            return 0.0
        nbytes = 0
        X = ad.X
        nbytes += getattr(X, "data", X).nbytes if hasattr(getattr(X, "data", X), "nbytes") else 0
        nbytes += sum(v.values.nbytes for v in ad.obsm.values() if hasattr(v, "values"))
        return round(nbytes / 1e6, 1)

    def _check_capacity(self):
        if len(self.sessions) >= config.MAX_SESSIONS:
            raise RuntimeError(f"max concurrent sessions ({config.MAX_SESSIONS}) reached")

    def _check_admission(self, resident_mb: float):
        avail = config.CONTAINER_MEM_MB - self._effective_mb()
        if resident_mb > avail:
            raise RuntimeError(
                f"load blocked: estimated {resident_mb:.0f} MB exceeds available {avail:.0f} MB")

    def over_memory_boundary(self) -> bool:
        """True once effective memory has reached the admission boundary — the point
        past which we refuse to start new memory-hungry work (a job, a read, a tile
        render). Effective memory includes the RAM-backed working set (`_mem_fraction`)."""
        return self._mem_fraction() >= config.ADMISSION_PCT

    def admit_job(self, sess: Session) -> bool:
        # A job is about to submit to the compute pool, which spawns worker processes if
        # loky retired them while idle. Expire the child scan so the next resource sample
        # picks the new workers up rather than under-reporting CPU for the scan interval.
        self._cpu_procs_at = 0.0
        if self.over_memory_boundary():
            pct = self._mem_fraction()
            BUS.publish("memory.warning", {"session_id": sess.id,
                        "message": f"memory at {pct*100:.0f}% (>= {config.ADMISSION_PCT*100:.0f}%); job held"})
            return False
        return True

    def resource_sample(self) -> dict:
        sessions = list(self.sessions.values())
        # rss_pct is the effective fraction (anon + RAM-backed working set) that the
        # admission boundary actually gates on; work_dir_mb is that working set (0.0
        # unless WORK_DIR is tmpfs-backed). The two are disjoint, so the strip can show
        # them side by side. In a container both cover the compute workers as well as
        # the API process (see `_rss_mb`), which is what the strip's "global" means.
        return {"global": {"rss_mb": round(self._rss_mb(), 1),
                           "work_dir_mb": round(self._work_dir_mb(), 1),
                           "rss_pct": round(self._mem_fraction() * 100, 1),
                           "cpu_pct": round(self._cpu_pct(), 1),
                           "cpu_count": config.CPU_LIMIT,
                           "rasters_mb": round(sum(s.raster_cache_mb for s in sessions), 1)},
                "per_session": {s.id: self._resident_mb(s) for s in sessions}}


def _basename(path: str) -> str:
    from ..persistence.store import strip_content_hash, strip_checkpoint_ext
    stem = strip_checkpoint_ext(os.path.basename(path.rstrip("/")))
    return strip_content_hash(stem)
