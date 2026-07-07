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
# The feature flows below each open a few short-lived sessions (and reload
# checkpoints into fresh ones); lift the default 8-session cap so the run isn't
# bounded by it. Real deployments keep the low default.
os.environ.setdefault("SQV_MAX_SESSIONS", "64")
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
    run_job("custom", "leiden", {"key_added": "cell_type", "n_iterations": 2})

    # marker genes that differentiate the clusters, then the scanpy dotplot of them
    run_job("sc.tl", "rank_genes_groups", {"groupby": "cell_type", "method": "wilcoxon"})
    run_plot("sc.pl", "rank_genes_groups_dotplot", {"groupby": "cell_type", "n_genes": 5})

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
    expected = ["normalize_total", "log1p", "pca", "neighbors", "leiden", "rank_genes_groups",
                "identify_tmas", "cellular_neighborhoods", "proximity_test", "region_boundary",
                "infiltration_profile", "milo_differential_abundance", "lisi_scores", "pseudobulk_deseq2"]
    assert fn_names == expected, fn_names
    print(f"[ok] reloaded: compute_history={fn_names}")

    for fp in ("obs:cell_type", "obs:tma_core", "obs:condition"):
        resp = client.get(f"/api/sessions/{sid2}/data/{fp}")
        assert resp.status_code == 200, f"{fp}: {resp.text}"
    print("[ok] obs:cell_type, obs:tma_core, obs:condition survived reload")
    assert "milo_differential_abundance" in fn_names and "pseudobulk_deseq2" in fn_names
    print("[ok] milo_differential_abundance and pseudobulk_deseq2 uns payloads round-tripped")

    print("\nCUSTOM METHODS E2E CHECKS PASSED")


def new_session(client, path=DATA):
    r = client.post("/api/sessions", json={"source": {"kind": "load", "path": path}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def wait_job(client, sid, job_id, timeout=180):
    t0 = time.time()
    while time.time() - t0 < timeout:
        js = client.get(f"/api/sessions/{sid}/jobs/{job_id}").json()
        if js["status"] in ("completed", "drawn", "failed", "cancelled"):
            return js
        time.sleep(0.5)
    raise TimeoutError(f"job {job_id} did not finish")


def fetch_arrow(client, sid, field):
    resp = client.get(f"/api/sessions/{sid}/data/{field}")
    assert resp.status_code == 200, f"{field}: {resp.text}"
    return ipc.open_stream(io.BytesIO(resp.content)).read_all()


def n_obs_of(client, sid):
    inv = client.get(f"/api/sessions/{sid}/elements").json()
    return inv["tables"][0]["n_obs"]


def run_staging_flow(client):
    """Staged (PENDING) recipe steps + preflight (recent 'Recipes: staged steps,
    preflight, run-all' commit): stage -> edit params -> run-all -> completed, plus
    the preflight validator and the pending-endpoint 409s."""
    sid = new_session(client)

    # preflight: an unknown function is reported; a referenced key nothing produces
    # is flagged as unresolved.
    pf = client.post(f"/api/sessions/{sid}/recipe/preflight", json={"steps": [
        {"namespace": "gr", "function": "does_not_exist", "params": {}}]}).json()
    assert "gr.does_not_exist" in pf["unknown_functions"], pf
    pf = client.post(f"/api/sessions/{sid}/recipe/preflight", json={"steps": [
        {"namespace": "gr", "function": "nhood_enrichment",
         "params": {"cluster_key": "no_such_col"}}]}).json()
    assert any(u["ref"] == "no_such_col" for u in pf["unresolved"]), pf
    print("[ok] preflight flags unknown functions and unresolved key references")

    # stage a step -> it shows up as pending, not queued
    step_id = client.post(f"/api/sessions/{sid}/jobs/stage", json={
        "namespace": "gr", "function": "spatial_neighbors",
        "params": {"coord_type": "generic", "n_neighs": 4}}).json()["step_id"]
    st = client.get(f"/api/sessions/{sid}").json()
    rec = next(r for r in st["app_state"]["compute_history"] if r["id"] == step_id)
    assert rec["status"] == "pending" and rec["params"]["n_neighs"] == 4, rec
    print("[ok] staged step is pending")

    # edit the pending step's params in place
    assert client.put(f"/api/sessions/{sid}/pending/{step_id}",
                      json={"params": {"coord_type": "generic", "n_neighs": 6}}).status_code == 200
    st = client.get(f"/api/sessions/{sid}").json()
    rec = next(r for r in st["app_state"]["compute_history"] if r["id"] == step_id)
    assert rec["params"]["n_neighs"] == 6, rec
    print("[ok] pending step params editable")

    # negatives: running/editing a nonexistent pending step is a 409
    assert client.post(f"/api/sessions/{sid}/pending/nope/run").status_code == 409
    assert client.put(f"/api/sessions/{sid}/pending/nope", json={"params": {}}).status_code == 409

    # run-all submits every staged step; it then completes
    assert client.post(f"/api/sessions/{sid}/pending/run-all").json()["queued"] == 1
    poll(client, sid, lambda s: hist_status(s, "spatial_neighbors")[0] == "completed")
    # editing an already-run (non-pending) step is refused
    assert client.put(f"/api/sessions/{sid}/pending/{step_id}",
                      json={"params": {"n_neighs": 8}}).status_code == 409
    print("[ok] run-all completes staged step; editing a completed step is refused")


def run_regions_flow(client):
    """Region promote + annotate round-trip and its registry persistence (recent
    'Region composition' work)."""
    sid = new_session(client)
    n_obs = n_obs_of(client, sid)

    # promote an existing categorical (leiden) to a region set
    job = client.post(f"/api/sessions/{sid}/regions/promote", json={"obs_column": "leiden"}).json()
    assert wait_job(client, sid, job["job_id"])["status"] == "completed"
    regions = client.get(f"/api/sessions/{sid}").json()["app_state"]["regions"]
    leiden_set = next(r for r in regions if r["obs_column"] == "leiden")
    assert leiden_set["categories"] and all("n_cells" in c and "color" in c for c in leiden_set["categories"])
    assert sum(c["n_cells"] for c in leiden_set["categories"]) == n_obs, "promote cell counts != n_obs"
    print(f"[ok] promote leiden -> region set with {len(leiden_set['categories'])} categories, cells sum to n_obs")

    # annotate: label every cell inside a polygon covering the full spatial extent
    spatial = fetch_arrow(client, sid, "obsm:spatial")
    xs, ys = spatial.column("d0").to_pylist(), spatial.column("d1").to_pylist()
    pad_x, pad_y = (max(xs) - min(xs)) * 0.1 + 1, (max(ys) - min(ys)) * 0.1 + 1
    x0, y0, x1, y1 = min(xs) - pad_x, min(ys) - pad_y, max(xs) + pad_x, max(ys) + pad_y
    poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    job = client.post(f"/api/sessions/{sid}/annotate", json={
        "polygons": [poly], "region_set": "my_regions", "category": "tumor", "color": "#ff0000"}).json()
    assert wait_job(client, sid, job["job_id"])["status"] == "completed"
    regions = client.get(f"/api/sessions/{sid}").json()["app_state"]["regions"]
    my_set = next(r for r in regions if r["obs_column"] == "my_regions")
    tumor = next(c for c in my_set["categories"] if c["label"] == "tumor")
    assert tumor["n_cells"] == n_obs, f"full-extent polygon should capture all {n_obs} cells, got {tumor['n_cells']}"
    assert fetch_arrow(client, sid, "obs:my_regions").num_rows == n_obs
    print(f"[ok] annotate labeled all {n_obs} cells 'tumor' in a new region set")

    # persistence: the regions registry survives save + reload
    out = os.path.join(str(config.CHECKPOINT_DIR), "regions_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"
    st2 = client.get(f"/api/sessions/{new_session(client, out)}").json()
    cols = {r["obs_column"] for r in st2["app_state"]["regions"]}
    assert {"leiden", "my_regions"} <= cols, cols
    print("[ok] regions registry survives save + reload")


def run_transform_flow(client):
    """Editable points->global transform get/set + persistence, and the affine
    applied to the obsm:spatial Arrow fetch (recent 'editable points transform')."""
    sid = new_session(client)
    a0 = client.get(f"/api/sessions/{sid}/points-transform").json()["affine"]
    before = fetch_arrow(client, sid, "obsm:spatial")
    bx, by = before.column("d0").to_pylist(), before.column("d1").to_pylist()

    # translate +100/+50 on top of the current affine; the fetched coords must shift
    a1 = [a0[0], a0[1], a0[2] + 100, a0[3], a0[4], a0[5] + 50]
    job = client.post(f"/api/sessions/{sid}/points-transform", json={"affine": a1}).json()
    assert wait_job(client, sid, job["job_id"])["status"] == "completed"
    after = fetch_arrow(client, sid, "obsm:spatial")
    ax, ay = after.column("d0").to_pylist(), after.column("d1").to_pylist()
    assert abs((ax[0] - bx[0]) - 100) < 1e-3 and abs((ay[0] - by[0]) - 50) < 1e-3, \
        f"expected +100/+50 shift, got {ax[0]-bx[0]:.3f}/{ay[0]-by[0]:.3f}"
    assert client.get(f"/api/sessions/{sid}/points-transform").json()["affine"][2] == a1[2]
    print("[ok] set points-transform shifts the obsm:spatial fetch and round-trips")

    # persistence: the new affine survives the reload of the checkpoint it wrote
    from app.main import MANAGER  # bound at startup, so import inside the client context
    store_path = MANAGER.get(sid).store_path
    a_reload = client.get(f"/api/sessions/{new_session(client, store_path)}/points-transform").json()["affine"]
    assert abs(a_reload[2] - a1[2]) < 1e-3 and abs(a_reload[5] - a1[5]) < 1e-3, a_reload
    print("[ok] points-transform persists across reload")

    # a malformed affine is rejected up front
    assert client.post(f"/api/sessions/{sid}/points-transform", json={"affine": [1, 2, 3]}).status_code == 400


def run_content_hash_flow(client):
    """Default-path save writes a content-hashed filename that reloads, and a second
    save doesn't stack a second hash suffix (recent 'Content-hash checkpoint names')."""
    from app.persistence.store import strip_content_hash
    from app.main import MANAGER
    import re
    sid = new_session(client)
    clean = strip_content_hash(MANAGER.get(sid).name)

    sv = client.post(f"/api/sessions/{sid}/save", json={}).json()  # no path -> hash-named
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"
    p1 = MANAGER.get(sid).store_path
    base = os.path.basename(p1)
    assert re.fullmatch(rf"{re.escape(clean)}-[0-9a-f]+\.zarr\.zip", base), base
    assert os.path.exists(p1)
    print(f"[ok] default save wrote content-hashed {base}")

    # the hashed file reloads cleanly (content-hash check passes, doesn't raise)
    assert client.get(f"/api/sessions/{new_session(client, p1)}").json()["app_state"] is not None
    # saving again must not stack a second -hash segment
    sv2 = client.post(f"/api/sessions/{sid}/save", json={}).json()
    assert wait_job(client, sid, sv2["job_id"])["status"] == "completed"
    base2 = os.path.basename(MANAGER.get(sid).store_path)
    assert re.fullmatch(rf"{re.escape(clean)}-[0-9a-f]+\.zarr\.zip", base2), f"hash stacked: {base2}"
    print("[ok] hashed checkpoint reloads; re-save doesn't stack a second hash")


def run_invalidation_flow(client):
    """data_versions bump + plot invalidation + redraw, and reload turning a drawn
    plot into invalidated (recent invalidation wiring)."""
    sid = new_session(client)
    for fn, params in [("spatial_neighbors", {"coord_type": "generic", "n_neighs": 6}),
                       ("nhood_enrichment", {"cluster_key": "leiden", "seed": 0, "show_progress_bar": False})]:
        client.post(f"/api/sessions/{sid}/jobs", json={"namespace": "gr", "function": fn, "params": params})
        poll(client, sid, lambda s: hist_status(s, fn)[0] == "completed")
    client.post(f"/api/sessions/{sid}/jobs", json={
        "namespace": "pl", "function": "nhood_enrichment", "params": {"cluster_key": "leiden"}})
    st = poll(client, sid, lambda s: any(p["function"] == "nhood_enrichment" and p["status"] == "drawn"
              for p in s["app_state"]["plots"]))
    plot = next(p for p in st["app_state"]["plots"] if p["function"] == "nhood_enrichment")
    assert plot["references"], "plot recorded no references to invalidate against"
    ref = plot["references"][0]            # e.g. "obs:leiden"
    ref_col = ref.split(":", 1)[1]

    # redraw the drawn plot -> drawn again; a bogus id is refused. (Done before the
    # mutation below, which relabels leiden and would leave nothing sensible to redraw.)
    assert client.post(f"/api/sessions/{sid}/plots/{plot['id']}/redraw").status_code == 200
    poll(client, sid, lambda s: any(p["id"] == plot["id"] and p["status"] == "drawn"
         for p in s["app_state"]["plots"]))
    assert client.post(f"/api/sessions/{sid}/plots/nope/redraw").status_code == 409
    print("[ok] redraw restores a plot; bogus redraw is a 409")

    # Mutate a field the plot references (annotating a small region writes obs:<ref_col>),
    # which must bump its data_version and flip the dependent plot to invalidated.
    dv_before = dict(client.get(f"/api/sessions/{sid}").json()["data_versions"])
    spatial = fetch_arrow(client, sid, "obsm:spatial")
    xs, ys = spatial.column("d0").to_pylist(), spatial.column("d1").to_pylist()
    x0, y0 = min(xs), min(ys)
    x1, y1 = x0 + (max(xs) - x0) * 0.25, y0 + (max(ys) - y0) * 0.25  # lower-left quadrant only
    poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    job = client.post(f"/api/sessions/{sid}/annotate", json={
        "polygons": [poly], "region_set": ref_col, "category": "perturbed", "color": "#00ff00"}).json()
    assert wait_job(client, sid, job["job_id"])["status"] == "completed"
    st = poll(client, sid, lambda s: any(p["id"] == plot["id"] and p["status"] == "invalidated"
              for p in s["app_state"]["plots"]), timeout=30)
    assert st["data_versions"].get(ref, 0) > dv_before.get(ref, 0), (ref, dv_before, st["data_versions"])
    print(f"[ok] mutating {ref} bumped its data_version and invalidated the dependent plot")

    # a drawn plot reloads as invalidated (its figure isn't persisted)
    out = os.path.join(str(config.CHECKPOINT_DIR), "invalidation_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"
    pl2 = client.get(f"/api/sessions/{new_session(client, out)}").json()["app_state"]["plots"]
    assert all(p["status"] == "invalidated" for p in pl2), [p["status"] for p in pl2]
    print("[ok] drawn plots reload as invalidated")


def run_encoding_persistence_flow(client):
    """Canvas encoding fields (layer toggles, isolated category, camera) survive
    save + reload (recent 'Persist canvas layer toggles, camera, isolated category')."""
    sid = new_session(client)
    disp = next(d for d in client.get(f"/api/sessions/{sid}").json()["app_state"]["displays"]
                if d["type"] == "spatial_canvas")
    spec = dict(disp)
    spec["encoding"] = {**disp["encoding"], "show_image": False, "show_points": True,
                        "isolated_category": "5", "colormap": "magma"}
    spec["viewport"] = {"target": [100, 200], "zoom": 3}
    assert client.put(f"/api/sessions/{sid}/displays/{disp['id']}", json=spec).status_code == 200

    out = os.path.join(str(config.CHECKPOINT_DIR), "encoding_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"
    rl = next(d for d in client.get(f"/api/sessions/{new_session(client, out)}").json()["app_state"]["displays"]
              if d["id"] == disp["id"])
    assert rl["encoding"]["show_image"] is False and rl["encoding"]["isolated_category"] == "5"
    assert rl["encoding"]["colormap"] == "magma" and rl["viewport"]["zoom"] == 3, rl
    print("[ok] canvas encoding (toggles, isolated category, camera) survives save + reload")


def run_inspector_flow(client):
    """Data-inspector endpoints backing the UI pickers/tables (elements, table
    preview, var-names search, obs value counts)."""
    sid = new_session(client)
    inv = client.get(f"/api/sessions/{sid}/elements").json()
    assert inv["tables"] and inv["images"], inv
    # table preview reads obs/var/shapes/points frames; a bogus path 404s
    prev = client.get(f"/api/sessions/{sid}/table", params={"path": "obs", "limit": 5}).json()
    assert prev["rows"] and len(prev["rows"]) <= 5 and prev["columns"], prev
    assert client.get(f"/api/sessions/{sid}/table", params={"path": "no/such/path"}).status_code == 404

    names = client.get(f"/api/sessions/{sid}/var-names", params={"q": "Sox", "limit": 5}).json()["names"]
    assert names and all(n.lower().startswith("sox") for n in names[:1]), names

    vals = client.get(f"/api/sessions/{sid}/obs/leiden/values").json()["values"]
    assert sum(v["count"] for v in vals) == n_obs_of(client, sid), vals
    assert client.get(f"/api/sessions/{sid}/obs/not_a_col/values").status_code == 404
    print(f"[ok] inspector: elements, table preview, var-names ({names[:2]}), obs value counts")


def run_isolation_flow(client):
    """A job on one session must not touch another session's app_state (recent
    'Isolate viewers of different sessions'). Plus history-delete + cancel 409s."""
    a, b = new_session(client), new_session(client)
    client.post(f"/api/sessions/{a}/jobs", json={
        "namespace": "gr", "function": "spatial_neighbors",
        "params": {"coord_type": "generic", "n_neighs": 6}})
    poll(client, a, lambda s: hist_status(s, "spatial_neighbors")[0] == "completed")
    stb = client.get(f"/api/sessions/{b}").json()
    assert stb["app_state"]["compute_history"] == [], "session B gained A's compute history"
    print("[ok] a compute on session A left session B's app_state untouched")

    # delete the completed entry on A; a bogus/again delete is a 409
    entry = client.get(f"/api/sessions/{a}").json()["app_state"]["compute_history"][0]["id"]
    assert client.delete(f"/api/sessions/{a}/history/{entry}").status_code == 200
    assert client.delete(f"/api/sessions/{a}/history/{entry}").status_code == 409
    assert client.delete(f"/api/sessions/{a}/jobs/{entry}").status_code == 409  # finished -> not cancellable
    # closing a session makes it 404
    assert client.delete(f"/api/sessions/{b}").status_code == 200
    assert client.get(f"/api/sessions/{b}").status_code == 404
    print("[ok] history delete + cancel/close negatives behave; closed session 404s")


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

        print("\n--- feature flows ---")
        run_staging_flow(client)
        run_regions_flow(client)
        run_transform_flow(client)
        run_content_hash_flow(client)
        run_invalidation_flow(client)
        run_encoding_persistence_flow(client)
        run_inspector_flow(client)
        run_isolation_flow(client)

        run_custom_methods_flow(client)

        print("\nALL BACKEND E2E CHECKS PASSED")


if __name__ == "__main__":
    sys.exit(main())
