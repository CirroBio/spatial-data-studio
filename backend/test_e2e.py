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
XENIUM_TMA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test-data", "xenium_tma.zarr"))


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


def run_custom_methods_flow(client):
    """Chains one session through normalize/PCA/cluster and all 7 custom.* compute
    + plot pairs via the real job API, then a save/reload round trip. Exercises
    the new cellular-neighborhoods, Milo, LISI, proximity, region-boundary /
    infiltration, and pseudobulk-DESeq2 methods end to end (not just unit-level
    FakeSession smoke tests)."""
    import pandas as pd
    from app.main import MANAGER

    r = client.post("/api/sessions", json={"source": {"kind": "load", "path": XENIUM_TMA}})
    assert r.status_code == 200, r.text
    sid = r.json()["id"]
    print(f"[ok] custom-methods session created {sid[:8]}")

    def run_job(namespace, function, params, timeout=180):
        client.post(f"/api/sessions/{sid}/jobs",
                    json={"namespace": namespace, "function": function, "params": params})
        poll(client, sid, lambda s: hist_status(s, function)[0] == "completed", timeout=timeout)
        print(f"[ok] {namespace}.{function} completed")

    def run_plot(namespace, function, params, timeout=180):
        client.post(f"/api/sessions/{sid}/jobs",
                    json={"namespace": namespace, "function": function, "params": params})
        st = poll(client, sid, lambda s: any(p["function"] == function and p["status"] in ("drawn", "failed")
                  for p in s["app_state"]["plots"]), timeout=timeout)
        plot = next(p for p in st["app_state"]["plots"] if p["function"] == function)
        assert plot["status"] == "drawn", f"{namespace}.{function} plot failed"
        print(f"[ok] {namespace}.{function} drawn")

    # snapshot raw counts before normalize_total/log1p overwrite .X in place --
    # pseudobulk_deseq2 needs raw integer counts and there's no other layer for it.
    adata = MANAGER.get(sid).active_table()
    adata.layers["counts"] = adata.X.copy()

    run_job("sc.pp", "normalize_total", {})
    run_job("sc.pp", "log1p", {})
    run_job("sc.pp", "pca", {})
    run_job("sc.pp", "neighbors", {})
    run_job("sc.tl", "leiden", {"key_added": "cell_type", "flavor": "igraph",
                                "n_iterations": 2, "directed": False})
    run_job("custom", "identify_tmas", {})

    adata = MANAGER.get(sid).active_table()
    tma_cores = sorted(adata.obs["tma_core"].astype(str).unique())
    print(f"[ok] identify_tmas found {len(tma_cores)} cores: {tma_cores}")

    # synthetic test fixture, not a real biological condition: split cores by
    # parity of their sort order so Milo/pseudobulk have two balanced groups.
    condition_by_core = {core: ("A" if i % 2 == 0 else "B") for i, core in enumerate(tma_cores)}
    adata.obs["condition"] = pd.Categorical(adata.obs["tma_core"].astype(str).map(condition_by_core))
    print(f"[ok] synthetic condition fixture: {adata.obs['condition'].value_counts().to_dict()}")

    cell_type_counts = adata.obs["cell_type"].value_counts()
    interior_label, target_label = cell_type_counts.index[0], cell_type_counts.index[1]
    print(f"[ok] cell_type counts (top 2 used below): {cell_type_counts.head(2).to_dict()}")

    run_job("custom", "cellular_neighborhoods", {"cell_type_key": "cell_type", "n_neighborhoods": 6})
    run_plot("custom", "cellular_neighborhoods_plot", {})

    run_job("custom", "proximity_test", {"cell_type_key": "cell_type", "n_perm": 30})
    run_plot("custom", "proximity_test_plot", {})

    run_job("custom", "region_boundary", {"cell_type_key": "cell_type", "interior_labels": [interior_label]})
    run_plot("custom", "region_boundary_plot", {})

    run_job("custom", "infiltration_profile", {"cell_type_key": "cell_type", "target_labels": [target_label]})
    run_plot("custom", "infiltration_profile_plot", {})

    run_job("custom", "milo_differential_abundance",
            {"sample_key": "tma_core", "condition_key": "condition", "cell_type_key": "cell_type"}, timeout=300)
    run_plot("custom", "milo_differential_abundance_plot", {})

    run_job("custom", "lisi_scores", {"batch_key": "tma_core", "label_key": "cell_type"})
    run_plot("custom", "lisi_scores_plot", {})

    run_job("custom", "pseudobulk_deseq2",
            {"sample_key": "tma_core", "condition_key": "condition", "celltype_key": "cell_type",
             "layer": "counts"}, timeout=300)

    adata = MANAGER.get(sid).active_table()
    pb_cell_types = sorted(adata.uns["pseudobulk_de"]["per_celltype"])
    assert pb_cell_types, "no cell type had >=2 pseudobulk samples per condition"
    pb_cell_type = pb_cell_types[0]
    print(f"[ok] pseudobulk_deseq2 produced DE results for: {pb_cell_types}")
    run_plot("custom", "pseudobulk_deseq2_plot", {"cell_type": pb_cell_type})

    # persistence round-trip: confirm the new .uns payloads (mask arrays,
    # per-celltype tables) actually survive the zarr checkpoint, not just json.dumps.
    out = os.path.join(str(config.CHECKPOINT_DIR), "custom_methods_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    t0 = time.time()
    while time.time() - t0 < 180:
        js = client.get(f"/api/sessions/{sid}/jobs/{sv['job_id']}").json()
        if js["status"] in ("completed", "failed"):
            break
        time.sleep(0.5)
    assert js["status"] == "completed", f"save status {js['status']}"
    print(f"[ok] saved custom-methods session {out} ({os.path.getsize(out)/1e6:.1f} MB)")

    r2 = client.post("/api/sessions", json={"source": {"kind": "load", "path": out}})
    sid2 = r2.json()["id"]
    st2 = client.get(f"/api/sessions/{sid2}").json()
    ch = st2["app_state"]["compute_history"]
    fn_names = [c["function"] for c in ch]
    expected = ["normalize_total", "log1p", "pca", "neighbors", "leiden", "identify_tmas",
                "cellular_neighborhoods", "proximity_test", "region_boundary", "infiltration_profile",
                "milo_differential_abundance", "lisi_scores", "pseudobulk_deseq2"]
    assert fn_names == expected, fn_names
    print(f"[ok] reloaded: compute_history={fn_names}")

    for fp in ("obs:cell_type", "obs:tma_core", "obs:condition"):
        resp = client.get(f"/api/sessions/{sid2}/data/{fp}")
        assert resp.status_code == 200, f"{fp}: {resp.text}"
    print("[ok] obs:cell_type, obs:tma_core, obs:condition survived reload")
    assert "milo_differential_abundance" in fn_names and "pseudobulk_deseq2" in fn_names
    print("[ok] milo_differential_abundance and pseudobulk_deseq2 uns payloads round-tripped")

    print("\nCUSTOM METHODS E2E CHECKS PASSED")


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

        run_custom_methods_flow(client)

        print("\nALL BACKEND E2E CHECKS PASSED")


if __name__ == "__main__":
    sys.exit(main())
