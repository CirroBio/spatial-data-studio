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
        displays = st["app_state"]["displays"]
        assert displays, "auto-display not generated"
        print(f"[ok] auto-display encoding: {displays[0]['encoding']}")

        # embedding_canvas auto-display: visium_hne has X_pca (50 comps) and X_umap (2 comps)
        # in obsm alongside spatial, so auto_displays should pick one as the default embedding.
        emb_displays = [d for d in displays if d["type"] == "embedding_canvas"]
        assert emb_displays, "embedding_canvas auto-display not generated"
        emb = emb_displays[0]
        assert emb["encoding"]["obsm_key"] in ("X_pca", "X_umap")
        print(f"[ok] embedding_canvas auto-display encoding: {emb['encoding']}")

        pca_field = next(f for f in st["fields"]["obsm"] if f["name"] == "X_pca")
        assert pca_field["n_components"] == 50, pca_field
        umap_field = next(f for f in st["fields"]["obsm"] if f["name"] == "X_umap")
        assert umap_field["n_components"] == 2, umap_field
        print(f"[ok] obsm shapes: X_pca={pca_field['n_components']} X_umap={umap_field['n_components']}")

        # obsm fetch now serves every component, not just the first 3 (resolve_field cap removed)
        resp = client.get(f"/api/sessions/{sid}/data/obsm:X_pca")
        assert resp.status_code == 200, resp.text
        reader = ipc.open_stream(io.BytesIO(resp.content))
        pca_batch = reader.read_all()
        assert pca_batch.column_names == [f"d{i}" for i in range(50)], pca_batch.column_names
        print(f"[ok] arrow obsm:X_pca: rows={pca_batch.num_rows} cols={len(pca_batch.column_names)}")

        # POST /displays: lazily add a second embedding_canvas display pointed at X_umap
        new_display = client.post(f"/api/sessions/{sid}/displays", json={
            "type": "embedding_canvas",
            "encoding": {"obsm_key": "X_umap", "x_component": 0, "y_component": 1,
                         "z_component": 1, "is_3d": False, "color_by": "obs:leiden",
                         "point_size": 4, "opacity": 0.85, "colormap": "viridis",
                         "legend_visible": True, "legend_title": ""},
            "viewport": None,
        }).json()
        assert new_display["id"]
        st = client.get(f"/api/sessions/{sid}").json()
        assert any(d["id"] == new_display["id"] for d in st["app_state"]["displays"]), \
            "POST /displays result not reflected in a subsequent GET"
        print(f"[ok] POST /displays created {new_display['id'][:8]} and it round-tripped via GET")

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
        meta = info.json()
        assert meta["levels"] and "pixel_to_world" in meta, "image_info missing pyramid metadata"
        print(f"[ok] image info: {meta}")
        thumb = client.get(f"/api/sessions/{sid}/image/hne/thumbnail?max_px=512")
        print(f"[ok] image thumbnail: status={thumb.status_code} bytes={len(thumb.content)}")
        tile = client.get(f"/api/sessions/{sid}/image/hne/tile/0/0/0?channels=0:ff0000,1:00ff00,2:0000ff")
        assert tile.status_code == 200 and tile.content, f"tile fetch failed: {tile.status_code}"
        print(f"[ok] image tile 0/0/0: status={tile.status_code} bytes={len(tile.content)}")

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
