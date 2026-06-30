"""Session manager (DESIGN §11). Owns the session table, load-admission and the
80% boundary check (§11.3), lasso subset → child session (§8), and the resource
sampler (§11.3). One shared process; one worker thread per session.
"""
import copy
import uuid

import psutil

from . import appstate
from .session import Session, _now
from ..config import config
from ..persistence.store import load_spatialdata, estimate_resident_mb, save_spatialdata
from ..transport.sse import BUS


class SessionManager:
    def __init__(self, registry):
        self.registry = registry
        self.sessions: dict[str, Session] = {}
        self._proc = psutil.Process()

    # ---- creation ---------------------------------------------------------
    def create_from_load(self, path: str, name: str | None = None) -> Session:
        self._check_capacity()
        self._check_admission(estimate_resident_mb(path))
        sdata, app_state, newer, extract_dir = load_spatialdata(path)
        sid = str(uuid.uuid4())
        name = name or _basename(path)
        sess = Session(sid, name, sdata, app_state, self, store_path=path)
        sess.extract_dir = extract_dir
        if not app_state["displays"]:
            self._auto_displays(sess)
        self.sessions[sid] = sess
        if newer:
            BUS.publish("memory.warning", {"session_id": sid,
                        "message": "app_state schema newer than app; opened read-only"})
        BUS.publish("session.created", {"session_id": sid, "summary": self.summary(sess)})
        return sess

    def create_from_read(self, descriptor: dict, name: str | None = None) -> Session:
        self._check_capacity()
        sid = str(uuid.uuid4())
        sess = Session(sid, name or descriptor.get("function", "session"), None, appstate.fresh(), self)
        self.sessions[sid] = sess
        sess.enqueue_descriptor(descriptor)  # read bootstrap is the first queue job (§12)
        BUS.publish("session.created", {"session_id": sid, "summary": self.summary(sess)})
        return sess

    def _auto_displays(self, sess: Session):
        """Generate a default spatial canvas (DESIGN §9.1)."""
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
                         "point_size": 4, "opacity": 0.85, "colormap": "viridis"},
            "viewport": None,
        })

    # ---- queries ----------------------------------------------------------
    def get(self, sid: str) -> Session | None:
        return self.sessions.get(sid)

    def summary(self, sess: Session) -> dict:
        return {"id": sess.id, "name": sess.name, "status": sess.status,
                "resident_mb": self._resident_mb(sess), "parent_id": sess.parent_id,
                "created_at": sess.created_at}

    def list_summaries(self) -> list:
        return [self.summary(s) for s in self.sessions.values()]

    def state(self, sess: Session) -> dict:
        from ..transport.arrow import describe_fields
        fields = {}
        try:
            fields = describe_fields(sess.active_table(), sess.sdata)
        except RuntimeError:
            pass
        return {"summary": self.summary(sess), "app_state": sess.app_state,
                "queue": sess.queue_view(), "fields": fields,
                "data_versions": sess.app_state["data_versions"]}

    # ---- subset → child (DESIGN §8) --------------------------------------
    def perform_subset(self, parent: Session, payload: dict) -> Session:
        import spatialdata as sd
        from shapely.geometry import Polygon, MultiPolygon
        rings = payload["polygons"]
        polys = []
        for r in rings:
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
        cs = payload.get("coordinate_system") or (parent.sdata.coordinate_systems[0])
        try:
            result = sd.polygon_query(parent.sdata, geom, target_coordinate_system=cs, filter_table=True)
        except Exception:
            # MultiPolygon rejected by this version: per-polygon query + concat (§8.1)
            parts = [sd.polygon_query(parent.sdata, p, target_coordinate_system=cs, filter_table=True) for p in polys]
            result = sd.concatenate(parts) if len(parts) > 1 else parts[0]

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

        # parent eviction (§8.3)
        if payload.get("save_parent") and parent.store_path:
            save_spatialdata(parent.sdata, parent.store_path, parent.app_state)
        self.close(parent.id, save=False)
        return child

    # ---- close / evict ----------------------------------------------------
    def close(self, sid: str, save: bool = False):
        sess = self.sessions.pop(sid, None)
        if sess is None:
            return
        if save and sess.store_path:
            save_spatialdata(sess.sdata, sess.store_path, sess.app_state)
        sess.shutdown()
        sess.sdata = None
        if sess.extract_dir:
            import shutil
            shutil.rmtree(sess.extract_dir, ignore_errors=True)  # unpacked .zarr.zip temp (DESIGN §13)

    # ---- memory (DESIGN §11.3) -------------------------------------------
    def _rss_mb(self) -> float:
        return self._proc.memory_info().rss / 1e6

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
        avail = config.CONTAINER_MEM_MB - self._rss_mb()
        if resident_mb > avail:
            raise RuntimeError(
                f"load blocked: estimated {resident_mb:.0f} MB exceeds available {avail:.0f} MB")

    def admit_job(self, sess: Session) -> bool:
        pct = self._rss_mb() / config.CONTAINER_MEM_MB
        if pct >= config.ADMISSION_PCT:
            BUS.publish("memory.warning", {"session_id": sess.id,
                        "message": f"RSS at {pct*100:.0f}% (>= {config.ADMISSION_PCT*100:.0f}%); job held"})
            return False
        return True

    def resource_sample(self) -> dict:
        return {"global": {"rss_mb": round(self._rss_mb(), 1),
                           "rss_pct": round(self._rss_mb() / config.CONTAINER_MEM_MB * 100, 1),
                           "cpu_pct": self._proc.cpu_percent()},
                "per_session": {s.id: self._resident_mb(s) for s in self.sessions.values()}}


def _basename(path: str) -> str:
    import os
    return os.path.basename(path.rstrip("/")).replace(".zarr.zip", "").replace(".zarr", "")
