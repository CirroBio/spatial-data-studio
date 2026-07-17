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

os.environ.setdefault("SDS_CONTAINER_MEM_MB", "32768")
# The feature flows below each open a few short-lived sessions (and reload
# checkpoints into fresh ones); lift the default 8-session cap so the run isn't
# bounded by it. Real deployments keep the low default.
os.environ.setdefault("SDS_MAX_SESSIONS", "64")
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SDS_DATA_DIR", os.path.join(_REPO_ROOT, "test-data"))
os.environ.setdefault("SDS_CHECKPOINT_DIR", tempfile.mkdtemp())
from app.main import app  # noqa: E402
from app.config import config  # noqa: E402

DATA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test-data", "visium_hne.zarr"))
XENIUM_TMA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test-data", "xenium_tma.zarr"))
XENIUM = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test-data", "xenium.zarr"))


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
    """Chains one session through normalize/PCA/cluster and all 8 custom.* compute
    + plot pairs via the real job API, then a save/reload round trip. Exercises
    the cellular-neighborhoods, Milo, LISI, proximity, region-boundary /
    infiltration, pseudobulk-DESeq2, and region-feature-Kruskal methods end to end
    (not just unit-level FakeSession smoke tests)."""
    import pandas as pd
    from app.main import MANAGER

    sid = new_session(client, XENIUM_TMA)
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

    # region feature differences (Kruskal-Wallis) by region, per cell type — the
    # TMA cores stand in for annotated regions here.
    run_job("custom", "region_feature_kruskal", {"celltype_key": "cell_type", "region_key": "tma_core"})
    adata = MANAGER.get(sid).active_table()
    rk_cell_types = sorted(adata.uns["region_kruskal"]["per_celltype"])
    assert rk_cell_types, "no cell type had >=2 regions for the Kruskal-Wallis test"
    print(f"[ok] region_feature_kruskal produced results for: {rk_cell_types}")
    run_plot("custom", "region_feature_kruskal_plot", {})

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
    expected = ["read_zarr", "normalize_total", "log1p", "pca", "neighbors", "leiden", "rank_genes_groups",
                "identify_tmas", "cellular_neighborhoods", "proximity_test", "region_boundary",
                "infiltration_profile", "milo_differential_abundance", "lisi_scores", "pseudobulk_deseq2",
                "region_feature_kruskal"]
    assert fn_names == expected, fn_names
    print(f"[ok] reloaded: compute_history={fn_names}")

    for fp in ("obs:cell_type", "obs:tma_core", "obs:condition"):
        resp = client.get(f"/api/sessions/{sid2}/data/{fp}")
        assert resp.status_code == 200, f"{fp}: {resp.text}"
    print("[ok] obs:cell_type, obs:tma_core, obs:condition survived reload")
    assert "milo_differential_abundance" in fn_names and "pseudobulk_deseq2" in fn_names
    print("[ok] milo_differential_abundance and pseudobulk_deseq2 uns payloads round-tripped")

    print("\nCUSTOM METHODS E2E CHECKS PASSED")


def run_zarr_import_flow(client):
    """SpatialData-zarr importer (io.read_zarr): exercises the underlying archive
    reader on a .zarr dir, a .zarr.zip, and a .zarr.tar.gz, then an API import
    round-trip for each archive (placed under the data dir) into a ready session."""
    import shutil
    import tarfile
    import zipfile

    from app.persistence.store import read_spatialdata_archive

    staging = tempfile.mkdtemp(dir=str(config.DATA_DIR))  # archives must live under DATA_DIR
    zip_path = os.path.join(staging, "xenium_tma.zarr.zip")
    targz_path = os.path.join(staging, "xenium_tma.zarr.tar.gz")
    try:
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_STORED) as zf:
            for root, _, files in os.walk(XENIUM_TMA):
                for f in files:
                    full = os.path.join(root, f)
                    zf.write(full, os.path.relpath(full, XENIUM_TMA))
        with tarfile.open(targz_path, "w:gz") as tf:
            tf.add(XENIUM_TMA, arcname=os.path.basename(XENIUM_TMA))

        # underlying method: every format reads to a SpatialData with tables; only
        # archives allocate a temp extract dir (the caller owns its cleanup).
        for label, p, expect_tmp in [("dir", XENIUM_TMA, False), ("zip", zip_path, True),
                                     ("tar.gz", targz_path, True)]:
            sdata, extract_dir = read_spatialdata_archive(p)
            assert list(getattr(sdata, "tables", {}).keys()), f"{label}: no tables read"
            assert (extract_dir is not None) == expect_tmp, f"{label}: extract_dir={extract_dir}"
            if extract_dir:
                shutil.rmtree(extract_dir, ignore_errors=True)
            print(f"[ok] read_spatialdata_archive({label}) -> tables={list(sdata.tables.keys())}")

        # API import round-trip: each archive bootstraps a ready session via io.read_zarr.
        for label, p in [("zip", zip_path), ("tar.gz", targz_path)]:
            r = client.post("/api/sessions", json={"source": {
                "kind": "read", "namespace": "io", "function": "read_zarr", "params": {"store": p}}})
            assert r.status_code == 200, r.text
            sid = r.json()["id"]
            st = poll(client, sid, lambda s: s["summary"]["status"] in ("ready", "errored"))
            assert st["summary"]["status"] == "ready", f"{label} import errored"
            assert [c["function"] for c in st["app_state"]["compute_history"]] == ["read_zarr"]
            assert st["fields"]["obs"], f"{label}: no obs fields after import"
            assert client.delete(f"/api/sessions/{sid}").status_code == 200
            print(f"[ok] imported {label} archive -> ready session {sid[:8]}")
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    print("[ok] SpatialData-zarr import flow passed")


def new_session(client, path=DATA):
    """Open a checkpoint (a .zarr/.zarr.zip under the checkpoint dir) via `load`, or
    bootstrap a raw dataset under the data dir via the `read_zarr` reader — the strict
    data/checkpoint split means `load` only accepts checkpoint-dir paths. The read
    bootstrap runs on the worker, so wait for the session to become ready."""
    if str(path).startswith(str(config.CHECKPOINT_DIR)):
        r = client.post("/api/sessions", json={"source": {"kind": "load", "path": path}})
        assert r.status_code == 200, r.text
        return r.json()["id"]
    r = client.post("/api/sessions", json={"source": {
        "kind": "read", "namespace": "io", "function": "read_zarr", "params": {"store": path}}})
    assert r.status_code == 200, r.text
    sid = r.json()["id"]
    t0 = time.time()
    while time.time() - t0 < 180:
        st = next((s for s in client.get("/api/sessions").json()["sessions"] if s["id"] == sid), None)
        if st and st["status"] == "ready":
            return sid
        if st and st["status"] == "errored":
            raise RuntimeError(f"read session {sid} errored")
        time.sleep(0.5)
    raise TimeoutError(f"read session {sid} did not become ready")


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


def run_recipe_params_flow(client):
    """Recipe-level parameters: every bundled recipe declares valid param specs and
    dangling-free $param references; caller param_values override a step's value on
    stage; declared defaults apply when no value is given."""
    recipes = client.get("/api/recipes").json()["recipes"]

    # invariant: each declared param is well-formed; each $param reference names one.
    for r in recipes:
        declared = {p["name"] for p in r["params"]}
        for p in r["params"]:
            assert p.get("name") and p.get("widget") and p.get("schema"), (r["name"], p)
        for step in r["steps"]:
            for val in step["params"].values():
                if isinstance(val, dict) and list(val.keys()) == ["$param"]:
                    assert val["$param"] in declared, (r["name"], step["function"], val)
    print(f"[ok] {len(recipes)} recipes: param specs valid, no dangling $param references")

    recipe = next(r for r in recipes if r["name"] == "Neighborhood enrichment")
    body = {"steps": recipe["steps"], "params": recipe["params"]}

    def staged_params(sid, fn):
        st = client.get(f"/api/sessions/{sid}").json()
        rec = next(r for r in st["app_state"]["compute_history"]
                   if r["function"] == fn and r["status"] == "pending")
        return rec["params"]

    # override: n_neighs -> 4 lands in the resolved spatial_neighbors step
    sid = new_session(client)
    assert client.post(f"/api/sessions/{sid}/recipe/run",
                       json={**body, "param_values": {"n_neighs": 4}, "mode": "stage"}).json()["staged"] == 3
    assert staged_params(sid, "spatial_neighbors")["n_neighs"] == 4, staged_params(sid, "spatial_neighbors")

    # default: no param_values -> the declared default (6) applies
    sid = new_session(client)
    assert client.post(f"/api/sessions/{sid}/recipe/run",
                       json={**body, "mode": "stage"}).json()["staged"] == 3
    assert staged_params(sid, "spatial_neighbors")["n_neighs"] == 6, staged_params(sid, "spatial_neighbors")
    print("[ok] recipe param_values override step params; defaults apply otherwise")


def run_sharding_shape_flow():
    """_reshard_array must produce a shard shape divisible by the inner chunk for
    ANY raster level, including a pyramid level whose dimension is < the 512 inner
    chunk (visium's levels are all >512, so its checkpoints never exercised this;
    a 4-channel image with a small coarsest level does — zarr rejects a shard not
    divisible by its inner chunk)."""
    import json
    import shutil
    import tempfile
    import zarr
    from app.persistence import store as store_mod
    for shape in [(4, 430, 1411), (1, 700, 500), (3, 11757, 11291), (430, 430)]:
        d = tempfile.mkdtemp()
        p = os.path.join(d, "arr")
        zarr.create_array(store=p, shape=shape, chunks=shape, dtype="uint8")[:] = 3
        store_mod._reshard_array(p)  # must not raise
        meta = json.load(open(os.path.join(p, "zarr.json")))
        shard = meta["chunk_grid"]["configuration"]["chunk_shape"]
        inner = next(c["configuration"]["chunk_shape"] for c in meta["codecs"]
                     if c["name"] == "sharding_indexed")
        assert all(s % i == 0 for s, i in zip(shard, inner)), \
            f"shard {shard} not divisible by inner {inner} for {shape}"
        assert int(zarr.open_array(p, mode="r")[tuple(slice(0, min(2, s)) for s in shape)].sum()) > 0
        shutil.rmtree(d)
    print("[ok] reshard produces divisible shards for large/small/sub-chunk levels")


def run_snapshot_flow(client, sid):
    """A snapshot is a JSON config pointing at an (auto-saved, content-hashed)
    checkpoint plus a baked render manifest; the browser viewer reads the checkpoint
    directly. Verify save -> list -> config shape -> servable checkpoint."""
    disp = client.get(f"/api/sessions/{sid}").json()["app_state"]["displays"]
    spatial = next((d for d in disp if d["type"] == "spatial_canvas"), None)
    assert spatial, "no spatial display to snapshot"
    r = client.post(f"/api/sessions/{sid}/snapshot",
                    json={"label": "e2e-snap", "viewport": {"target": [100, 100], "zoom": -2},
                          "display_id": spatial["id"]})
    assert r.status_code == 200, r.text
    snap = r.json()
    assert snap["name"].endswith(".json"), snap

    listing = client.get("/api/snapshots").json()["snapshots"]
    entry = next((s for s in listing if s["name"] == snap["name"]), None)
    assert entry and entry["kind"] == "spatial" and entry["checkpoint_url"], f"not listed: {listing}"

    cfg = client.get(snap["url"]).json()
    assert cfg["schema"] == 1 and cfg["checkpoint"]["url"].startswith("/api/checkpoints/")
    assert cfg["render"]["image"] and cfg["render"]["image"]["pixel_to_world"], "missing image manifest"
    assert cfg["render"]["channels"], "missing per-channel manifest"
    ck = client.get(cfg["checkpoint"]["url"], headers={"Range": "bytes=0-9"})
    assert ck.status_code == 206, f"referenced checkpoint not servable: {ck.status_code}"
    print(f"[ok] snapshot {snap['name']} -> checkpoint {cfg['checkpoint']['name']} "
          f"(channels={len(cfg['render']['channels'])})")


def run_regions_flow(client):
    """Region annotate round-trip and its registry persistence (recent
    'Region composition' work)."""
    sid = new_session(client)
    n_obs = n_obs_of(client, sid)

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
    assert "my_regions" in cols, cols
    print("[ok] regions registry survives save + reload")


def run_shape_annotations_flow(client):
    """Shape-annotation editor round trip: create a line/box/text label, update one's
    geometry + style, delete another, and confirm the `sdata.shapes["annotations"]`
    element persists across save + reload (spec: shape annotations editor)."""
    sid = new_session(client)

    def stroke(**over):
        base = {"color": "#3388ff", "width": 2, "dash": "solid",
                "arrowStart": False, "arrowEnd": False, "arrowSize": 10, "z": 0}
        return {**base, **over}

    def fill(**over):
        base = {"enabled": True, "color": "#3388ff", "alpha": 0.25, "z": 0}
        return {**base, **over}

    line = {"geometry": {"kind": "line", "vertices": [[0, 0], [10, 0]]},
            "stroke": stroke(arrowEnd=True)}
    job = client.post(f"/api/sessions/{sid}/shape-annotations", json=line).json()
    assert wait_job(client, sid, job["job_id"])["status"] == "completed"

    box = {"geometry": {"kind": "box", "vertices": [[0, 0], [5, 0], [5, 5], [0, 5]]},
           "stroke": stroke(color="#00ff00", dash="dashed"), "fill": fill(color="#00ff00")}
    job = client.post(f"/api/sessions/{sid}/shape-annotations", json=box).json()
    assert wait_job(client, sid, job["job_id"])["status"] == "completed"

    text = {"geometry": {"kind": "text", "position": [3, 7], "text": "Tumor region",
                         "fontSize": 18, "rotation": 0.5},
            "stroke": stroke(color="#e05c5c")}
    job = client.post(f"/api/sessions/{sid}/shape-annotations", json=text).json()
    assert wait_job(client, sid, job["job_id"])["status"] == "completed"

    shapes = client.get(f"/api/sessions/{sid}/shape-annotations").json()["shapes"]
    assert len(shapes) == 3, shapes
    line_id = next(s["id"] for s in shapes if s["geometry"]["kind"] == "line")
    box_id = next(s["id"] for s in shapes if s["geometry"]["kind"] == "box")
    text_id = next(s["id"] for s in shapes if s["geometry"]["kind"] == "text")
    assert shapes[0]["stroke"]["z"] == 0 and "fill" not in next(s for s in shapes if s["id"] == line_id)
    text_shape = next(s for s in shapes if s["id"] == text_id)
    assert text_shape["geometry"]["position"] == [3.0, 7.0], text_shape
    assert text_shape["geometry"]["text"] == "Tumor region", text_shape
    assert text_shape["geometry"]["fontSize"] == 18, text_shape
    assert text_shape["geometry"]["rotation"] == 0.5, text_shape
    assert "fill" not in text_shape, text_shape  # text has no interior to fill
    print(f"[ok] created line + box + text shape annotations ({len(shapes)} total)")

    # update: move the line's endpoint and restyle it
    updated_line = {"geometry": {"kind": "line", "vertices": [[0, 0], [20, 0]]},
                    "stroke": stroke(color="#ff0000", width=4, arrowEnd=True, arrowStart=True, arrowSize=24)}
    job = client.put(f"/api/sessions/{sid}/shape-annotations/{line_id}", json=updated_line).json()
    assert wait_job(client, sid, job["job_id"])["status"] == "completed"
    shapes = client.get(f"/api/sessions/{sid}/shape-annotations").json()["shapes"]
    line_shape = next(s for s in shapes if s["id"] == line_id)
    assert line_shape["geometry"]["vertices"] == [[0.0, 0.0], [20.0, 0.0]], line_shape
    assert line_shape["stroke"]["color"] == "#ff0000" and line_shape["stroke"]["arrowStart"], line_shape
    assert line_shape["stroke"]["arrowSize"] == 24, line_shape
    print("[ok] updated line geometry + stroke style")

    # delete: the box is removed, the line + text remain. Updating the line above
    # re-appended it (drop + concat), so it now sorts after the untouched text.
    job = client.delete(f"/api/sessions/{sid}/shape-annotations/{box_id}").json()
    assert wait_job(client, sid, job["job_id"])["status"] == "completed"
    shapes = client.get(f"/api/sessions/{sid}/shape-annotations").json()["shapes"]
    assert [s["id"] for s in shapes] == [text_id, line_id], shapes
    print("[ok] deleted box shape, line + text shapes remain")

    # persistence: the annotations element survives save + reload
    out = os.path.join(str(config.CHECKPOINT_DIR), "shape_annotations_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"
    sid2 = new_session(client, out)
    shapes2 = client.get(f"/api/sessions/{sid2}/shape-annotations").json()["shapes"]
    assert [s["id"] for s in shapes2] == [text_id, line_id], shapes2
    reloaded_text = next(s for s in shapes2 if s["id"] == text_id)
    assert reloaded_text["geometry"]["text"] == "Tumor region", reloaded_text
    print("[ok] shape-annotations element survives save + reload")


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


def run_incremental_save_flow(client, checkpoint_path):
    """Loading a checkpoint we wrote yields an incremental-capable session: a
    table-only compute then saves by rewriting just the table element and reusing the
    on-disk sharded rasters, so no reshard runs. Asserts the incremental branch is
    taken, the raster files are left untouched, and the change round-trips."""
    from app.main import MANAGER
    from app.persistence import store
    sid = new_session(client, checkpoint_path)
    sess = MANAGER.get(sid)
    assert store.can_update_incrementally(sess.sdata, sess.extract_dir), \
        "a checkpoint-loaded session should be incremental-capable"

    # normalize_total mutates only .X, which the structural diff can't see (keyset
    # doesn't track X) — the active table must still be marked dirty, or the change
    # would be silently dropped by the incremental save.
    client.post(f"/api/sessions/{sid}/jobs", json={
        "namespace": "sc.pp", "function": "normalize_total", "params": {}})
    st = poll(client, sid, lambda s: hist_status(s, "normalize_total")[0] == "completed")
    assert not hist_status(st, "normalize_total")[1], "expected an empty structural_diff for X-only op"
    assert not sess.force_full and sess.active_table_key in sess.dirty_tables, \
        f"X-only compute not marked dirty: force_full={sess.force_full} tables={sess.dirty_tables}"

    def raster_mtimes():
        base = os.path.join(str(sess.sdata.path), "images")
        return {os.path.join(r, f): os.path.getmtime(os.path.join(r, f))
                for r, _, fs in os.walk(base) for f in fs}

    before = raster_mtimes()
    out = os.path.join(str(config.CHECKPOINT_DIR), "incremental_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"
    assert raster_mtimes() == before, "images were rewritten during an incremental save"
    assert not sess.dirty_tables and not sess.force_full, "dirty state not cleared after save"
    print(f"[ok] incremental save reused {len(before)} raster files untouched")

    sid2 = new_session(client, out)
    r = client.get(f"/api/sessions/{sid2}/data/obsp:spatial_distances")
    assert r.status_code == 200, r.text
    print("[ok] incremental-saved table change survived reload")


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


def run_filter_reshape_flow(client):
    """An in-place compute that changes the table's row count (sc.pp.filter_cells)
    must adopt the whole filtered object, not facet-merge shortened columns back
    onto the still-full-length live table. The old merge index-aligned the shorter
    columns, silently NaN-filling the dropped rows and coercing the integer
    instance_key (visium: spot_id) to float -- which then failed sdata.write() with
    "table.obs[instance_key] must not contain null values". Guards that regression:
    the filter completes, obs shrinks, and a save round-trips."""
    import numpy as np
    from app.main import MANAGER

    sid = new_session(client)  # visium_hne: int64 instance_key spot_id, clean
    before = n_obs_of(client, sid)
    # filter_cells thresholds on per-cell .X sums (not obs['total_counts']); pick a
    # threshold strictly inside that range so some (not all) spots are dropped.
    x = MANAGER.get(sid).active_table().X
    per_cell = np.asarray(x.sum(axis=1)).ravel()
    min_counts = int(np.quantile(per_cell, 0.25)) + 1
    client.post(f"/api/sessions/{sid}/jobs", json={
        "namespace": "sc.pp", "function": "filter_cells", "params": {"min_counts": min_counts}})
    poll(client, sid, lambda s: hist_status(s, "filter_cells")[0] in ("completed", "failed"))
    st = client.get(f"/api/sessions/{sid}").json()
    assert hist_status(st, "filter_cells")[0] == "completed", "filter_cells did not complete"
    after = n_obs_of(client, sid)
    assert 0 < after < before, f"expected obs to shrink, got {before} -> {after}"

    ik = MANAGER.get(sid).active_table().obs["spot_id"]
    assert ik.isnull().sum() == 0 and ik.dtype.kind in "iu", \
        f"instance_key corrupted after filter: dtype={ik.dtype} nulls={int(ik.isnull().sum())}"
    print(f"[ok] filter_cells reshaped obs {before} -> {after} with instance_key intact")

    # a wholesale object swap has no facet diff to drive canvas refetch, so the
    # adopt path must bump the table's field versions explicitly (else the canvas
    # keeps stale, longer point arrays).
    dv = st["app_state"]["data_versions"]
    assert dv.get("obsm:spatial", 0) > 0, f"obsm:spatial version not bumped after adopt: {dv}"
    print(f"[ok] field versions bumped on adopt (obsm:spatial v{dv['obsm:spatial']})")

    out = os.path.join(str(config.CHECKPOINT_DIR), "filter_reshape_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    js = wait_job(client, sid, sv["job_id"])
    assert js["status"] == "completed", f"save after filter failed: {js.get('error')}"
    print(f"[ok] saved filtered session (write validation passed)")
    assert client.delete(f"/api/sessions/{sid}").status_code == 200


def run_isolation_flow(client):
    """A job on one session must not touch another session's app_state (recent
    'Isolate viewers of different sessions'). Plus history-delete + cancel 409s."""
    a, b = new_session(client), new_session(client)
    client.post(f"/api/sessions/{a}/jobs", json={
        "namespace": "gr", "function": "spatial_neighbors",
        "params": {"coord_type": "generic", "n_neighs": 6}})
    poll(client, a, lambda s: hist_status(s, "spatial_neighbors")[0] == "completed")
    stb = client.get(f"/api/sessions/{b}").json()
    # B has only its own read_zarr bootstrap, never A's spatial_neighbors compute.
    assert [c["function"] for c in stb["app_state"]["compute_history"]] == ["read_zarr"], \
        "session B gained A's compute history"
    print("[ok] a compute on session A left session B's app_state untouched")

    # delete the completed compute entry on A; a bogus/again delete is a 409
    hist_a = client.get(f"/api/sessions/{a}").json()["app_state"]["compute_history"]
    entry = next(c["id"] for c in hist_a if c["function"] == "spatial_neighbors")
    assert client.delete(f"/api/sessions/{a}/history/{entry}").status_code == 200
    assert client.delete(f"/api/sessions/{a}/history/{entry}").status_code == 409
    assert client.delete(f"/api/sessions/{a}/jobs/{entry}").status_code == 409  # finished -> not cancellable
    # closing a session makes it 404
    assert client.delete(f"/api/sessions/{b}").status_code == 200
    assert client.get(f"/api/sessions/{b}").status_code == 404
    print("[ok] history delete + cancel/close negatives behave; closed session 404s")


def run_segmentation_flow(client):
    """Cell-boundary display endpoints on xenium.zarr (has shapes/cell_boundaries):
    the viewport-bbox GeoArrow polygons, the over-limit "zoom in" gate (too many
    cells in view -> empty, never a partial subset), and the centroid-alignment
    gate that a transformed polygon centroid matches its cell's transformed
    obsm:spatial. Confirms boundary polygons survive the reader + normalize_rasters
    + a checkpoint round-trip, and that a session with no polygons (visium_hne)
    serves no outlines."""
    import numpy as np
    import geoarrow.pyarrow as ga
    from scipy.spatial import cKDTree

    def poly_names(inv):
        return [s["name"] for s in inv["shapes"] if set(s["geometry"]) & {"Polygon", "MultiPolygon"}]

    sid = new_session(client, XENIUM)
    print(f"[ok] xenium segmentation session {sid[:8]}")

    # boundary shapes survived the reader + normalize_rasters (which touches only rasters)
    inv = client.get(f"/api/sessions/{sid}/elements").json()
    assert "cell_boundaries" in poly_names(inv), inv["shapes"]
    print(f"[ok] polygon shapes present after read + normalize_rasters: {poly_names(inv)}")

    # world coords the polygons must overlay (same space the coords endpoint serves),
    # and their bounds / nearest-neighbor spacing R (the alignment tolerance).
    spatial = fetch_arrow(client, sid, "obsm:spatial")
    wx, wy = np.asarray(spatial.column("d0")), np.asarray(spatial.column("d1"))
    minx, miny, maxx, maxy = float(wx.min()), float(wy.min()), float(wx.max()), float(wy.max())
    xy = np.column_stack([wx, wy])
    sample = xy if len(xy) <= 1000 else xy[np.random.default_rng(0).choice(len(xy), 1000, replace=False)]
    R = float(np.median(cKDTree(xy).query(sample, k=2)[0][:, 1]))
    assert R > 0 and minx < maxx and miny < maxy, (R, minx, maxx, miny, maxy)

    covering = f"{minx},{miny},{maxx},{maxy}"
    far = f"{maxx + 1e6},{maxy + 1e6},{maxx + 2e6},{maxy + 2e6}"
    rc = client.get(f"/api/sessions/{sid}/shapes/cell_boundaries/geoarrow", params={"bbox": covering})
    assert rc.status_code == 200, rc.text
    assert rc.headers["content-type"].startswith("application/vnd.apache.arrow.stream"), rc.headers
    tbl = ipc.open_stream(io.BytesIO(rc.content)).read_all()
    assert tbl.num_rows > 0, "covering bbox returned no polygons"
    rf = client.get(f"/api/sessions/{sid}/shapes/cell_boundaries/geoarrow", params={"bbox": far})
    assert ipc.open_stream(io.BytesIO(rf.content)).read_all().num_rows == 0, "far bbox not empty"
    print(f"[ok] geoarrow: covering bbox -> {tbl.num_rows} polygons, far bbox -> 0")

    # centroid-alignment gate: each transformed polygon centroid ~ its cell's
    # transformed obsm:spatial, gathered by cell_index (the correctness anchor).
    geoms = ga.to_geopandas(tbl.column("geometry"))
    cidx = np.asarray(tbl.column("cell_index"))
    ok = cidx >= 0
    cx, cy = np.asarray(geoms.centroid.x), np.asarray(geoms.centroid.y)
    d = np.hypot(cx[ok] - wx[cidx[ok]], cy[ok] - wy[cidx[ok]])
    assert ok.all() and np.median(d) < R, \
        f"misaligned: {ok.sum()}/{len(cidx)} mapped, median offset {np.median(d):.3f} vs R {R:.3f}"
    print(f"[ok] centroid-alignment: {ok.sum()}/{len(cidx)} mapped, median offset "
          f"{np.median(d):.3f} << R {R:.3f}")

    # over-limit gate: more cells in view than `limit` -> empty (never a partial
    # subset); at-or-under the limit -> the full set. A missing element 404s.
    n = tbl.num_rows
    over = client.get(f"/api/sessions/{sid}/shapes/cell_boundaries/geoarrow",
                      params={"bbox": covering, "limit": n - 1})
    assert ipc.open_stream(io.BytesIO(over.content)).read_all().num_rows == 0, \
        "over-limit bbox must return nothing, not a truncated subset"
    fit = client.get(f"/api/sessions/{sid}/shapes/cell_boundaries/geoarrow",
                     params={"bbox": covering, "limit": n})
    assert ipc.open_stream(io.BytesIO(fit.content)).read_all().num_rows == n
    assert client.get(f"/api/sessions/{sid}/shapes/nope/geoarrow",
                      params={"bbox": covering}).status_code == 404
    print(f"[ok] over-limit gate: limit {n - 1} -> 0, limit {n} -> {n}; missing element 404s")

    # checkpoint round-trip: cell_boundaries survives save + reload and still serves
    out = os.path.join(str(config.CHECKPOINT_DIR), "xenium_segmentation.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    assert wait_job(client, sid, sv["job_id"], timeout=300)["status"] == "completed"
    sid2 = new_session(client, out)
    assert "cell_boundaries" in poly_names(client.get(f"/api/sessions/{sid2}/elements").json())
    r2 = client.get(f"/api/sessions/{sid2}/shapes/cell_boundaries/geoarrow", params={"bbox": covering})
    assert ipc.open_stream(io.BytesIO(r2.content)).read_all().num_rows > 0
    print("[ok] cell_boundaries survived save + reload; geoarrow still serves it")

    # a session with no polygons (visium_hne): no polygon element; geoarrow 404s
    sid_v = new_session(client)
    assert not poly_names(client.get(f"/api/sessions/{sid_v}/elements").json())
    assert client.get(f"/api/sessions/{sid_v}/shapes/cell_boundaries/geoarrow",
                      params={"bbox": "0,0,1,1"}).status_code == 404
    print("[ok] visium_hne: no polygon shapes; geoarrow 404s")

    print("\nSEGMENTATION E2E CHECKS PASSED")


def main():
    with TestClient(app) as client:
        assert client.get("/api/readyz").json()["functions"] > 0
        nf = client.get("/api/functions").json()
        versions = ", ".join(f"{lib} {ver}" for lib, ver in nf['library_versions'].items())
        print(f"[ok] registry: {len(nf['functions'])} functions ({versions})")
        # Every function must carry provenance (CLAUDE.md rule): a citation and a
        # documentation URL — library functions inherit both from library_meta.yaml,
        # custom functions declare them explicitly.
        no_prov = [f["key"] for f in nf["functions"] if not f.get("citation") or not f.get("documentation")]
        assert not no_prov, f"functions missing citation/documentation: {no_prov}"
        print(f"[ok] all {len(nf['functions'])} functions carry citation + documentation")

        sid = new_session(client, DATA)
        print(f"[ok] session created {sid[:8]}")

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
        # read_zarr is the bootstrap reader that opened the raw dataset, recorded as
        # the first compute-history step (imports appear in history like any reader).
        assert [c["function"] for c in ch] == ["read_zarr", "spatial_neighbors", "nhood_enrichment"]
        assert any(p["function"] == "nhood_enrichment" for p in pl)
        assert disp, "displays not preserved"
        # verify computed field survived the round trip
        resp = client.get(f"/api/sessions/{sid2}/data/obsp:spatial_distances")
        assert resp.status_code == 200
        print("[ok] computed obsp survived reload")

        # --- new checkpoint format: sharded rasters, browser-readable, logs relocated ---
        import json as _json
        import zipfile as _zip
        name = os.path.basename(out)
        with _zip.ZipFile(out) as zf:
            root = _json.loads(zf.read("zarr.json"))
            cm = root["consolidated_metadata"]["metadata"]
            # a raster array must report the sharding codec THROUGH consolidated metadata
            # (else zarrita reads the pre-shard byte layout and decodes garbage)
            raster = next(k for k, v in cm.items()
                          if k.startswith("images/") and v.get("node_type") == "array")
            codecs = [c.get("name") for c in cm[raster]["codecs"]]
            assert "sharding_indexed" in codecs, f"{raster} not sharded in consolidated tree: {codecs}"
            # app_state present but with no inline worker logs (relocated to logs/)
            saved_state = root["attributes"]["app_state"]
            assert all("_log" not in r for r in
                       saved_state["compute_history"] + saved_state["plots"]), "logs not relocated"
            logfiles = [n for n in zf.namelist() if n.startswith("logs/")]
        print(f"[ok] sharded checkpoint: {raster} codecs={codecs}; "
              f"root zarr.json={zf.getinfo('zarr.json').file_size/1024:.0f}KB; logs relocated={len(logfiles)}")

        # /api/checkpoints serves it with HTTP Range (206) so zarrita can byte-range-read it
        rng = client.get(f"/api/checkpoints/{name}", headers={"Range": "bytes=0-99"})
        assert rng.status_code == 206 and len(rng.content) == 100 and "content-range" in \
            {k.lower() for k in rng.headers}, f"range not honored: {rng.status_code} {len(rng.content)}"
        assert client.get("/api/checkpoints/not-a-checkpoint.txt").status_code == 404
        print(f"[ok] /api/checkpoints range 206 Content-Range={rng.headers.get('content-range')}")

        # a relocated log is still fetchable after reload via the existing /log endpoint
        plot_id = next(p["id"] for p in pl if p["function"] == "nhood_enrichment")
        lg = client.get(f"/api/sessions/{sid2}/jobs/{plot_id}/log")
        assert lg.status_code == 200 and isinstance(lg.json().get("log"), str), lg.text
        print(f"[ok] relocated plot log fetched after reload ({len(lg.json()['log'])} chars)")

        run_snapshot_flow(client, sid)

        print("\n--- feature flows ---")
        run_sharding_shape_flow()
        run_staging_flow(client)
        run_recipe_params_flow(client)
        run_regions_flow(client)
        run_shape_annotations_flow(client)
        run_transform_flow(client)
        run_incremental_save_flow(client, out)
        run_content_hash_flow(client)
        run_invalidation_flow(client)
        run_encoding_persistence_flow(client)
        run_inspector_flow(client)
        run_isolation_flow(client)
        run_filter_reshape_flow(client)
        run_zarr_import_flow(client)
        run_segmentation_flow(client)

        run_custom_methods_flow(client)

        print("\nALL BACKEND E2E CHECKS PASSED")


if __name__ == "__main__":
    sys.exit(main())
