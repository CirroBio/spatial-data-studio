"""End-to-end backend test against the real visium_hne dataset (no Docker/frontend).
Exercises: load -> compute -> compute -> Arrow fetch -> plot -> save -> reload.
"""
import io
import os
import sys
import time
import tempfile

import pyarrow.ipc as ipc
from fastapi.testclient import TestClient

os.environ.setdefault("SQV_CONTAINER_MEM_MB", "32768")
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SQV_DATA_DIR", os.path.join(_REPO_ROOT, "test-data"))
os.environ.setdefault("SQV_CHECKPOINT_DIR", tempfile.mkdtemp())
from app.main import app  # noqa: E402
from app.config import config  # noqa: E402

DATA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test-data", "visium_hne.zarr"))


def poll(client, sid, predicate, timeout=180):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = client.get(f"/api/sessions/{sid}").json()
        if predicate(st):
            return st
        time.sleep(0.5)
    raise TimeoutError(f"timed out; last state queue={st.get('queue')}")


def hist_status(st, fn):
    for r in st["app_state"]["compute_history"]:
        if r["function"] == fn:
            return r["status"], r.get("structural_diff")
    return None, None


def main():
    with TestClient(app) as client:
        assert client.get("/api/readyz").json()["functions"] > 0
        nf = client.get("/api/functions").json()
        print(f"[ok] registry: {len(nf['functions'])} functions, squidpy {nf['squidpy_version']}")

        r = client.post("/api/sessions", json={"source": {"kind": "load", "path": DATA}})
        assert r.status_code == 200, r.text
        sid = r.json()["id"]
        print(f"[ok] session created {sid[:8]} resident~{r.json()['resident_mb']}MB status={r.json()['status']}")

        st = client.get(f"/api/sessions/{sid}").json()
        print(f"[ok] fields: obs={len(st['fields']['obs'])} cols, obsm={st['fields']['obsm']}, "
              f"images={st['fields']['images']}, var_count={st['fields']['var_names_count']}")
        assert st["app_state"]["displays"], "auto-display not generated"
        print(f"[ok] auto-display encoding: {st['app_state']['displays'][0]['encoding']}")

        # compute 1: spatial_neighbors
        client.post(f"/api/sessions/{sid}/jobs", json={
            "namespace": "gr", "function": "spatial_neighbors",
            "params": {"coord_type": "generic", "n_neighs": 6}})
        st = poll(client, sid, lambda s: hist_status(s, "spatial_neighbors")[0] in ("completed", None) and
                  hist_status(s, "spatial_neighbors")[0] == "completed")
        _, diff = hist_status(st, "spatial_neighbors")
        print(f"[ok] spatial_neighbors completed; structural_diff={diff}")
        assert "obsp" in diff and "spatial_distances" in diff["obsp"]

        # compute 2: nhood_enrichment
        client.post(f"/api/sessions/{sid}/jobs", json={
            "namespace": "gr", "function": "nhood_enrichment",
            "params": {"cluster_key": "leiden", "seed": 0, "show_progress_bar": False}})
        st = poll(client, sid, lambda s: hist_status(s, "nhood_enrichment")[0] == "completed")
        print("[ok] nhood_enrichment completed")

        # Arrow fetches
        for fp, cols in [("obs:leiden", "code"), ("obsm:spatial", "d0"), ("X:Sox17", "value"),
                         ("obsp:spatial_distances", "row")]:
            resp = client.get(f"/api/sessions/{sid}/data/{fp}")
            assert resp.status_code == 200, f"{fp}: {resp.text}"
            reader = ipc.open_stream(io.BytesIO(resp.content))
            batch = reader.read_all()
            meta = batch.schema.metadata or {}
            print(f"[ok] arrow {fp}: rows={batch.num_rows} cols={batch.column_names} "
                  f"meta={ {k.decode(): v.decode()[:40] for k,v in meta.items()} }")
            assert cols in batch.column_names

        # image
        info = client.get(f"/api/sessions/{sid}/image/hne/info")
        print(f"[ok] image info: {info.json() if info.status_code==200 else info.text}")
        thumb = client.get(f"/api/sessions/{sid}/image/hne/thumbnail?max_px=512")
        print(f"[ok] image thumbnail: status={thumb.status_code} bytes={len(thumb.content)}")

        # plot
        client.post(f"/api/sessions/{sid}/jobs", json={
            "namespace": "pl", "function": "nhood_enrichment", "params": {"cluster_key": "leiden"}})
        st = poll(client, sid, lambda s: any(p["function"] == "nhood_enrichment" and
                  p["status"] in ("drawn", "failed") for p in s["app_state"]["plots"]))
        plot = next(p for p in st["app_state"]["plots"] if p["function"] == "nhood_enrichment")
        print(f"[ok] plot status={plot['status']} references={plot['references']}")
        assert plot["status"] == "drawn", "plot failed"
        fig = client.get(f"/api/sessions/{sid}/plots/{plot['id']}/figure?fmt=svg")
        assert fig.status_code == 200 and fig.content[:5] in (b"<?xml", b"<svg "), fig.content[:50]
        print(f"[ok] figure svg bytes={len(fig.content)}")

        # save (must land under CHECKPOINT_DIR — the save endpoint validates the target path)
        out = os.path.join(str(config.CHECKPOINT_DIR), "session.zarr.zip")
        sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
        t0 = time.time()
        while time.time() - t0 < 180:
            js = client.get(f"/api/sessions/{sid}/jobs/{sv['job_id']}").json()
            if js["status"] in ("completed", "failed"):
                break
            time.sleep(0.5)
        assert js["status"] == "completed", f"save status {js['status']}"
        assert os.path.exists(out) and os.path.getsize(out) > 10_000, \
            f"save produced {os.path.getsize(out) if os.path.exists(out) else 0} bytes"
        print(f"[ok] saved {out} ({os.path.getsize(out)/1e6:.1f} MB)")

        # reload into a NEW session, verify app_state preserved
        r2 = client.post("/api/sessions", json={"source": {"kind": "load", "path": out}})
        sid2 = r2.json()["id"]
        st2 = client.get(f"/api/sessions/{sid2}").json()
        ch = st2["app_state"]["compute_history"]
        pl = st2["app_state"]["plots"]
        disp = st2["app_state"]["displays"]
        print(f"[ok] reloaded: compute_history={[c['function'] for c in ch]} "
              f"plots={[(p['function'],p['status']) for p in pl]} displays={len(disp)}")
        assert [c["function"] for c in ch] == ["spatial_neighbors", "nhood_enrichment"]
        assert any(p["function"] == "nhood_enrichment" for p in pl)
        assert disp, "displays not preserved"
        # verify computed field survived the round trip
        resp = client.get(f"/api/sessions/{sid2}/data/obsp:spatial_distances")
        assert resp.status_code == 200
        print("[ok] computed obsp survived reload")

        print("\nALL BACKEND E2E CHECKS PASSED")


if __name__ == "__main__":
    sys.exit(main())
