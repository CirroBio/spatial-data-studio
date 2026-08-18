"""End-to-end backend test against the real visium_hne dataset (no Docker/frontend).
Exercises: load -> compute -> compute -> Arrow fetch -> plot -> save -> reload.
"""
import datetime
import io
import json
import os
import pathlib
import re
import shutil
import sys
import tempfile
import time

import pyarrow.ipc as ipc
from fastapi.testclient import TestClient

os.environ.setdefault("SDS_CONTAINER_MEM_MB", "32768")
# The feature flows below each open a few short-lived sessions (and reload
# checkpoints into fresh ones); lift the default 8-session cap so the run isn't
# bounded by it. Real deployments keep the low default.
os.environ.setdefault("SDS_MAX_SESSIONS", "64")
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
# Single data dir: the input datasets and the saved checkpoints/snapshots share
# test-data/. `_cleanup_new_artifacts` (called from main) removes whatever the run
# writes there so the datasets stay pristine.
os.environ.setdefault("SDS_DATA_DIR", os.path.join(_REPO_ROOT, "test-data"))
from app.main import app  # noqa: E402
from app.config import config  # noqa: E402

DATA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test-data", "visium_hne.zarr"))
XENIUM_TMA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test-data", "xenium_tma.zarr"))
XENIUM = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test-data", "xenium.zarr"))


def have_fixture(path, flow):
    """Whether a fixture dataset is present. The Xenium fixtures (xenium.zarr,
    xenium_tma.zarr) are heavy to build, so CI skips their flows; local runs that
    regenerated them via scripts/prepare_xenium_*.py exercise the full suite."""
    if os.path.exists(path):
        return True
    print(f"[skip] {flow}: missing fixture {os.path.basename(path)} "
          f"(regenerate via scripts/prepare_xenium_*.py)")
    return False


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
    from app.deps import MANAGER

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

    run_job("custom", "cellular_neighborhoods", {"cell_type_key": "cell_type", "resolution": 0.2})
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
    out = os.path.join(str(config.DATA_DIR), "custom_methods_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    t0 = time.time()
    while time.time() - t0 < 180:
        js = client.get(f"/api/sessions/{sid}/jobs/{sv['job_id']}").json()
        if js["status"] in ("completed", "failed"):
            break
        time.sleep(0.5)
    assert js["status"] == "completed", f"save status {js['status']}"
    print(f"[ok] saved custom-methods session {out} ({os.path.getsize(out)/1e6:.1f} MB)")

    # Load runs on the worker now (fix for the CloudFront 504): the POST returns a
    # `loading` shell immediately and completion arrives on the terminal `session.loading`
    # event the New Session dialog follows. Spy the bus to assert that contract, mirroring
    # the import flow's job.log spy.
    from app.transport.sse import BUS
    loading_events = []
    orig_publish = BUS.publish
    def _spy(event_type, data, _orig=orig_publish):
        if event_type == "session.loading":
            loading_events.append(data)
        return _orig(event_type, data)
    BUS.publish = _spy
    try:
        r2 = client.post("/api/sessions", json={"source": {"kind": "load", "path": out},
                                                "load_id": "e2e-load"})
        assert r2.status_code == 200, r2.text
        sid2 = r2.json()["id"]
        st2 = poll(client, sid2, lambda s: s["summary"]["status"] in ("ready", "errored"))
    finally:
        BUS.publish = orig_publish
    assert st2["summary"]["status"] == "ready", "reloaded session errored"
    terminal = [e for e in loading_events if e.get("done")]
    assert terminal and terminal[-1]["status"] == "ready", f"no terminal load event: {loading_events}"
    print(f"[ok] async load emitted {len(loading_events)} session.loading events (terminal status=ready)")
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

    # Every plot still drawn at save time comes back drawn, with all three rendered
    # formats — nine custom-method figures over one save/reload (DESIGN §13.2).
    drawn2 = [p for p in st2["app_state"]["plots"] if p["status"] == "drawn"]
    assert drawn2, [(p["function"], p["status"]) for p in st2["app_state"]["plots"]]
    missing = [p["function"] for p in drawn2
               if set(st2["figures"].get(p["id"], {})) != {"svg", "pdf", "png"}]
    assert not missing, f"reloaded drawn plots with no figure: {missing}"
    kept_mb = sum(sum(f.values()) for f in st2["figures"].values()) / 1e6
    print(f"[ok] {len(drawn2)} drawn plots reloaded with their figures ({kept_mb:.1f} MB)")

    print("\nCUSTOM METHODS E2E CHECKS PASSED")


def run_zarr_import_flow(client):
    """SpatialData-zarr importer (io.read_zarr): exercises the underlying archive
    reader on a .zarr dir, a .zarr.zip, and a .zarr.tar.gz, then an API import
    round-trip for each archive (placed under the data dir) into a ready session."""
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
            sdata, extract_dir, _ = read_spatialdata_archive(p)
            assert list(getattr(sdata, "tables", {}).keys()), f"{label}: no tables read"
            assert (extract_dir is not None) == expect_tmp, f"{label}: extract_dir={extract_dir}"
            if extract_dir:
                shutil.rmtree(extract_dir, ignore_errors=True)
            print(f"[ok] read_spatialdata_archive({label}) -> tables={list(sdata.tables.keys())}")

        # API import round-trip: each archive bootstraps a ready session via io.read_zarr.
        # The zip import also asserts the reader's log streams live as `job.log` events
        # (transport/livelog.py) so the import UI shows progress instead of a frozen
        # spinner; the tar.gz import just confirms the plain round-trip.
        from app.transport.sse import BUS
        for label, p in [("zip", zip_path), ("tar.gz", targz_path)]:
            streamed = []
            orig_publish = BUS.publish
            def _spy(event_type, data, _orig=orig_publish):
                if event_type == "job.log":
                    streamed.append(data)
                return _orig(event_type, data)
            BUS.publish = _spy
            try:
                r = client.post("/api/sessions", json={"source": {
                    "kind": "read", "namespace": "io", "function": "read_zarr", "params": {"store": p}}})
                assert r.status_code == 200, r.text
                sid = r.json()["id"]
                st = poll(client, sid, lambda s: s["summary"]["status"] in ("ready", "errored"))
            finally:
                BUS.publish = orig_publish
            assert st["summary"]["status"] == "ready", f"{label} import errored"
            assert [c["function"] for c in st["app_state"]["compute_history"]] == ["read_zarr"]
            assert st["fields"]["obs"], f"{label}: no obs fields after import"
            if label == "zip":
                mine = [d for d in streamed if d["session_id"] == sid]
                assert mine, "no job.log events streamed during import"
                assert all(set(d) == {"session_id", "job_id", "chunk"} for d in mine)
                print(f"[ok] import streamed {len(mine)} live job.log chunks")
            assert client.delete(f"/api/sessions/{sid}").status_code == 200
            print(f"[ok] imported {label} archive -> ready session {sid[:8]}")
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    print("[ok] SpatialData-zarr import flow passed")


def new_session(client, path=DATA):
    """Open a saved checkpoint (`.zarr.zip`/`.sdata.zarr.zip`) via `load`, or bootstrap
    a raw `.zarr` dataset via the `read_zarr` reader. Both live under the single
    DATA_DIR now; the file kind (zipped checkpoint vs raw dir) picks the path. Both run
    on the session's worker — the load unzips/re-tiles, the read bootstraps — so the POST
    returns a `loading` shell immediately; wait for the session to become ready."""
    if str(path).endswith(".zarr.zip"):
        source = {"kind": "load", "path": path}
    else:
        source = {"kind": "read", "namespace": "io", "function": "read_zarr", "params": {"store": path}}
    r = client.post("/api/sessions", json={"source": source})
    assert r.status_code == 200, r.text
    sid = r.json()["id"]
    st = poll(client, sid, lambda s: s["summary"]["status"] in ("ready", "errored"))
    if st["summary"]["status"] == "errored":
        raise RuntimeError(f"session {sid} errored")
    return sid


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


def run_csc_mirror_check(client, sid, checkpoint_path):
    """The `viewer/tables/<t>/X_csc` mirror is what the serverless viewer reads to color
    by a gene, in place of `/data/X:<gene>`. Densify a few of its columns straight from
    the zip and require them to equal what the live endpoint serves from the CSR `X`,
    including a gene whose column is empty."""
    import zipfile as _zip

    import numpy as np
    import zarr

    with tempfile.TemporaryDirectory() as tmp:
        with _zip.ZipFile(checkpoint_path) as zf:
            zf.extractall(tmp)
        group = zarr.open_group(tmp, mode="r")
        csc = group["viewer/tables/adata/X_csc"]
        data, indices, indptr = csc["data"][:], csc["indices"][:], csc["indptr"][:]
        n_cells, n_genes = csc.attrs["shape"]
        # Gene order is `var/_index`, not duplicated into the sidecar — the same
        # lookup the viewer does to turn a gene name into a column index.
        var_names = [str(v) for v in group["tables/adata/var/_index"][:]]

    assert len(var_names) == n_genes, f"CSC gene count {n_genes} != var/_index {len(var_names)}"
    # Densest and sparsest columns plus a spread of others: an empty column is the case
    # a naive reader gets wrong (indptr[g] == indptr[g+1]).
    lengths = np.diff(indptr)
    probes = {int(lengths.argmax()), int(lengths.argmin()), 0, n_genes - 1, n_genes // 2}
    for gene_index in sorted(probes):
        gene = var_names[gene_index]
        column = np.zeros(n_cells, dtype=np.float64)
        span = slice(indptr[gene_index], indptr[gene_index + 1])
        column[indices[span]] = data[span]
        served = fetch_arrow(client, sid, f"X:{gene}").column("value").to_numpy()
        assert np.allclose(column, served, rtol=1e-5, atol=1e-6), \
            f"CSC column for {gene} (index {gene_index}, nnz {lengths[gene_index]}) != /data/X:{gene}"
    print(f"[ok] CSC mirror matches /data/X:<gene> for {len(probes)} genes "
          f"(nnz {lengths.min()}..{lengths.max()}, chunk {csc['data'].chunks[0]})")


def _probe_square(cx, cy, r=2.0, z=None):
    """A small square polygon for the shape-index edge-case probes; `z` makes it 3-D."""
    from shapely.geometry import Polygon
    corners = [(cx - r, cy - r), (cx + r, cy - r), (cx + r, cy + r), (cx - r, cy + r)]
    return Polygon([(x, y, z) for x, y in corners] if z is not None else corners)


def run_shape_index_check(client, sid, checkpoint_path):
    """The `shapes/<el>/shapes.parquet` spatial index is what lets the serverless viewer
    range-read a viewport's boundaries instead of downloading every polygon in the
    sample. Assert the file is actually queryable — not merely well-formed — and that the
    sidecar report and `cell_index` mirror the browser plans from agree with it.

    The load-bearing check is the pruning one: covering statistics that are subtly wrong
    (a min where a max belongs) still produce a valid file and still render, just with
    cells silently missing. So the row groups the statistics keep are compared against a
    brute-force scan of every row's true bounds."""
    import zipfile as _zip

    import anndata
    import geopandas as gpd
    import numpy as np
    import pyarrow.parquet as pq
    import zarr

    from app.persistence import store
    from app.sessions import shape_annotations
    from app.transport import geometry

    with tempfile.TemporaryDirectory() as tmp:
        with _zip.ZipFile(checkpoint_path) as zf:
            zf.extractall(tmp)
        group = zarr.open_group(tmp, mode="r")
        sidecar = dict(group[store.VIEWER_GROUP].attrs)
        assert sidecar["sidecar_version"] == store.VIEWER_SIDECAR_VERSION, sidecar["sidecar_version"]
        report = sidecar["shapes"]
        assert "cell_boundaries" in report, f"no shape index written: {list(report)}"
        # Point shapes are scatter, not outlines, and `annotations` row order is what the
        # annotation list shows — neither is indexed.
        for element in report:
            assert element != shape_annotations.ELEMENT, element

        path = os.path.join(tmp, "shapes", "cell_boundaries", "shapes.parquet")
        md = pq.ParquetFile(path).metadata
        geo = json.loads(md.metadata[b"geo"])
        column = geo["columns"][geo["primary_column"]]
        assert geo["version"].startswith("1.1"), geo["version"]
        assert "covering" in column, f"no covering column: {list(column)}"
        assert md.num_row_groups > 1, "one row group leaves nothing to prune"
        # The browser pays the footer on every query, and one row group per request.
        assert md.serialized_size < 1_000_000, f"footer too large: {md.serialized_size}"
        largest = max(md.row_group(i).total_byte_size for i in range(md.num_row_groups))
        assert largest < 32 << 20, f"row group too large: {largest}"

        entry = report["cell_boundaries"]
        for key, actual in (("num_rows", md.num_rows), ("row_groups", md.num_row_groups),
                            ("footer_bytes", md.serialized_size),
                            ("file_bytes", os.path.getsize(path))):
            assert entry[key] == actual, f"sidecar {key} {entry[key]} != file {actual}"
        print(f"[ok] shape index: {entry['num_rows']} rows, {entry['row_groups']} row groups, "
              f"{entry['file_bytes'] / 1e6:.1f} MB, footer {entry['footer_bytes'] / 1024:.1f} KiB")

        # --- pruning vs brute force -------------------------------------------------
        gdf = gpd.read_parquet(path)
        x0, y0, x1, y1 = (float(v) for v in gdf.total_bounds)
        assert np.allclose(entry["bounds"], [x0, y0, x1, y1]), (entry["bounds"], gdf.total_bounds)
        rows = gdf.bounds.to_numpy()  # minx, miny, maxx, maxy per row, read independently
        boxes = [(s["xmin"].min, s["ymin"].min, s["xmax"].max, s["ymax"].max)
                 for s in store._covering_stats(md)]
        starts = np.cumsum([0] + [md.row_group(i).num_rows for i in range(md.num_row_groups)])

        rng = np.random.default_rng(0)
        checked = 0
        for _ in range(200):
            wx = np.sort(rng.uniform(x0, x1, 2))
            wy = np.sort(rng.uniform(y0, y1, 2))
            window = (wx[0], wy[0], wx[1], wy[1])
            kept = {i for i, b in enumerate(boxes)
                    if b[0] <= window[2] and b[2] >= window[0]
                    and b[1] <= window[3] and b[3] >= window[1]}
            hit_rows = np.nonzero((rows[:, 0] <= window[2]) & (rows[:, 2] >= window[0])
                                  & (rows[:, 1] <= window[3]) & (rows[:, 3] >= window[1]))[0]
            needed = {int(np.searchsorted(starts, r, side="right") - 1) for r in hit_rows}
            # Superset, never equal: a row group's box is the union of its rows', so it
            # may intersect a window none of its rows do. Missing one is the bug.
            assert needed <= kept, \
                f"pruning dropped row groups {sorted(needed - kept)} for window {window}"
            checked += len(hit_rows)
        print(f"[ok] row-group pruning is a superset of a brute-force row scan over 200 "
              f"random windows ({checked} row hits)")

        # --- selectivity: the number that decides whether pruning pays --------------
        # Measured *relative* to what this file could achieve, not against an absolute
        # threshold: the ideal is 1/num_row_groups, so a small element with a handful of
        # row groups is capped low however well it is sorted, and only the ratio says
        # whether the sort worked. Measured ratios are 1.14x on the 11.9k-cell element
        # and 1.27x on a 428k-cell one, so 2.5x leaves room for dataset variation while
        # still failing an unsorted file (which lands at 1/ideal, i.e. num_row_groups).
        ideal = 1 / md.num_row_groups
        assert entry["selectivity"] < ideal * 2.5, \
            f"selectivity {entry['selectivity']:.4f} vs ideal {ideal:.4f} " \
            f"({entry['selectivity'] / ideal:.1f}x): rows are not spatially sorted"
        # An unsorted copy of the same rows, as the regression baseline: every row group
        # then spans the whole extent (selectivity 1.0), and this is what would silently
        # regress if a writer upgrade dropped the sort.
        unsorted_path = os.path.join(tmp, "unsorted.parquet")
        gdf.sample(frac=1.0, random_state=0).to_parquet(
            unsorted_path, write_covering_bbox=True, schema_version="1.1.0",
            row_group_size=store._row_group_rows(len(gdf)))
        unsorted = store._selectivity(pq.ParquetFile(unsorted_path).metadata)
        assert entry["selectivity"] < unsorted / 2, \
            f"sorted selectivity {entry['selectivity']:.4f} not better than unsorted {unsorted:.4f}"
        print(f"[ok] selectivity {entry['selectivity']:.4f} = {entry['selectivity'] / ideal:.2f}x "
              f"ideal {ideal:.4f} (unsorted would be {unsorted:.4f}) — pruning is effective")

        # --- cell_index mirror ------------------------------------------------------
        # It must be aligned with the *file's* row order, which the Hilbert sort changed,
        # and carry the same label-based mapping the live route computes.
        table_key = sidecar["table_keys"][0]
        mirror = group[f"{store.VIEWER_GROUP}/shapes/cell_boundaries/{table_key}/cell_index"][:]
        assert len(mirror) == md.num_rows, (len(mirror), md.num_rows)
        expected = geometry.cell_index(
            anndata.read_zarr(os.path.join(tmp, "tables", table_key)), list(gdf.index))
        assert np.array_equal(mirror, expected), "cell_index mirror is out of order with the parquet"
        served = client.get(f"/api/sessions/{sid}/shapes/cell_boundaries/geoarrow",
                            params={"bbox": f"{x0},{y0},{x1},{y1}"})
        live = np.asarray(ipc.open_stream(io.BytesIO(served.content)).read_all().column("cell_index"))
        assert sorted(mirror.tolist()) == sorted(live.tolist()), \
            "cell_index mirror disagrees with what /geoarrow serves"
        print(f"[ok] cell_index mirror ({len(mirror)} rows, chunk "
              f"{group[f'{store.VIEWER_GROUP}/shapes/cell_boundaries/{table_key}/cell_index'].chunks[0]}) "
              f"matches the parquet order and /geoarrow")

        # --- idempotence, and the report describing the FILE ------------------------
        # The incremental save path re-runs this over a store it already indexed; a
        # rewrite there would be wasted work on every save.
        before = os.stat(path).st_mtime_ns
        again = store._index_shape_parquet(path, gdf)
        assert os.stat(path).st_mtime_ns == before, "re-indexing rewrote an indexed file"
        assert again == entry, (again, entry)
        # That skip is exactly why the report must be read from the file and never from
        # the live GeoDataFrame: the file is deliberately left alone, so a report taken
        # from the object would describe geometry that isn't there. Re-run with an object
        # that contradicts the file on both counts a reader acts on — extent (a narrower
        # one silently blanks viewports outside it) and geometry kind (the wrong one makes
        # the reader build the wrong GeoArrow nesting).
        from shapely.geometry import MultiPolygon, Polygon
        square = Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])
        decoy = gpd.GeoDataFrame(
            geometry=[MultiPolygon([square]), square], index=list(gdf.index[:2]))
        assert store._index_shape_parquet(path, decoy) == entry, \
            "the shape index report follows the in-memory GeoDataFrame, not the file"
        print("[ok] re-indexing an indexed parquet is a no-op, and its report still "
              "describes the file rather than the live object")

        # --- geometry a Hilbert sort can't place, and 3-D geometry -------------------
        # An empty or missing polygon has no centroid, and `hilbert_distance` refuses a
        # GeoSeries containing one — so a single filtered cell must not fail the whole
        # save. And GeoParquet spells a 3-D kind "Polygon Z", which neither the reader
        # nor the boundary picker matches, so the report has to publish the bare name.
        from shapely import wkt
        mixed = gpd.GeoDataFrame(
            geometry=[_probe_square(100, 100), None, _probe_square(10, 10),
                      wkt.loads("POLYGON EMPTY"), _probe_square(50, 50)],
            index=list("abcde"))
        mixed_path = os.path.join(tmp, "mixed.parquet")
        mixed.to_parquet(mixed_path)
        mixed_entry = store._index_shape_parquet(mixed_path, mixed)
        mixed_labels = store._parquet_row_labels(mixed_path)
        assert mixed_entry is not None, "one bad geometry disabled the whole element"
        assert mixed_labels[-2:] == ["b", "d"], \
            f"unplaceable geometry must sort to the end, got {mixed_labels}"
        assert len(gpd.read_parquet(mixed_path)) == len(mixed), "a row was dropped"
        # The extent must come from the drawable rows only; a null bbox contributes none.
        assert mixed_entry["bounds"] == [8.0, 8.0, 102.0, 102.0], mixed_entry["bounds"]

        allbad = gpd.GeoDataFrame(geometry=[None, wkt.loads("POLYGON EMPTY")], index=["x", "y"])
        allbad_path = os.path.join(tmp, "allbad.parquet")
        allbad.to_parquet(allbad_path)
        assert store._index_shape_parquet(allbad_path, allbad) is None, \
            "an element with nothing drawable must be omitted, not published with a zero extent"

        three_d = gpd.GeoDataFrame(
            geometry=[_probe_square(1, 1, z=0.0), _probe_square(9, 9, z=1.0)], index=["p", "q"])
        three_d_path = os.path.join(tmp, "three_d.parquet")
        three_d.to_parquet(three_d_path)
        three_d_entry = store._index_shape_parquet(three_d_path, three_d)
        assert three_d_entry["geometry_types"] == ["Polygon"], \
            f"3-D geometry must report the bare kind, got {three_d_entry['geometry_types']}"
        print("[ok] unplaceable geometry sorts to the end (element still indexed), an "
              "all-empty element is omitted, and 3-D geometry reports as 'Polygon'")

    print("\nSHAPE INDEX CHECKS PASSED")


def run_snapshot_flow(client, sid):
    """A snapshot is now a rendered figure (vector PDF + raster PNG) of a display, with
    provenance metadata embedded in each file and a sidecar `.figure.json`. Verify
    preview -> render (both formats) -> list (with thumbnail) -> download PDF/PNG ->
    embedded metadata -> delete removes every artifact."""
    disp = client.get(f"/api/sessions/{sid}").json()["app_state"]["displays"]
    spatial = next((d for d in disp if d["type"] == "spatial_canvas"), None)
    assert spatial, "no spatial display to snapshot"
    spec = {"label": "e2e-snap", "viewport": {"target": [100, 100], "zoom": -2},
            "width_px": 800, "height_px": 600, "dpi": 100,
            "formats": ["pdf", "png"], "display_id": spatial["id"],
            "include_minimap": True}

    prev = client.post(f"/api/sessions/{sid}/snapshot/preview", json=spec)
    assert prev.status_code == 200 and prev.headers["content-type"] == "image/png", prev.text
    assert prev.content[:8] == b"\x89PNG\r\n\x1a\n", "preview is not a PNG"

    r = client.post(f"/api/sessions/{sid}/snapshot", json=spec)
    assert r.status_code == 200, r.text
    snap = r.json()
    assert snap["name"].endswith(".figure.json") and snap["formats"] == ["pdf", "png"], snap

    listing = client.get("/api/snapshots").json()["snapshots"]
    entry = next((s for s in listing if s["name"] == snap["name"]), None)
    assert entry and entry["kind"] == "spatial" and entry["label"] == "e2e-snap", f"not listed: {listing}"
    assert entry["thumbnail_url"] and entry["metadata"]["recipe"] is not None, entry
    thumb = client.get(entry["thumbnail_url"])
    assert thumb.status_code == 200 and thumb.content[:8] == b"\x89PNG\r\n\x1a\n", "thumbnail missing"

    pdf = client.get(f"/api/snapshots/{snap['name']}/file", params={"fmt": "pdf"})
    assert pdf.status_code == 200 and pdf.content[:5] == b"%PDF-", "PDF download bad"
    assert b"e2e-snap" in pdf.content, "PDF is missing its embedded metadata"
    png = client.get(f"/api/snapshots/{snap['name']}/file", params={"fmt": "png"})
    assert png.status_code == 200 and png.content[:8] == b"\x89PNG\r\n\x1a\n", "PNG download bad"
    assert b"sds-snapshot" in png.content, "PNG is missing its embedded metadata chunk"

    # Metadata carries the framing + full display encoding for reproducibility.
    meta = entry["metadata"]
    assert meta["output"] == {"width_px": 800, "height_px": 600, "dpi": 100}, meta["output"]
    assert meta["encoding"] == spatial["encoding"], "figure metadata lost the display encoding"
    assert meta["render"]["minimap"] is True, "include_minimap did not draw the overview inset"

    assert client.delete(f"/api/snapshots/{snap['name']}").status_code == 200
    listing2 = client.get("/api/snapshots").json()["snapshots"]
    assert not any(s["name"] == snap["name"] for s in listing2), "delete left the snapshot listed"
    assert client.get(f"/api/snapshots/{snap['name']}/file", params={"fmt": "pdf"}).status_code == 404
    print(f"[ok] snapshot {snap['name']} rendered (pdf+png), metadata embedded, deleted cleanly")


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
    out = os.path.join(str(config.DATA_DIR), "regions_session.zarr.zip")
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

    # a free-form polygon (5 vertices) exercises the variable-length ring
    poly_verts = [[0, 0], [8, 0], [10, 4], [4, 8], [-2, 4]]
    polygon = {"geometry": {"kind": "polygon", "vertices": poly_verts},
               "stroke": stroke(color="#a05ce0"), "fill": fill(color="#a05ce0")}
    job = client.post(f"/api/sessions/{sid}/shape-annotations", json=polygon).json()
    assert wait_job(client, sid, job["job_id"])["status"] == "completed"

    text = {"geometry": {"kind": "text", "position": [3, 7], "text": "Tumor region",
                         "fontSize": 18, "rotation": 0.5},
            "stroke": stroke(color="#e05c5c")}
    job = client.post(f"/api/sessions/{sid}/shape-annotations", json=text).json()
    assert wait_job(client, sid, job["job_id"])["status"] == "completed"

    shapes = client.get(f"/api/sessions/{sid}/shape-annotations").json()["shapes"]
    assert len(shapes) == 4, shapes
    line_id = next(s["id"] for s in shapes if s["geometry"]["kind"] == "line")
    box_id = next(s["id"] for s in shapes if s["geometry"]["kind"] == "box")
    text_id = next(s["id"] for s in shapes if s["geometry"]["kind"] == "text")
    assert shapes[0]["stroke"]["z"] == 0 and "fill" not in next(s for s in shapes if s["id"] == line_id)
    poly_shape = next(s for s in shapes if s["geometry"]["kind"] == "polygon")
    poly_id = poly_shape["id"]
    assert poly_shape["geometry"]["vertices"] == [[float(x), float(y)] for x, y in poly_verts], poly_shape
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

    # delete: the box is removed, the polygon + line + text remain. Updating the line
    # above re-appended it (drop + concat), so it now sorts after the untouched
    # polygon + text.
    job = client.delete(f"/api/sessions/{sid}/shape-annotations/{box_id}").json()
    assert wait_job(client, sid, job["job_id"])["status"] == "completed"
    shapes = client.get(f"/api/sessions/{sid}/shape-annotations").json()["shapes"]
    assert [s["id"] for s in shapes] == [poly_id, text_id, line_id], shapes
    print("[ok] deleted box shape, polygon + line + text shapes remain")

    # persistence: the annotations element survives save + reload
    out = os.path.join(str(config.DATA_DIR), "shape_annotations_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"
    sid2 = new_session(client, out)
    shapes2 = client.get(f"/api/sessions/{sid2}/shape-annotations").json()["shapes"]
    assert [s["id"] for s in shapes2] == [poly_id, text_id, line_id], shapes2
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
    from app.deps import MANAGER  # bound at startup, so import inside the client context
    store_path = MANAGER.get(sid).store_path
    a_reload = client.get(f"/api/sessions/{new_session(client, store_path)}/points-transform").json()["affine"]
    assert abs(a_reload[2] - a1[2]) < 1e-3 and abs(a_reload[5] - a1[5]) < 1e-3, a_reload
    print("[ok] points-transform persists across reload")

    # a malformed affine is rejected up front
    assert client.post(f"/api/sessions/{sid}/points-transform", json={"affine": [1, 2, 3]}).status_code == 400


def run_incremental_save_flow(client, checkpoint_path):
    """Loading a checkpoint we wrote yields an incremental-capable session: a
    table-only compute then saves by rewriting just the table element and reusing the
    on-disk rasters untouched. Asserts the incremental branch is taken, the raster
    files are left untouched, and the change round-trips."""
    from app.deps import MANAGER
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
    out = os.path.join(str(config.DATA_DIR), "incremental_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"
    assert raster_mtimes() == before, "images were rewritten during an incremental save"
    assert not sess.dirty_tables and not sess.force_full, "dirty state not cleared after save"
    print(f"[ok] incremental save reused {len(before)} raster files untouched")

    sid2 = new_session(client, out)
    r = client.get(f"/api/sessions/{sid2}/data/obsp:spatial_distances")
    assert r.status_code == 200, r.text
    print("[ok] incremental-saved table change survived reload")


def run_selective_save_flow(client, checkpoint_path):
    """A save can name which elements go in the file, at what resolution, and which
    slots of a table. Asserts the per-element (and per pyramid level, per table slot)
    size breakdown, that a filtered write drops exactly what was deselected (file,
    sidecar and the displays pointing at it), that a level-trimmed image comes back
    smaller but in the same place, that a table saved without X reloads valid and
    matrix-less, that none of those writes takes the incremental path or rewrites the
    source rasters, and that the live session keeps everything."""
    import zipfile
    import zarr
    from app.deps import MANAGER
    from app.persistence import store
    sid = new_session(client, checkpoint_path)
    sess = MANAGER.get(sid)
    assert store.can_update_incrementally(sess.sdata, sess.extract_dir), \
        "expected an incremental-capable session to prove the filtered save opts out"

    inv = client.get(f"/api/sessions/{sid}/elements").json()
    assert "size_mb" not in inv["tables"][0], "sizes must stay opt-in for the inspector"
    sized = client.get(f"/api/sessions/{sid}/elements?sizes=1").json()
    for facet in ("tables", "images", "labels", "points", "shapes"):
        for e in sized[facet]:
            assert "size_mb" in e, f"{facet}/{e['name']} missing size_mb"
    assert sized["tables"][0]["size_mb"] > 0, "the active table should have a measurable size"
    images = [i["name"] for i in sized["images"]]
    assert images and all(i["size_mb"] > 0 for i in sized["images"]), f"no sized images: {sized['images']}"
    print(f"[ok] element sizes: table={sized['tables'][0]['size_mb']}MB "
          f"images={[(i['name'], i['size_mb']) for i in sized['images']]}")

    # The resolution slider is drawn from `levels`: finest first, shrinking, and adding
    # up to the whole-element number so dropping levels can be subtracted from the total.
    levels = sized["images"][0]["levels"]
    assert len(levels) > 1, f"expected a multiscale test image, got {levels}"
    assert [lv["level"] for lv in levels] == list(range(len(levels))), f"levels misindexed: {levels}"
    assert all(a["width"] > b["width"] and a["height"] > b["height"]
               for a, b in zip(levels, levels[1:])), f"levels not finest-first: {levels}"
    drift = abs(sum(lv["size_mb"] for lv in levels) - sized["images"][0]["size_mb"])
    assert drift <= 0.1 * (len(levels) + 1), f"level sizes don't sum to the element size: {levels}"
    print(f"[ok] image pyramid: {[(lv['width'], lv['size_mb']) for lv in levels]}")

    # Point a display at an image so the reference-rewrite has something to clear.
    disp = client.get(f"/api/sessions/{sid}").json()["app_state"]["displays"][0]
    disp["encoding"]["image_layer"] = images[0]
    assert client.put(f"/api/sessions/{sid}/displays/{disp['id']}", json=disp).status_code == 200

    def raster_mtimes():
        base = os.path.join(str(sess.sdata.path), "images")
        return {os.path.join(r, f): os.path.getmtime(os.path.join(r, f))
                for r, _, fs in os.walk(base) for f in fs}

    before_mtimes = raster_mtimes()
    before_store, before_saved = sess.store_path, sess.saved
    out = os.path.join(str(config.DATA_DIR), "selective_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save",
                     json={"path": out, "include": {"images": []}}).json()
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"

    with zipfile.ZipFile(out) as z:
        names = z.namelist()
    assert not any(n.startswith("images/") and n.count("/") > 1 for n in names), \
        f"filtered save still wrote image arrays: {[n for n in names if n.startswith('images/')][:5]}"
    assert any(n.startswith("tables/") for n in names), "filtered save dropped the tables too"

    # A filtered write is an export: the session still holds the images the file lacks,
    # so it must not adopt the result as its own checkpoint.
    assert sess.store_path == before_store and sess.saved == before_saved, \
        f"filtered save adopted the export: store_path={sess.store_path} saved={sess.saved}"
    assert raster_mtimes() == before_mtimes, "filtered save rewrote the source rasters"
    assert [i["name"] for i in client.get(f"/api/sessions/{sid}/elements").json()["images"]] == images, \
        "filtered save mutated the live session's images"

    sdata, extract_dir, _ = store.read_spatialdata_archive(out)
    assert not list(sdata.images), f"reloaded filtered checkpoint still has images: {list(sdata.images)}"
    assert list(sdata.tables), "reloaded filtered checkpoint has no tables"
    reloaded = sdata.attrs["app_state"]["displays"][0]["encoding"]["image_layer"]
    assert reloaded is None, f"display still references a dropped image: {reloaded!r}"
    root = zarr.open_group(store._zarr_root(extract_dir), mode="r")
    assert dict(root["viewer"].attrs)["images"] == {}, "viewer sidecar still advertises images"
    print("[ok] filtered save dropped images from file, sidecar and displays")

    # Resolution trim: same image, minus its finest level. The file has to shrink, and
    # the coarser level that becomes level 0 has to keep the image's place in the world.
    from app import imaging
    img = images[0]
    coarse = os.path.join(str(config.DATA_DIR), "coarse_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save",
                     json={"path": coarse, "levels": {img: 1}}).json()
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"
    assert sess.store_path == before_store and sess.saved == before_saved, \
        f"level-trimmed save adopted the export: store_path={sess.store_path} saved={sess.saved}"
    assert raster_mtimes() == before_mtimes, "level-trimmed save rewrote the source rasters"
    assert os.path.getsize(coarse) < os.path.getsize(checkpoint_path), \
        f"level-trimmed save is no smaller: {os.path.getsize(coarse)} vs {os.path.getsize(checkpoint_path)}"

    trimmed, trimmed_dir, _ = store.read_spatialdata_archive(coarse)
    got, want = imaging.image_info(trimmed, img), imaging.image_info(sess.sdata, img)
    assert len(got["levels"]) == len(levels) - 1, f"pyramid not trimmed: {got['levels']}"
    assert (got["width"], got["height"]) == (levels[1]["width"], levels[1]["height"]), \
        f"trimmed image's level 0 isn't the old level 1: {got['width']}x{got['height']}"
    assert all(abs(a - b) < 1e-6 for a, b in zip(got["bounds"], want["bounds"])), \
        f"trimmed image moved: {got['bounds']} vs {want['bounds']}"
    assert got["channel_names"] == want["channel_names"], "trimmed image lost its channel names"
    # The sidecar manifest is keyed [element][table_key] — every entry has to describe
    # the trimmed pyramid, or the browser reader asks for a level that isn't there.
    sidecar = dict(zarr.open_group(store._zarr_root(trimmed_dir), mode="r")["viewer"].attrs)
    assert all(len(info["levels"]) == len(got["levels"])
               for info in sidecar["images"][img].values()), \
        f"viewer sidecar advertises a pyramid the file doesn't have: {sidecar['images'][img]}"
    print(f"[ok] resolution trim: {len(levels)} levels -> {len(got['levels'])}, "
          f"{os.path.getsize(checkpoint_path) // 1000}kB -> {os.path.getsize(coarse) // 1000}kB")

    bad = client.post(f"/api/sessions/{sid}/save", json={"levels": {img: len(levels)}})
    assert bad.status_code == 400, f"out-of-range level accepted: {bad.status_code}"
    bad = client.post(f"/api/sessions/{sid}/save", json={"levels": {"nope": 1}})
    assert bad.status_code == 400, f"unknown image in levels accepted: {bad.status_code}"
    print("[ok] resolution trim rejects out-of-range levels and unknown images")

    # Per-table slots: the same contract one level down, drawn from `slots` in the sized
    # inventory and summing to the table's own number the way the pyramid levels do.
    table = sized["tables"][0]
    slots = table["slots"]
    paths = [s["path"] for s in slots]
    assert "X" in paths and {"obs", "var", "uns"} <= set(paths), f"slot breakdown incomplete: {paths}"
    assert all(s["required"] == (s["path"] in ("obs", "var", "uns")) for s in slots), \
        f"wrong slots marked required: {slots}"
    drift = abs(sum(s["size_mb"] for s in slots) - table["size_mb"])
    assert drift <= 0.1 * (len(slots) + 1), f"slot sizes don't sum to the table size: {slots}"
    print(f"[ok] table slots: {[(s['path'], s['size_mb']) for s in slots]}")

    # Dropping X is the headline case: the file has to stay a valid SpatialData object
    # with the table's shape intact, hold no matrix (nor its CSC mirror), and neutralise
    # the coloring that read it.
    disp = client.get(f"/api/sessions/{sid}").json()["app_state"]["displays"][0]
    gene = client.get(f"/api/sessions/{sid}").json()["fields"]["var_names_sample"][0]
    disp["encoding"]["color_by"] = f"X:{gene}"
    assert client.put(f"/api/sessions/{sid}/displays/{disp['id']}", json=disp).status_code == 200
    noX = os.path.join(str(config.DATA_DIR), "no_x_session.zarr.zip")
    keep = [p for p in paths if p != "X"]
    sv = client.post(f"/api/sessions/{sid}/save",
                     json={"path": noX, "slots": {table["name"]: keep}}).json()
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"
    assert sess.store_path == before_store and sess.saved == before_saved, \
        f"slot-trimmed save adopted the export: store_path={sess.store_path} saved={sess.saved}"

    with zipfile.ZipFile(noX) as z:
        names = z.namelist()
    assert not any(n.startswith(f"tables/{table['name']}/X/") for n in names), \
        "table saved without X still wrote the matrix"
    assert not any("X_csc" in n for n in names), "table saved without X still wrote the CSC mirror"
    trimmed_table, _, _ = store.read_spatialdata_archive(noX)
    tb = trimmed_table.tables[table["name"]]
    assert tb.X is None, f"expected no X, got {type(tb.X)}"
    assert (tb.n_obs, tb.n_vars) == (table["n_obs"], table["n_vars"]), \
        f"table lost its shape without X: {tb.shape}"
    assert tb.uns.get("spatialdata_attrs"), "table saved without X lost its SpatialData linkage"
    assert trimmed_table.attrs["app_state"]["displays"][0]["encoding"]["color_by"] is None, \
        "a gene coloring survived the save that dropped X"
    assert sess.active_table().X is not None, "slot-trimmed save mutated the live table"
    print(f"[ok] table saved without X: {os.path.getsize(noX) // 1000}kB, shape {tb.shape} kept")

    bad = client.post(f"/api/sessions/{sid}/save",
                      json={"slots": {table["name"]: [p for p in paths if p != "obs"]}})
    assert bad.status_code == 400, f"dropping a required slot accepted: {bad.status_code}"
    bad = client.post(f"/api/sessions/{sid}/save", json={"slots": {table["name"]: paths + ["nope"]}})
    assert bad.status_code == 400, f"unknown slot accepted: {bad.status_code}"
    bad = client.post(f"/api/sessions/{sid}/save", json={"slots": {"nosuch": paths}})
    assert bad.status_code == 400, f"unknown table in slots accepted: {bad.status_code}"
    coords = disp["encoding"]["coords"].split(":", 1)
    if coords[0] == "obsm":
        bad = client.post(f"/api/sessions/{sid}/save", json={
            "slots": {table["name"]: [p for p in paths if p != f"obsm/{coords[1]}"]}})
        assert bad.status_code == 400, f"dropping a display's coordinates accepted: {bad.status_code}"
    print("[ok] slot selection rejects required slots, unknown slots and a display's coordinates")

    bad = client.post(f"/api/sessions/{sid}/save", json={"include": {"images": ["nope"]}})
    assert bad.status_code == 400, f"unknown element name accepted: {bad.status_code}"
    bad = client.post(f"/api/sessions/{sid}/save", json={"include": {"tables": []}})
    assert bad.status_code == 400, f"dropping the active table accepted: {bad.status_code}"
    bad = client.post(f"/api/sessions/{sid}/save", json={"include": {"nosuch": []}})
    assert bad.status_code == 400, f"unknown facet accepted: {bad.status_code}"
    print("[ok] selective save rejects unknown elements, unknown facets and a table-less selection")


def run_content_hash_flow(client):
    """Default-path save writes a content-hashed filename that reloads, and a second
    save doesn't stack a second hash suffix (recent 'Content-hash checkpoint names')."""
    from app.persistence.store import strip_content_hash
    from app.deps import MANAGER
    import re
    sid = new_session(client)
    clean = strip_content_hash(MANAGER.get(sid).name)

    sv = client.post(f"/api/sessions/{sid}/save", json={}).json()  # no path -> hash-named
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"
    p1 = MANAGER.get(sid).store_path
    base = os.path.basename(p1)
    assert re.fullmatch(rf"{re.escape(clean)}-[0-9a-f]+\.sdata\.zarr\.zip", base), base
    assert os.path.exists(p1)
    print(f"[ok] default save wrote content-hashed {base}")

    # the hashed file reloads cleanly (content-hash check passes, doesn't raise)
    assert client.get(f"/api/sessions/{new_session(client, p1)}").json()["app_state"] is not None
    # saving again must not stack a second -hash segment
    sv2 = client.post(f"/api/sessions/{sid}/save", json={}).json()
    assert wait_job(client, sid, sv2["job_id"])["status"] == "completed"
    base2 = os.path.basename(MANAGER.get(sid).store_path)
    assert re.fullmatch(rf"{re.escape(clean)}-[0-9a-f]+\.sdata\.zarr\.zip", base2), f"hash stacked: {base2}"
    print("[ok] hashed checkpoint reloads; re-save doesn't stack a second hash")


def run_save_destination_flow(client):
    """The Save dialog's three destination options: the folder the file lands in (created
    if new), the filename prefix the content hash is appended to, and the session name the
    file records — which a reload adopts in place of the filename."""
    import re
    from app.deps import MANAGER
    sid = new_session(client)
    folder, prefix, name = "runs/pass-2", "cluster-pass2", "Cluster pass 2"

    sv = client.post(f"/api/sessions/{sid}/save",
                     json={"folder": folder, "prefix": prefix, "name": name}).json()
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"
    written = MANAGER.get(sid).store_path
    assert os.path.dirname(written) == str(config.DATA_DIR / folder), written
    base = os.path.basename(written)
    assert re.fullmatch(rf"{re.escape(prefix)}-[0-9a-f]+\.sdata\.zarr\.zip", base), base
    # The name is the session's now, and it is not what the file is called.
    assert MANAGER.get(sid).name == name, MANAGER.get(sid).name
    print(f"[ok] save wrote {folder}/{base} and renamed the session to {name!r}")

    # ...so reopening the file shows the recorded name rather than the prefix.
    sid2 = new_session(client, written)
    assert MANAGER.get(sid2).name == name, MANAGER.get(sid2).name
    assert client.get("/api/sessions").json()["sessions"], "session list went empty"
    print("[ok] reloaded checkpoint adopted its recorded name over its filename")
    # An explicitly named load keeps the caller's name instead.
    r = client.post("/api/sessions", json={"source": {"kind": "load", "path": written},
                                           "name": "explicit"})
    poll(client, r.json()["id"], lambda s: s["summary"]["status"] in ("ready", "errored"))
    assert MANAGER.get(r.json()["id"]).name == "explicit"
    print("[ok] an explicitly named load ignores the file's recorded name")

    for body, why in [({"folder": "../escape"}, "folder escaping the data dir"),
                      ({"prefix": "sub/dir"}, "prefix with a path separator"),
                      ({"prefix": "  "}, "blank prefix"),
                      ({"prefix": ".hidden"}, "dot-prefixed (scanner-invisible) prefix"),
                      ({"name": ""}, "blank name"),
                      ({"path": "/tmp/x.zarr.zip", "prefix": "x"}, "path plus prefix")]:
        bad = client.post(f"/api/sessions/{sid}/save", json=body)
        assert bad.status_code == 400, f"{why} accepted: {bad.status_code}"
    print("[ok] save rejects an escaping folder, a bad prefix, a blank name, path+prefix")


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

    run_figure_persistence(client, sid, plot["id"])

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

    # An invalidated plot's figure is not persisted (its bytes no longer match the data),
    # so it reloads invalidated and the session reports no figure for it — even though the
    # stale bytes are still in memory.
    assert client.get(f"/api/sessions/{sid}").json()["figures"] == {}, \
        "an invalidated plot still advertises a figure"
    out = os.path.join(str(config.DATA_DIR), "invalidation_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"
    st2 = client.get(f"/api/sessions/{new_session(client, out)}").json()
    assert all(p["status"] == "invalidated" for p in st2["app_state"]["plots"]), \
        [p["status"] for p in st2["app_state"]["plots"]]
    assert st2["figures"] == {}, st2["figures"]
    print("[ok] invalidated plots keep no figure and reload invalidated")


def run_figure_persistence(client, sid, plot_id):
    """A drawn plot's rendered figure travels in the checkpoint (DESIGN §13.2): the plot
    reloads `drawn` with its figure fetchable and byte-identical, a save that deselects
    it reloads the same plot as invalidated, and the browser-readable sidecar lists what
    is there. Called from `run_invalidation_flow` with a session holding one drawn plot."""
    import zipfile
    import zarr
    from app.persistence import store

    formats = ("svg", "pdf", "png")
    source = {}
    for fmt in formats:
        r = client.get(f"/api/sessions/{sid}/plots/{plot_id}/figure?fmt={fmt}")
        assert r.status_code == 200, f"{fmt}: {r.status_code}"
        source[fmt] = r.content
    index = client.get(f"/api/sessions/{sid}").json()["figures"]
    assert index[plot_id] == {f: len(source[f]) for f in formats}, index[plot_id]

    out = os.path.join(str(config.DATA_DIR), "figures_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"

    with zipfile.ZipFile(out) as z:
        names = z.namelist()
    assert any(n.startswith(f"viewer/figures/{plot_id}/svg/") for n in names), \
        [n for n in names if n.startswith("viewer/figures")][:5]

    reloaded = new_session(client, out)
    st = client.get(f"/api/sessions/{reloaded}").json()
    rec = next(p for p in st["app_state"]["plots"] if p["id"] == plot_id)
    assert rec["status"] == "drawn", f"a persisted figure must reload drawn, not {rec['status']}"
    assert st["figures"][plot_id] == index[plot_id], st["figures"]
    for fmt in formats:
        r = client.get(f"/api/sessions/{reloaded}/plots/{plot_id}/figure?fmt={fmt}")
        assert r.status_code == 200 and r.content == source[fmt], f"{fmt} figure changed across the save"
    print(f"[ok] drawn plot reloads drawn; {'/'.join(formats)} figures byte-identical "
          f"({sum(len(b) for b in source.values())/1e6:.1f} MB)")

    # ...and the same plot saved with its figure deselected reloads invalidated. Run that
    # save from the RELOADED session, whose only copy of the figure is the one in the
    # store its incremental save rewrites: dropping a figure from the file must not take
    # it away from the open session.
    bare = os.path.join(str(config.DATA_DIR), "figures_excluded.zarr.zip")
    sv = client.post(f"/api/sessions/{reloaded}/save", json={"path": bare, "figures": []}).json()
    assert wait_job(client, reloaded, sv["job_id"])["status"] == "completed"
    with zipfile.ZipFile(bare) as z:
        assert not [n for n in z.namelist() if n.startswith("viewer/figures/")], "figures not dropped"
    _, extract_dir, _ = store.read_spatialdata_archive(bare)
    assert dict(zarr.open_group(store._zarr_root(extract_dir), mode="r")["viewer"].attrs)["figures"] == {}, \
        "sidecar still lists figures the file doesn't carry"
    st = client.get(f"/api/sessions/{new_session(client, bare)}").json()
    rec = next(p for p in st["app_state"]["plots"] if p["id"] == plot_id)
    assert rec["status"] == "invalidated", rec["status"]
    assert st["figures"] == {}, st["figures"]
    assert client.get(f"/api/sessions/{reloaded}/plots/{plot_id}/figure").content == source["svg"], \
        "excluding a figure from the file took it away from the session that saved it"
    print("[ok] figures=[] writes no figures, reloads invalidated, saving session unaffected")

    bad = client.post(f"/api/sessions/{sid}/save", json={"figures": ["nope"]})
    assert bad.status_code == 400, f"unknown plot id accepted: {bad.status_code}"
    bad = client.post(f"/api/sessions/{sid}/save", json={"figures": "svg"})
    assert bad.status_code == 400, f"non-list figures accepted: {bad.status_code}"
    print("[ok] save rejects an unknown plot id and a non-list figure selection")


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

    out = os.path.join(str(config.DATA_DIR), "encoding_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    assert wait_job(client, sid, sv["job_id"])["status"] == "completed"
    rl = next(d for d in client.get(f"/api/sessions/{new_session(client, out)}").json()["app_state"]["displays"]
              if d["id"] == disp["id"])
    assert rl["encoding"]["show_image"] is False and rl["encoding"]["isolated_category"] == "5"
    assert rl["encoding"]["colormap"] == "magma" and rl["viewport"]["zoom"] == 3, rl
    print("[ok] canvas encoding (toggles, isolated category, camera) survives save + reload")


def run_encoding_defaults_parity():
    """The encoding fallbacks the figure renderer applies equal the ones the canvas
    applies. Three readers share this table — `appstate.POINT_ENCODING_DEFAULTS`,
    `manager.auto_displays`, and `POINT_DEFAULTS` in packages/viewer/src/defaults.ts —
    and they had drifted (the renderer used point_size 6 / opacity 1.0 against the
    canvas's 4 / 0.85), so an exported figure of a checkpoint predating those fields did
    not match the canvas. Parse the TS constant rather than restating it here: a fourth
    copy in the assertion would defeat the point."""
    from app.sessions.appstate import POINT_ENCODING_DEFAULTS

    ts_path = os.path.join(_REPO_ROOT, "packages", "viewer", "src", "defaults.ts")
    with open(ts_path) as fh:
        ts = fh.read()
    block = re.search(r"const POINT_DEFAULTS = \{(.*?)\}", ts, re.S)
    assert block, "POINT_DEFAULTS not found in packages/viewer/src/defaults.ts"
    in_ts = {}
    for key, raw in re.findall(r"(\w+):\s*'?([\w.]+)'?\s*,", block.group(1)):
        in_ts[key] = float(raw) if re.fullmatch(r"[\d.]+", raw) else raw
    expected = {k: (float(v) if isinstance(v, (int, float)) else v)
                for k, v in POINT_ENCODING_DEFAULTS.items()}
    assert in_ts == expected, f"canvas defaults {in_ts} != backend {expected}"
    print(f"[ok] encoding defaults agree across backend and canvas ({expected})")


def run_cirro_auth_flow(client):
    """Cirro's per-browser credential scoping and upload bundle (DESIGN §15), without
    talking to Cirro: the device-code flow itself needs a real domain and a human, so
    this covers everything around it — the auth state machine, the fact that every
    Cirro call is refused without a valid credential token, the path-traversal guard on
    the selected checkpoints, and the shape of the bundle that gets uploaded."""
    from app import cirro

    # ---- state machine. Unknown/absent token reads as disconnected, never as an error.
    auth = client.get("/api/cirro/auth").json()
    assert auth["state"] == "disconnected", auth
    assert auth["default_domain"], "connect dialog has nothing to prefill"
    assert client.get("/api/cirro/auth", headers={"X-SDS-Cirro-Token": "bogus"}).json()["state"] \
        == "disconnected"
    assert client.post("/api/cirro/auth", json={}).status_code == 400  # no domain

    # ---- every Cirro call needs a credential, and a credential is only ever named by
    # the minted secret — a presence client id must not stand in for one.
    for path in ("/api/cirro/projects", "/api/cirro/projects/p1/folders"):
        assert client.get(path).status_code == 401, path
        assert client.get(path, headers={"X-SDS-Client-Id": "viewer-a"}).status_code == 401, path
    assert client.post("/api/cirro/upload", json={
        "project_id": "p", "dataset_name": "d", "session_paths": ["x"]}).status_code == 401
    print("[ok] cirro: unauthenticated calls refused (401), client id is not a credential")

    # ---- store: mint, look up, expire, drop. Two tokens never collide.
    live_code = time.monotonic() + cirro.IDLE_EXPIRY_S
    cred = cirro.Credential(domain="example.cirro.bio", login_url="https://x/login", auth=None,
                            login_deadline=live_code)
    token = cirro.CREDENTIALS.put(cred)
    other = cirro.CREDENTIALS.put(cirro.Credential(domain="d2", login_url="u2", auth=None,
                                                   login_deadline=live_code))
    assert token != other and len(token) > 20, "credential token must be unguessable"
    assert cirro.CREDENTIALS.get(token) is cred
    assert client.get("/api/cirro/auth", headers={"X-SDS-Cirro-Token": token}).json() \
        == {**cred.public(), "default_domain": config.CIRRO_BASE_URL,
            "viewer_bundled": cirro.viewer_available()}
    # A pending credential is not yet usable for anything but reading its own state.
    assert cred.public()["state"] == "pending" and cred.public()["login_url"]
    assert client.get("/api/cirro/projects",
                      headers={"X-SDS-Cirro-Token": token}).status_code == 401

    # ---- a pending login past its device code's deadline reports itself expired and
    # stops handing out the dead login URL, without waiting for the SDK's poll thread
    # (which sleeps between checks) to reach the same conclusion.
    cred.login_deadline = time.monotonic() - 1
    assert cred.state == "pending", "expiry must be derived, not written over the state"
    expired = client.get("/api/cirro/auth", headers={"X-SDS-Cirro-Token": token}).json()
    assert expired["state"] == "expired", expired
    assert expired["login_url"] is None, "served a login URL Cirro no longer honors"
    assert expired["domain"] == "example.cirro.bio", "refresh needs the domain to reuse"
    assert client.get("/api/cirro/projects",
                      headers={"X-SDS-Cirro-Token": token}).status_code == 401
    cred.login_deadline = live_code

    cred.last_used -= cirro.IDLE_EXPIRY_S + 1
    assert cirro.CREDENTIALS.get(token) is None, "idle credential not expired"
    assert cirro.CREDENTIALS.get(other) is not None, "expiry dropped an active credential"
    cirro.CREDENTIALS.drop(other)
    assert cirro.CREDENTIALS.get(other) is None
    print("[ok] cirro: credential store mints, scopes, expires and drops")

    # ---- login URL is extracted from the SDK's human-readable auth message.
    assert cirro._login_url("To authenticate, visit https://x.cirro.bio/device and enter AB-CD.") \
        == "https://x.cirro.bio/device"

    # ---- the deadline comes off the SDK's flow response, which is the only place the
    # device code's lifetime is exposed. Both halves of that coupling are checked here,
    # since neither needs a real login: the SDK still declares the field, and a stub
    # flow converts to a monotonic instant (a past expiry clamps to now, never a
    # negative window that would read as "already expired by hours").
    from cirro.auth.oauth_models import DeviceTokenResponse
    assert "expiry" in DeviceTokenResponse.__annotations__, \
        "the Cirro SDK renamed the device-code expiry field"

    class _StubAuth:
        def __init__(self, offset_s):
            stamp = datetime.datetime.now().astimezone() + datetime.timedelta(seconds=offset_s)
            self._flow = {"expiry": stamp.isoformat()}

    assert 590 < cirro._login_deadline(_StubAuth(600)) - time.monotonic() <= 600
    assert cirro._login_deadline(_StubAuth(-60)) <= time.monotonic()
    print("[ok] cirro: device-code deadline read from the SDK flow, expiry state derived")

    # ---- a connected credential still can't reach outside DATA_DIR.
    live = cirro.Credential(domain="d", login_url="u", auth=None, login_deadline=live_code,
                            state="connected")
    live_token = cirro.CREDENTIALS.put(live)
    hdr = {"X-SDS-Cirro-Token": live_token}
    for bad in ("/etc/passwd", str(config.DATA_DIR / ".." / "escape.zarr.zip")):
        r = client.post("/api/cirro/upload", headers=hdr, json={
            "project_id": "p", "dataset_name": "d", "session_paths": [bad]})
        assert r.status_code == 400, (bad, r.status_code)
    # ...and the required fields are enforced before any work starts.
    assert client.post("/api/cirro/upload", headers=hdr, json={
        "project_id": "p", "dataset_name": "d", "session_paths": []}).status_code == 400
    assert client.post("/api/cirro/upload", headers=hdr, json={
        "project_id": "", "dataset_name": "", "session_paths": ["x"]}).status_code == 400
    print("[ok] cirro: upload rejects paths outside DATA_DIR and incomplete requests")

    # ---- upload rows are owned by the credential that started them. A row names a
    # Cirro project and dataset, so another browser must not see it. Driven through
    # the real endpoint; the upload itself fails in the background (this credential
    # has no live Cirro session), which is the failure path and settles the row.
    from app.cirro import UPLOADS
    decoy = os.path.join(str(config.DATA_DIR), "cirro_scope_probe.sdata.zarr.zip")
    with open(decoy, "wb") as fh:
        fh.write(b"not-a-real-zip")
    mine = None
    try:
        r = client.post("/api/cirro/upload", headers=hdr, json={
            "project_id": "p", "dataset_name": "My Dataset", "session_paths": [decoy]})
        assert r.status_code == 200, r.text
        mine = r.json()["id"]
        assert [u["dataset_name"] for u in
                client.get("/api/cirro/uploads", headers=hdr).json()["uploads"]] == ["My Dataset"]
        # Another browser's credential — and an anonymous caller — see nothing.
        assert client.get("/api/cirro/uploads").json()["uploads"] == []
        assert client.get("/api/cirro/uploads",
                          headers={"X-SDS-Cirro-Token": "other"}).json()["uploads"] == []
        assert all("token" not in u for u in
                   client.get("/api/cirro/uploads", headers=hdr).json()["uploads"]), \
            "credential token leaked into an upload row"

        # ...and only its owner can dismiss it, once settled.
        deadline = time.time() + 30
        while UPLOADS._uploads[mine]["state"] not in ("completed", "failed"):
            assert time.time() < deadline, "cirro upload row never settled"
            time.sleep(0.1)
        client.delete(f"/api/cirro/uploads/{mine}", headers={"X-SDS-Cirro-Token": "other"})
        assert len(client.get("/api/cirro/uploads", headers=hdr).json()["uploads"]) == 1, \
            "dismissed another user's upload"
        assert client.delete(f"/api/cirro/uploads/{mine}",
                             headers=hdr).json()["uploads"] == []
    finally:
        UPLOADS._uploads.pop(mine, None)
        os.remove(decoy)
    print("[ok] cirro: upload rows are scoped to their owner's credential")

    cirro.CREDENTIALS.drop(live_token)

    # ---- the bundle is a serverless deployment (DESIGN §14.3): checkpoints under
    # sessions/, an index.json naming them, and the built SPA as real dirs of symlinks.
    staging = tempfile.mkdtemp()
    ckpt = os.path.join(staging, "Demo Session-3fa21c9b8e4d.sdata.zarr.zip")
    with open(ckpt, "wb") as fh:
        fh.write(b"not-a-real-zip")
    static = os.path.join(staging, "spa")
    os.makedirs(os.path.join(static, "assets"))
    for rel in ("index.html", "assets/index-abc.js", "assets/index-abc.css"):
        with open(os.path.join(static, rel), "w") as fh:
            fh.write("x")

    saved_static = config.STATIC_DIR
    try:
        config.STATIC_DIR = pathlib.Path(static)
        assert cirro.viewer_available()
        bundle = cirro.build_upload_folder([ckpt])
        try:
            names = {os.path.relpath(os.path.join(dirpath, f), bundle)
                     for dirpath, _, files in os.walk(bundle) for f in files}
            assert names == {
                "index.json", "index.html",
                os.path.join("assets", "index-abc.js"), os.path.join("assets", "index-abc.css"),
                os.path.join("sessions", os.path.basename(ckpt)),
            }, names
            # Real directories of per-file symlinks — a symlinked *directory* would be
            # skipped wholesale by the SDK's upload walker.
            for d in ("sessions", "assets"):
                assert not os.path.islink(os.path.join(bundle, d)), d
            assert os.path.islink(os.path.join(bundle, "sessions", os.path.basename(ckpt)))
            with open(os.path.join(bundle, "index.json")) as fh:
                index = json.load(fh)
            assert index["checkpoints"] == [{
                "path": f"sessions/{os.path.basename(ckpt)}",
                "label": "Demo Session",  # storage hash + extension stripped
            }], index
        finally:
            shutil.rmtree(bundle, ignore_errors=True)

        # With no built SPA the upload still works, minus the viewer — the local-dev case.
        config.STATIC_DIR = None
        assert not cirro.viewer_available()
        bundle = cirro.build_upload_folder([ckpt])
        try:
            assert os.path.exists(os.path.join(bundle, "index.json"))
            assert not os.path.exists(os.path.join(bundle, "index.html"))
        finally:
            shutil.rmtree(bundle, ignore_errors=True)
    finally:
        config.STATIC_DIR = saved_static
        shutil.rmtree(staging, ignore_errors=True)
    print("[ok] cirro: upload bundle is a self-hosting serverless deployment")


def run_session_lock_flow(client):
    """Viewer presence + the per-session edit lock (sessions/presence.py): attaching
    takes an unlocked session's lock, a second viewer is refused every mutation but
    keeps every read, and release → take hands the lock over. The offline/CLI caller
    (no client id, as everywhere else in this file) writes freely while nobody holds
    the lock and is refused while someone does."""
    sid = new_session(client)
    a, b = {"X-SDS-Client-Id": "viewer-a"}, {"X-SDS-Client-Id": "viewer-b"}

    def beat(client_id, name, session_id=sid):
        return client.post("/api/presence", json={
            "client_id": client_id, "name": name, "session_id": session_id}).json()["sessions"]

    def display_put(headers):
        disp = next(d for d in client.get(f"/api/sessions/{sid}").json()["app_state"]["displays"]
                    if d["type"] == "spatial_canvas")
        return client.put(f"/api/sessions/{sid}/displays/{disp['id']}", json=disp, headers=headers)

    assert display_put({}).status_code == 200, "an unwatched session must stay writable"

    view = beat("viewer-a", "gloomy socrates")[sid]
    assert view["lock"] == {"client_id": "viewer-a", "name": "gloomy socrates"}, view
    view = beat("viewer-b", "brave curie")[sid]
    assert view["lock"]["client_id"] == "viewer-a", view
    assert view["viewers"] == ["brave curie", "gloomy socrates"], view

    assert display_put(a).status_code == 200, "the holder must be able to write"
    assert display_put(b).status_code == 423, "a non-holder's write must be refused"
    assert display_put({}).status_code == 423, "an unidentified write must be refused too"
    # Reads stay open to everyone — that is what makes view-only access work.
    assert client.get(f"/api/sessions/{sid}", headers=b).status_code == 200
    assert client.get(f"/api/sessions/{sid}/data/obsm:spatial", headers=b).status_code == 200

    assert client.post(f"/api/sessions/{sid}/lock", headers=b).status_code == 409
    assert client.delete(f"/api/sessions/{sid}/lock", headers=b).status_code == 403
    assert client.delete(f"/api/sessions/{sid}/lock", headers=a).status_code == 200
    assert beat("viewer-b", "brave curie")[sid]["lock"] is None
    assert client.post(f"/api/sessions/{sid}/lock", headers=b).status_code == 200
    assert display_put(b).status_code == 200 and display_put(a).status_code == 423

    # A viewer that stops heartbeating drops out and releases its lock, so a closed
    # tab never strands a session. Swept by the next heartbeat from anyone — here one
    # that is attached to no session, so it doesn't take the freed lock itself.
    timeout = config.PRESENCE_TIMEOUT_S
    config.PRESENCE_TIMEOUT_S = 0.05
    try:
        time.sleep(0.2)
        assert sid not in beat("viewer-a", "gloomy socrates", None), "silent viewers must be swept"
    finally:
        config.PRESENCE_TIMEOUT_S = timeout
    assert display_put({}).status_code == 200, "the lock must be free once its holder times out"

    # Closing a session takes it out of presence, and a client still showing it is
    # treated as attached to nothing rather than re-locking a session that is gone.
    assert beat("viewer-a", "gloomy socrates")[sid]["lock"]["client_id"] == "viewer-a"
    assert client.delete(f"/api/sessions/{sid}", headers=a).status_code == 200
    assert sid not in beat("viewer-a", "gloomy socrates"), "a closed session must leave presence"
    print("[ok] session lock: auto-lock on attach, 423 for others, release → take, timeout release")


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
    from app.deps import MANAGER

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

    out = os.path.join(str(config.DATA_DIR), "filter_reshape_session.zarr.zip")
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

    # snapshot fidelity: a display in render_mode 'points+shapes' must render the SAME
    # cell-boundary polygons the canvas overlays once zoomed in -- not fall back to the
    # circle markers. Configure a world-space display (no image) so the framing math is
    # directly computable, then snapshot zoomed in past the shapes gate (window sized
    # under POLYGON_LIMIT cells) and zoomed out (below the gate -> points).
    spatial_disp = next(d for d in client.get(f"/api/sessions/{sid}").json()["app_state"]["displays"]
                        if d["type"] == "spatial_canvas")
    enc = {**spatial_disp["encoding"], "render_mode": "points+shapes",
           "shapes_layer": "cell_boundaries", "image_layer": None,
           "show_image": False, "show_points": True}
    spatial_disp = {**spatial_disp, "encoding": enc}
    assert client.put(f"/api/sessions/{sid}/displays/{spatial_disp['id']}",
                      json=spatial_disp).status_code == 200
    spacing = float(np.sqrt(max((maxx - minx) * (maxy - miny), 1.0) / max(1, len(wx))))
    gate_zoom = np.log2(6.0 / spacing)  # snapshots.SHAPES_MIN_CELL_PX / spacing, world space
    center = [float(np.median(wx)), float(np.median(wy))]

    def snap_render(zoom):
        spec = {"label": "seg-shapes", "viewport": {"target": center, "zoom": float(zoom)},
                "width_px": 800, "height_px": 800, "dpi": 100, "formats": ["png"],
                "display_id": spatial_disp["id"]}
        nm = client.post(f"/api/sessions/{sid}/snapshot", json=spec).json()["name"]
        m = next(s for s in client.get("/api/snapshots").json()["snapshots"]
                 if s["name"] == nm)["metadata"]["render"]
        client.delete(f"/api/snapshots/{nm}")
        return m

    zoomed_in = snap_render(gate_zoom + 3.0)   # +3 keeps the window well under POLYGON_LIMIT
    assert zoomed_in["shapes_drawn"] > 0, f"points+shapes drew no polygons zoomed in: {zoomed_in}"
    zoomed_out = snap_render(gate_zoom - 3.0)
    assert zoomed_out["shapes_drawn"] == 0, f"below the gate must fall back to points: {zoomed_out}"
    print(f"[ok] snapshot points+shapes: {zoomed_in['shapes_drawn']} polygons zoomed in, "
          f"points ({zoomed_out['cells_in_view']} cells) zoomed out")

    # checkpoint round-trip: cell_boundaries survives save + reload and still serves
    out = os.path.join(str(config.DATA_DIR), "xenium_segmentation.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    assert wait_job(client, sid, sv["job_id"], timeout=300)["status"] == "completed"
    sid2 = new_session(client, out)
    assert "cell_boundaries" in poly_names(client.get(f"/api/sessions/{sid2}/elements").json())
    r2 = client.get(f"/api/sessions/{sid2}/shapes/cell_boundaries/geoarrow", params={"bbox": covering})
    assert ipc.open_stream(io.BytesIO(r2.content)).read_all().num_rows > 0
    print("[ok] cell_boundaries survived save + reload; geoarrow still serves it")

    # The same checkpoint, checked as the serverless viewer reads it: is the boundary
    # parquet spatially queryable over HTTP Range?
    run_shape_index_check(client, sid, out)

    # a session with no polygons (visium_hne): no polygon element; geoarrow 404s
    sid_v = new_session(client)
    assert not poly_names(client.get(f"/api/sessions/{sid_v}/elements").json())
    assert client.get(f"/api/sessions/{sid_v}/shapes/cell_boundaries/geoarrow",
                      params={"bbox": "0,0,1,1"}).status_code == 404
    print("[ok] visium_hne: no polygon shapes; geoarrow 404s")

    print("\nSEGMENTATION E2E CHECKS PASSED")


def run_raster_flow(client):
    """Client-side (Viv) compositing path: the image /info manifest advertises the
    raw-raster route and the browser reads the session's on-disk normalized zarr
    directly. Verifies the new /info fields, that the raster route serves a group
    zarr.json and a real chunk file (200 + Range 206), and that key traversal /
    missing keys 404. Uses xenium.zarr, whose rasters normalize_rasters rebuilds
    into a served store (visium checkpoints can be canonical and serve no store)."""
    import os as _os
    from app.deps import MANAGER

    # This flow validates the client-compositing serving path, so enable it explicitly
    # rather than depend on the default (which ships off; see config.CLIENT_IMAGE_COMPOSITING).
    _prev_flag = config.CLIENT_IMAGE_COMPOSITING
    config.CLIENT_IMAGE_COMPOSITING = True

    sid = new_session(client, XENIUM)
    inv = client.get(f"/api/sessions/{sid}/elements").json()
    image_names = [im["name"] for im in inv["images"]]
    assert image_names, inv

    # every image /info carries the client-compositing manifest fields, well-typed
    compositable = None
    for name in image_names:
        info = client.get(f"/api/sessions/{sid}/image/{name}/info").json()
        assert info["raster_base_url"] == f"/api/sessions/{sid}/raster/{name}", info
        assert info["zarr_group_path"] == f"images/{name}", info
        assert isinstance(info["client_compositing"], bool) and isinstance(info["is_rgb"], bool), info
        assert len(info["contrast_limits"]) == info["channels"], info
        assert all(lo == 0.0 and hi > 0 for lo, hi in info["contrast_limits"]), info["contrast_limits"]
        if info["client_compositing"]:
            compositable = (name, info)
    assert compositable, f"no xenium image advertised client compositing: {image_names}"
    name, info = compositable
    base = info["raster_base_url"]
    print(f"[ok] /info client-compositing manifest for {len(image_names)} image(s); "
          f"{name} compositable (channels={info['channels']}, rgb={info['is_rgb']})")

    # the group zarr.json is served (zarrita opens the multiscale group here)
    grp = client.get(f"{base}/{info['zarr_group_path']}/zarr.json")
    assert grp.status_code == 200 and grp.json()["node_type"] == "group", grp.status_code
    rng = client.get(f"{base}/{info['zarr_group_path']}/zarr.json", headers={"Range": "bytes=0-9"})
    assert rng.status_code == 206 and len(rng.content) == 10 and \
        "content-range" in {k.lower() for k in rng.headers}, (rng.status_code, len(rng.content))
    assert client.head(f"{base}/zarr.json").status_code == 200

    # a real chunk file off disk (dataset-agnostic: found by walking the served store),
    # range-read the way zarrita fetches a chunk
    store_dir = MANAGER.get(sid).raster_stores[name]
    chunk_rel = next((_os.path.relpath(_os.path.join(r, f), store_dir)
                      for r, _, fs in _os.walk(store_dir) for f in fs if not f.endswith(".json")), None)
    assert chunk_rel, f"no chunk file under {store_dir}"
    ck = client.get(f"{base}/{chunk_rel}")
    assert ck.status_code == 200 and ck.content, (chunk_rel, ck.status_code)
    ckr = client.get(f"{base}/{chunk_rel}", headers={"Range": "bytes=0-99"})
    assert ckr.status_code == 206 and len(ckr.content) == 100, (ckr.status_code, len(ckr.content))
    print(f"[ok] raster route served group zarr.json + chunk {chunk_rel} (200 + Range 206)")

    # missing chunk (zarr fill), unknown element, and `..` traversal all 404
    assert client.get(f"{base}/{info['zarr_group_path']}/scale0/image/c/9/9/9").status_code == 404
    assert client.get(f"/api/sessions/{sid}/raster/not_an_element/zarr.json").status_code == 404
    # %2e%2e reaches the handler as `..` (httpx would otherwise collapse literal dots
    # client-side), exercising the server-side traversal guard in _raster_file.
    assert client.get(f"{base}/%2e%2e/%2e%2e/zarr.json").status_code == 404, "path traversal not rejected"
    print("[ok] raster route 404s missing chunk + unknown element; rejects traversal")

    config.CLIENT_IMAGE_COMPOSITING = _prev_flag

    assert client.delete(f"/api/sessions/{sid}").status_code == 200
    print("\nRASTER (client-compositing) E2E CHECKS PASSED")


def run_raster_survives_reshape_flow(client):
    """A reshaping compute (filter_cells) adopts a new object that carries the already
    tile-normalized image refs forward, so normalize_rasters finds them canonical and
    rebuilds nothing. The per-session raster store built at load must then be KEPT: the
    old code rmtree'd it whenever the re-normalize returned no new store, leaving every
    image a dangling zarr ref that reads back all-zero -- a black canvas, with contrast
    collapsing to [0,1] and no error raised. Guards that the image carries real signal
    both BEFORE AND after the filter (via the server thumbnail, which composites the
    same store the canvas reads), and the store stays mapped."""
    import numpy as np
    from PIL import Image
    from app.deps import MANAGER

    sid = new_session(client, XENIUM)
    sess = MANAGER.get(sid)
    assert sess.raster_stores, "xenium load rebuilt no raster store; flow needs a rebuilt image"
    name = next(iter(sess.raster_stores))

    def image_max():
        r = client.get(f"/api/sessions/{sid}/image/{name}/thumbnail?max_px=512")
        assert r.status_code == 200 and r.content, (r.status_code, len(r.content))
        return int(np.asarray(Image.open(io.BytesIO(r.content))).max())

    before = image_max()
    assert before > 0, f"image is black before any reshape (max={before}); fixture issue"

    per_cell = np.asarray(sess.active_table().X.sum(axis=1)).ravel()
    min_counts = int(np.quantile(per_cell, 0.25)) + 1
    client.post(f"/api/sessions/{sid}/jobs", json={
        "namespace": "sc.pp", "function": "filter_cells", "params": {"min_counts": min_counts}})
    poll(client, sid, lambda s: hist_status(s, "filter_cells")[0] in ("completed", "failed"))
    assert hist_status(client.get(f"/api/sessions/{sid}").json(), "filter_cells")[0] == "completed", \
        "filter_cells did not complete"

    after = image_max()
    assert after > 0, (f"image went black after filter_cells (max={after}): the "
                       "per-session raster store was deleted while still referenced")
    assert name in MANAGER.get(sid).raster_stores, "raster store dropped from map after reshape"
    print(f"[ok] image survived reshape (max {before} -> {after}); raster store kept")
    assert client.delete(f"/api/sessions/{sid}").status_code == 200


def run_raster_locality_flow(client):
    """A canonical (already tile-chunked) image whose backing store is a bare `.zarr`
    directory read straight from DATA_DIR -- not one of our own WORK_DIR-extracted
    checkpoints -- must still be copied into WORK_DIR at load rather than served
    straight from that original path: on a slow/object-store-backed mount, serving it
    live would mean every tile request reads from that mount for the life of the
    session (see rasters.py::normalize_rasters's locality gate). visium_hne.zarr is
    exactly this case (small already-pyramided chunks, loaded as a bare directory
    under DATA_DIR). Guards that (1) the served store resolves under WORK_DIR after
    load, and (2) a reshaping compute afterward doesn't re-copy it -- the known_stores
    gate must recognize the element as already local from the first call, not re-run
    the locality check and rebuild it again every time."""
    import numpy as np
    from pathlib import Path
    from app.deps import MANAGER

    sid = new_session(client, DATA)  # visium_hne: bare .zarr dir directly under DATA_DIR
    sess = MANAGER.get(sid)
    assert sess.raster_stores, "visium_hne load produced no raster store"
    name, store = next(iter(sess.raster_stores.items()))
    assert Path(store).resolve().is_relative_to(config.WORK_DIR.resolve()), (
        f"canonical image {name!r} served from outside WORK_DIR: {store} "
        "(locality gate did not rebuild a canonical-but-remote raster)")
    print(f"[ok] canonical image {name!r} loaded from DATA_DIR still served from WORK_DIR: {store}")

    per_cell = np.asarray(sess.active_table().X.sum(axis=1)).ravel()
    min_counts = int(np.quantile(per_cell, 0.25)) + 1
    client.post(f"/api/sessions/{sid}/jobs", json={
        "namespace": "sc.pp", "function": "filter_cells", "params": {"min_counts": min_counts}})
    poll(client, sid, lambda s: hist_status(s, "filter_cells")[0] in ("completed", "failed"))
    assert hist_status(client.get(f"/api/sessions/{sid}").json(), "filter_cells")[0] == "completed", \
        "filter_cells did not complete"
    assert MANAGER.get(sid).raster_stores.get(name) == store, (
        "raster store path changed after reshape -- element was needlessly re-copied")
    print("[ok] raster store path unchanged after reshape (no needless re-copy)")
    assert client.delete(f"/api/sessions/{sid}").status_code == 200


def run_filter_rank_genes_save_flow(client):
    """sc.tl.filter_rank_genes_groups marks dropped genes with np.nan (a float) in the
    object `names` record array of uns['rank_genes_groups_filtered']. anndata's zarr
    writer calls .encode() on that float (and hits a zero-length string dtype when a
    whole group is filtered), so no such session could be saved. save_spatialdata now
    coerces those fields to fixed-length unicode for the write only. Guards that a
    rank-and-filter session saves, and that the live object keeps its NaNs afterward."""
    def nan_count(client, sid):
        from app.deps import MANAGER
        names = MANAGER.get(sid).active_table().uns["rank_genes_groups_filtered"]["names"]
        return sum(1 for row in names for x in tuple(row) if not isinstance(x, str))

    sid = new_session(client, DATA)  # visium_hne carries obs['leiden']
    for fn, params in (("rank_genes_groups", {"groupby": "leiden"}),
                       ("filter_rank_genes_groups", {})):
        client.post(f"/api/sessions/{sid}/jobs",
                    json={"namespace": "sc.tl", "function": fn, "params": params})
        poll(client, sid, lambda s, fn=fn: hist_status(s, fn)[0] in ("completed", "failed"))
        assert hist_status(client.get(f"/api/sessions/{sid}").json(), fn)[0] == "completed", \
            f"{fn} did not complete"

    before = nan_count(client, sid)
    out = os.path.join(str(config.DATA_DIR), "rank_filter_session.zarr.zip")
    sv = client.post(f"/api/sessions/{sid}/save", json={"path": out}).json()
    js = wait_job(client, sid, sv["job_id"])
    assert js["status"] == "completed", \
        f"save after filter_rank_genes_groups failed: {js.get('error')}"
    assert nan_count(client, sid) == before, "save mutated the live uns names array"
    print(f"[ok] rank+filter session saved; live uns NaN markers preserved ({before})")
    assert client.delete(f"/api/sessions/{sid}").status_code == 200


# ---- MCP assistant surface (app/mcp/) ---------------------------------------
_MCP_HEADERS = {"Accept": "application/json, text/event-stream"}
_mcp_rpc_id = 0


def mcp_call(client, name, arguments=None):
    """One tools/call over the real stateless-JSON transport (POST /api/mcp).
    Returns (structured, content): the tool's structured dict (parsed from the text
    block when the SDK didn't attach structuredContent) and the raw content list.
    A tool error raises RuntimeError with the error text."""
    global _mcp_rpc_id
    _mcp_rpc_id += 1
    r = client.post("/api/mcp", headers=_MCP_HEADERS, json={
        "jsonrpc": "2.0", "id": _mcp_rpc_id, "method": "tools/call",
        "params": {"name": name, "arguments": arguments or {}}})
    assert r.status_code == 200, f"{name}: {r.status_code} {r.text[:300]}"
    result = r.json()["result"]
    content = result.get("content", [])
    if result.get("isError"):
        raise RuntimeError(content[0]["text"] if content else "tool error")
    structured = result.get("structuredContent")
    if structured is None:
        texts = [c["text"] for c in content if c.get("type") == "text"]
        if texts:
            try:
                structured = json.loads(texts[-1])
            except ValueError:
                structured = None
    return structured, content


def mcp_png(content):
    """Decode the image block of a view_display/view_plot response with PIL."""
    import base64
    from PIL import Image as PILImage
    img_block = next(c for c in content if c.get("type") == "image")
    assert img_block["mimeType"] == "image/png"
    return PILImage.open(io.BytesIO(base64.b64decode(img_block["data"])))


def _strict_inside(xy, x0, x1, y0, y1):
    return int(((xy[:, 0] > x0) & (xy[:, 0] < x1) & (xy[:, 1] > y0) & (xy[:, 1] < y1)).sum())


def _untied_bounds(vals, lo_q, hi_q):
    """A (lo, hi) pair at ~the given percentiles that cannot coincide with any data
    value: midpoints between adjacent unique values. Visium spots sit on a grid, so a
    raw percentile CAN land exactly on a coordinate and make point-in-polygon edge
    behavior ambiguous."""
    import numpy as np
    uniq = np.unique(vals)
    lo_i = max(1, int(len(uniq) * lo_q))
    hi_i = min(len(uniq) - 1, int(len(uniq) * hi_q))
    return (float((uniq[lo_i - 1] + uniq[lo_i]) / 2), float((uniq[hi_i - 1] + uniq[hi_i]) / 2))


# Xenium cell radius (microns): how far a cell's segmentation footprint can reach past
# its centroid, and so how much wider than the drawn ring a polygon_query crop may run.
CELL_RADIUS_UM = 10.0


def _subset_child(client, sid, payload, timeout=180):
    """POST a lasso subset and return the child Session once it lands. A completed subset
    closes the parent, taking `/jobs/{job_id}` with it, so the child (published as
    `session.created`) is the completion signal rather than the job status."""
    from app.deps import MANAGER
    r = client.post(f"/api/sessions/{sid}/subset", json=payload)
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        for sess in list(MANAGER.sessions.values()):
            if sess.parent_id == sid:
                return sess
        parent = MANAGER.get(sid)
        if parent is None:
            raise RuntimeError("subset closed the parent without producing a child")
        js = client.get(f"/api/sessions/{sid}/jobs/{job_id}").json()
        if js.get("status") in ("failed", "cancelled"):
            raise RuntimeError(f"subset {js['status']}: {parent.get_log(job_id)[0]}")
        time.sleep(0.5)
    raise TimeoutError("subset produced no child session")


def _write_visium_outs(path, dataset_id, origin, spacing, grid, fullres):
    """A minimal Space Ranger `outs` tree: a spot grid at `origin + k*spacing`
    full-resolution pixels, a counts .h5, and hires/lowres tissue images. Read back with
    the real `spatialdata_io.visium` reader it yields the multi-coordinate-system store
    every Visium dataset has — `<dataset_id>` plus `<dataset_id>_downscaled_hires` /
    `_downscaled_lowres`, and no 'global' — which none of the test-data stores carry."""
    import h5py
    import numpy as np
    from PIL import Image
    from scipy.sparse import csc_matrix

    hires_scalef, lowres_scalef = 0.2, 0.05
    os.makedirs(os.path.join(path, "spatial"), exist_ok=True)
    rows, cols = np.meshgrid(np.arange(grid), np.arange(grid), indexing="ij")
    rows, cols = rows.ravel(), cols.ravel()
    py, px = origin + rows * spacing, origin + cols * spacing
    barcodes = [f"BC{i:05d}-1" for i in range(px.size)]
    genes = [f"GENE{i:03d}" for i in range(24)]

    counts = csc_matrix(np.random.default_rng(0).poisson(2.0, (px.size, len(genes))).T.astype(np.int32))
    with h5py.File(os.path.join(path, f"{dataset_id}_filtered_feature_bc_matrix.h5"), "w") as f:
        f.attrs["library_ids"] = np.array([dataset_id.encode()])
        g = f.create_group("matrix")
        g.create_dataset("data", data=counts.data)
        g.create_dataset("indices", data=counts.indices.astype(np.int64))
        g.create_dataset("indptr", data=counts.indptr.astype(np.int64))
        g.create_dataset("shape", data=np.array(counts.shape, dtype=np.int32))
        g.create_dataset("barcodes", data=np.array([b.encode() for b in barcodes]))
        fg = g.create_group("features")
        for key, vals in (("id", genes), ("name", genes),
                          ("feature_type", ["Gene Expression"] * len(genes)),
                          ("genome", ["test"] * len(genes))):
            fg.create_dataset(key, data=np.array([v.encode() for v in vals]))

    with open(os.path.join(path, "spatial", "tissue_positions.csv"), "w") as f:
        f.write("barcode,in_tissue,array_row,array_col,pxl_row_in_fullres,pxl_col_in_fullres\n")
        for i, b in enumerate(barcodes):
            f.write(f"{b},1,{rows[i]},{cols[i]},{py[i]},{px[i]}\n")

    with open(os.path.join(path, "spatial", "scalefactors_json.json"), "w") as f:
        json.dump({"spot_diameter_fullres": float(spacing) / 2, "fiducial_diameter_fullres": 90.0,
                   "tissue_hires_scalef": hires_scalef, "tissue_lowres_scalef": lowres_scalef}, f)

    for name, scalef in (("tissue_hires_image.png", hires_scalef), ("tissue_lowres_image.png", lowres_scalef)):
        side = int(fullres * scalef)
        pixels = np.random.default_rng(1).integers(0, 255, (side, side, 3), dtype=np.uint8)
        Image.fromarray(pixels).save(os.path.join(path, "spatial", name))


def run_subset_coordinate_space_flow(client):
    """Both halves of the coordinate reconciliation on a multi-coordinate-system store:
    where the image lands, and where a lasso crops.

    A Visium store has three coordinate systems and no 'global', which nothing under
    test-data/ carries. Asking for `global` by name left `pixel_to_world` at identity, so
    the H&E drew at `tissue_hires_scalef` of its size in the corner of the spot cloud. For
    the subset, the rings arrive in world space (`obsm['spatial']`, what the canvas plots)
    while `polygon_query` resolves them against a coordinate system;
    `SpatialData.coordinate_systems` comes off a `set`, so indexing it picks a hash-random
    one, and a `_downscaled_*` pick resolves a full-resolution ring in a 5x/20x-downscaled
    space — keeping the wrong spots, or none. See `run_xenium_subset_space_flow` for the
    case where the two spaces differ in scale."""
    import numpy as np
    import spatialdata_io

    from app.deps import MANAGER
    from app import imaging

    dataset_id, origin, spacing, grid, fullres = "sdstest", 200, 130, 12, 2000
    staging = tempfile.mkdtemp(dir=str(config.DATA_DIR))  # sessions only read under DATA_DIR
    try:
        outs = os.path.join(staging, "outs")
        _write_visium_outs(outs, dataset_id, origin, spacing, grid, fullres)
        store = os.path.join(staging, f"{dataset_id}.zarr")
        spatialdata_io.visium(outs).write(store)

        sid = new_session(client, store)
        sess = MANAGER.get(sid)
        systems = sess.sdata.coordinate_systems
        assert dataset_id in systems and any(s.endswith("_downscaled_hires") for s in systems), systems

        cs, m = imaging.world_to_system(sess.sdata, sess.active_table())
        assert cs == dataset_id, f"query system {cs!r} is not the full-resolution one ({systems})"
        assert np.allclose(m, np.eye(3)), m

        # Each image is placed by the inverse of its own scalefactor, so both cover the
        # full-resolution frame the spots are in. _write_visium_outs writes square images.
        spots = np.asarray(sess.active_table().obsm["spatial"])[:, :2].astype(float)
        for element in sess.sdata.images:
            info = imaging.image_info(sess.sdata, element, sess.active_table())
            scale = fullres / info["width"]
            assert np.allclose(info["pixel_to_world"], [scale, 0, 0, 0, scale, 0]), \
                f"{element}: pixel_to_world {info['pixel_to_world']} != {scale}x scale"
            x0, y0, x1, y1 = info["bounds"]
            assert x0 <= spots[:, 0].min() and x1 >= spots[:, 0].max(), (element, info["bounds"])
            assert y0 <= spots[:, 1].min() and y1 >= spots[:, 1].max(), (element, info["bounds"])
        print(f"[ok] both Visium images placed over the spots from their scalefactors "
              f"({', '.join(sess.sdata.images)})")

        # A ring on the spot grid, edges halfway between rows/columns so no spot sits on
        # the boundary: the interior 5x5 spots, and nothing else. Read in the hires system
        # instead it would cover full-resolution 1325.. and keep 9 spots from the far corner.
        lo, hi = origin + spacing // 2, origin + 5 * spacing + spacing // 2
        ring = [[lo, lo], [hi, lo], [hi, hi], [lo, hi]]
        xy = np.asarray(sess.active_table().obsm["spatial"])[:, :2]
        expected = _strict_inside(xy, lo, hi, lo, hi)
        assert expected == 25, expected

        child = _subset_child(client, sid, {"polygons": [ring]})
        child_n = child.active_table().n_obs
        assert child_n == expected, f"kept {child_n} spots, drew {expected}"
        cxy = np.asarray(child.active_table().obsm["spatial"])[:, :2]
        assert cxy.min() >= lo and cxy.max() <= hi, (cxy.min(0), cxy.max(0))
        assert client.delete(f"/api/sessions/{child.id}").status_code == 200
        print(f"[ok] multi-system Visium ({len(systems)} systems, no 'global'): "
              f"subset resolved in {cs!r} kept the {child_n} drawn spots")
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def run_xenium_subset_space_flow(client):
    """The other half of the subset coordinate space (see `run_subset_coordinate_space_flow`):
    one system, but not the space the rings are in. Xenium spots are microns while 'global'
    is image pixels, so the ring has to be scaled by the store's own micron->pixel transform
    before `polygon_query` sees it — untransformed it crops a patch 4.7x too small in the
    wrong corner, which on this fixture holds no cells at all and fails the job outright."""
    import numpy as np

    from app.deps import MANAGER
    from app import imaging

    sid = new_session(client, XENIUM)
    sess = MANAGER.get(sid)
    cs, m = imaging.world_to_system(sess.sdata, sess.active_table())
    assert not np.allclose(m, np.eye(3)), f"xenium world space should not be {cs!r} as-is"

    xy = np.asarray(sess.active_table().obsm["spatial"])[:, :2]
    (x0, x1), (y0, y1) = (np.quantile(xy[:, i], [0.25, 0.75]) for i in (0, 1))
    ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    expected = _strict_inside(xy, x0, x1, y0, y1)
    # polygon_query keeps a cell whose *segmentation footprint* meets the ring, not just
    # its centroid, so the child runs a cell-radius wider than the centroid count.
    upper = _strict_inside(xy, x0 - CELL_RADIUS_UM, x1 + CELL_RADIUS_UM,
                           y0 - CELL_RADIUS_UM, y1 + CELL_RADIUS_UM)

    child = _subset_child(client, sid, {"polygons": [ring]})
    child_n = child.active_table().n_obs
    assert expected <= child_n <= upper, (expected, child_n, upper)
    cxy = np.asarray(child.active_table().obsm["spatial"])[:, :2]
    assert (cxy.min(0) >= [x0 - CELL_RADIUS_UM, y0 - CELL_RADIUS_UM]).all() and \
           (cxy.max(0) <= [x1 + CELL_RADIUS_UM, y1 + CELL_RADIUS_UM]).all(), (cxy.min(0), cxy.max(0))
    assert client.delete(f"/api/sessions/{child.id}").status_code == 200
    print(f"[ok] xenium (micron spots, pixel 'global'): subset kept {child_n} cells "
          f"of the {expected} drawn (footprint halo <= {upper})")


def run_mcp_flow(client):
    """The MCP assistant surface end to end over the real transport: initialize +
    tools/list, session creation via a reader, lock etiquette (take_control steals a
    viewer's lock), compute + plot + view_plot PNG, view_display's pixel<->world
    coordinate contract proven against annotate_region/inspect_region membership,
    display updates, data access, shape annotations, checkpoint save, figure export,
    and a subset that replaces the session."""
    import numpy as np
    from app.deps import MANAGER
    from app.mcp import agent as mcp_agent

    # transport smoke: initialize + tools/list on the mounted stateless endpoint
    r = client.post("/api/mcp", headers=_MCP_HEADERS, json={
        "jsonrpc": "2.0", "id": 9000, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "e2e", "version": "0"}}})
    assert r.status_code == 200, r.text
    init = r.json()["result"]
    assert init["serverInfo"]["name"] == "spatial-data-studio"
    assert "view_display" in init.get("instructions", "")
    r = client.post("/api/mcp", headers=_MCP_HEADERS, json={
        "jsonrpc": "2.0", "id": 9001, "method": "tools/list", "params": {}})
    tool_names = {t["name"] for t in r.json()["result"]["tools"]}
    for expected in ("read_guide", "create_session", "run_function", "view_display",
                     "annotate_region", "inspect_region", "subset_to_region", "view_plot"):
        assert expected in tool_names, f"missing tool {expected}"
    print(f"[ok] mcp transport: initialize + tools/list ({len(tool_names)} tools)")

    for topic in ("studio", "spatial-biology", "analysis-playbooks", "vision-and-selection"):
        _, content = mcp_call(client, "read_guide", {"topic": topic})
        assert content and len(content[0]["text"]) > 500, f"guide {topic} too thin"
    print("[ok] mcp guides readable")

    # discovery tools
    listing, _ = mcp_call(client, "search_functions", {"query": "spatial_neighbors"})
    assert any(f["key"] == "gr.spatial_neighbors" for f in listing["functions"])
    desc, _ = mcp_call(client, "describe_function", {"key": "gr.spatial_neighbors"})
    assert desc["json_schema"]["properties"] and desc["citation"] and desc["documentation"]
    readers, _ = mcp_call(client, "list_readers")
    assert any(e["key"] == "io.read_zarr" for e in readers["readers"])
    recs, _ = mcp_call(client, "list_recipes")
    assert recs["recipes"], "no recipes listed"
    print("[ok] mcp discovery: search_functions/describe_function/list_readers/list_recipes")

    # create a session through the reader path; it becomes the assistant's active session
    created, _ = mcp_call(client, "create_session", {
        "reader": {"namespace": "io", "function": "read_zarr", "params": {"store": DATA}},
        "name": "mcp-e2e"})
    assert created["status"] == "ready", created
    sid = created["id"]
    listing, _ = mcp_call(client, "list_sessions")
    assert listing["active_session_id"] == sid
    row = next(s for s in listing["sessions"] if s["id"] == sid)
    assert mcp_agent.AGENT_NAME in row["viewers"] and row["locked_by"] == mcp_agent.AGENT_NAME
    print(f"[ok] mcp create_session -> ready, active, lock held by {row['locked_by']}")

    st, _ = mcp_call(client, "get_session")
    assert any(f["name"] == "leiden" for f in st["fields"]["obs"])
    spatial_display = next(d for d in st["displays"] if d["type"] == "spatial_canvas")
    emb_display = next(d for d in st["displays"] if d["type"] == "embedding_canvas")

    # lock etiquette: hand the lock to a "browser viewer", watch a mutation refuse,
    # then take control back explicitly.
    mcp_call(client, "release_control")
    client.post("/api/presence", json={"client_id": "e2e-browser", "name": "test viewer",
                                       "session_id": sid})
    try:
        mcp_call(client, "run_function", {"namespace": "gr", "function": "spatial_neighbors",
                                          "params": {}, "session_id": sid})
        raise AssertionError("mutation succeeded while a viewer held the lock")
    except RuntimeError as e:
        assert "locked by test viewer" in str(e), str(e)
    taken, _ = mcp_call(client, "set_active_session", {"session_id": sid, "take_control": True})
    assert taken["ok"] and taken["locked_by"] == mcp_agent.AGENT_NAME
    print("[ok] mcp lock etiquette: 423 surfaced with hint, takeover works")

    # compute + plot through the assistant, then look at the plot
    done, _ = mcp_call(client, "run_function", {
        "namespace": "gr", "function": "spatial_neighbors",
        "params": {"coord_type": "generic", "n_neighs": 6}})
    assert done["status"] == "completed" and "obsp" in done["entry"]["structural_diff"]
    done, _ = mcp_call(client, "run_function", {
        "namespace": "gr", "function": "nhood_enrichment",
        "params": {"cluster_key": "leiden", "seed": 0, "show_progress_bar": False}})
    assert done["status"] == "completed"
    plotted, _ = mcp_call(client, "run_function", {
        "namespace": "pl", "function": "nhood_enrichment", "params": {"cluster_key": "leiden"}})
    assert plotted["status"] == "drawn", plotted
    plot_id = plotted["job_id"]
    plots, _ = mcp_call(client, "list_plots")
    row = next(p for p in plots["plots"] if p["id"] == plot_id)
    assert row["status"] == "drawn" and row["figure_available"], row
    _, content = mcp_call(client, "view_plot", {"plot_id": plot_id})
    img = mcp_png(content)
    assert img.size[0] > 100 and img.size[1] > 100
    print(f"[ok] mcp compute+plot: nhood_enrichment drawn, view_plot PNG {img.size}")

    jobs, _ = mcp_call(client, "list_jobs")
    assert any(h["function"] == "spatial_neighbors" for h in jobs["compute_history"])
    job, _ = mcp_call(client, "get_job", {"job_id": plot_id})
    assert job["entry"]["function"] == "nhood_enrichment" and isinstance(job["log"], str)
    print("[ok] mcp list_jobs/get_job (params + log)")

    # ---- the coordinate contract: pixels <-> world <-> membership ----------------
    _, content = mcp_call(client, "view_display", {"viewport": "fit"})
    img = mcp_png(content)
    meta = json.loads(next(c["text"] for c in content if c.get("type") == "text"))
    W, H = meta["image_px"]
    assert img.size == (W, H) == (1024, 768)
    assert meta["space"].startswith("world"), meta["space"]
    A, B, C, D, E, F = meta["pixel_to_world"]

    # world coords of the cells, exactly as the app defines them (spatial + affine)
    from app.sessions import transform as sd_transform
    sess_obj = MANAGER.get(sid)
    adata = sess_obj.active_table()
    xy = np.asarray(adata.obsm["spatial"])[:, :2].astype(float)
    xy = sd_transform.apply_affine6_xy(sd_transform.get_affine6(sess_obj.sdata, adata), xy)

    # every cell must fall inside the fit window
    ww = meta["world_window"]
    assert (xy[:, 0] > ww["x"][0]).all() and (xy[:, 0] < ww["x"][1]).all()
    assert (xy[:, 1] > ww["y"][0]).all() and (xy[:, 1] < ww["y"][1]).all()

    # a world rectangle whose bounds cannot tie with any data value
    x0, x1 = _untied_bounds(xy[:, 0], 0.35, 0.6)
    y0, y1 = _untied_bounds(xy[:, 1], 0.35, 0.6)
    ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    expected = _strict_inside(xy, x0, x1, y0, y1)
    assert expected > 50, f"degenerate test rectangle ({expected} cells)"

    stats, _ = mcp_call(client, "inspect_region", {"polygons": [ring]})
    assert stats["n_selected"] == expected, (stats["n_selected"], expected)
    assert stats["n_total"] == adata.n_obs

    # marked render round-trips the same world coordinates (exercises overlays)
    _, content = mcp_call(client, "view_display", {
        "viewport": "fit", "mark_polygons": [{"points": ring, "label": "sel"}],
        "mark_points": [{"x": (x0 + x1) / 2, "y": (y0 + y1) / 2, "label": "c"}]})
    mcp_png(content)

    annotated, _ = mcp_call(client, "annotate_region", {
        "region_set": "mcp_region", "category": "picked",
        "polygons": [ring], "color": "#ff00ff"})
    assert annotated["status"] == "completed"
    assert annotated["region_set_counts"]["picked"] == expected, annotated
    st, _ = mcp_call(client, "get_session")
    assert all(d["encoding"]["color_by"] == "obs:mcp_region" for d in st["displays"])
    print(f"[ok] mcp world-space selection: inspect == annotate == numpy ({expected} cells)")

    # pixel-space loop: pick a PIXEL rectangle, map through the returned affine,
    # and prove membership matches an independent count in world space.
    px0, px1, py0, py1 = 300, 640, 180, 520
    corners = np.array([[A * px + B * py + C, D * px + E * py + F]
                        for px, py in ((px0, py0), (px1, py0), (px1, py1), (px0, py1))])
    wx0, wx1 = corners[:, 0].min(), corners[:, 0].max()
    wy0, wy1 = corners[:, 1].min(), corners[:, 1].max()
    expected_px = _strict_inside(xy, wx0, wx1, wy0, wy1)
    stats, _ = mcp_call(client, "inspect_region", {"polygons": [corners.tolist()]})
    assert stats["n_selected"] == expected_px, (stats["n_selected"], expected_px)
    assert expected_px > 20, "pixel-rect landed off the tissue; check the affine"
    print(f"[ok] mcp pixel->world affine verified by membership ({expected_px} cells)")

    # embedding-space selection resolves against the display's obsm components
    emb_key = emb_display["encoding"]["obsm_key"]
    exi, eyi = emb_display["encoding"].get("x_component", 0), emb_display["encoding"].get("y_component", 1)
    emb = np.asarray(adata.obsm[emb_key])
    ex0, ex1 = _untied_bounds(emb[:, exi], 0.3, 0.7)
    ey0, ey1 = _untied_bounds(emb[:, eyi], 0.3, 0.7)
    e_ring = [[ex0, ey0], [ex1, ey0], [ex1, ey1], [ex0, ey1]]
    e_expected = _strict_inside(np.column_stack([emb[:, exi], emb[:, eyi]]), ex0, ex1, ey0, ey1)
    stats, _ = mcp_call(client, "inspect_region", {
        "polygons": [e_ring], "space": "embedding", "display_id": emb_display["id"]})
    assert stats["n_selected"] == e_expected, (stats["n_selected"], e_expected)
    _, content = mcp_call(client, "view_display", {"display_id": emb_display["id"],
                                                   "viewport": "fit"})
    e_meta = json.loads(next(c["text"] for c in content if c.get("type") == "text"))
    assert e_meta["space"].startswith(f"embedding obsm:{emb_key}")
    print(f"[ok] mcp embedding-space selection ({e_expected} cells in {emb_key})")

    # display updates + data access
    upd, _ = mcp_call(client, "update_display", {"encoding": {"color_by": "X:Sox17",
                                                              "point_size": 6}})
    assert upd["display"]["encoding"]["color_by"] == "X:Sox17"
    genes, _ = mcp_call(client, "search_genes", {"query": "Sox1"})
    assert any(n == "Sox17" for n in genes["names"])
    summary, _ = mcp_call(client, "get_obs_summary", {"column": "leiden"})
    assert summary["kind"] == "categorical" and \
        sum(v["count"] for v in summary["values"]) == adata.n_obs
    page, _ = mcp_call(client, "get_table", {"path": "obs", "limit": 5})
    assert page["rows"] and any(c["name"] == "mcp_region" for c in page["columns"])
    ds, _ = mcp_call(client, "list_datasets")
    assert isinstance(ds["datasets"], list)
    tree, _ = mcp_call(client, "browse_data_dir")
    assert tree["entries"], tree
    print("[ok] mcp display update + data access tools")

    # shape annotations round trip (missing stroke fields filled by the tool)
    added, _ = mcp_call(client, "add_shape_annotation", {"shape": {
        "label": "look here",
        "geometry": {"kind": "line", "vertices": [[x0, y0], [x1, y1]]},
        "stroke": {"color": "#ffcc00", "width": 2, "arrowEnd": True}}})
    assert added["status"] == "completed", added
    shapes, _ = mcp_call(client, "list_shape_annotations")
    assert len(shapes["shapes"]) == 1
    deleted, _ = mcp_call(client, "delete_shape_annotation",
                          {"shape_id": shapes["shapes"][0]["id"]})
    assert deleted["status"] == "completed"
    print("[ok] mcp shape annotations add/list/delete")

    # persistence: checkpoint + gallery figure
    saved, _ = mcp_call(client, "save_checkpoint")
    assert saved["status"] == "completed" and os.path.exists(saved["path"]), saved
    fig, _ = mcp_call(client, "export_figure", {"formats": ["png"], "label": "mcp-e2e"})
    assert fig["status"] == "completed" and fig["name"].endswith(".figure.json")
    print(f"[ok] mcp save_checkpoint ({os.path.basename(saved['path'])}) + export_figure")

    # subset replaces the session with a child holding the selection. Unlike the
    # centroid-based annotate/inspect membership, subset goes through
    # sd.polygon_query, which keeps a cell whose *geometry* (e.g. the Visium spot
    # circle) intersects the polygon — so the child may hold slightly more cells
    # than the centroid count, bounded by centroids within a spot-diameter pad.
    pad = 0.0
    for gdf in getattr(sess_obj.sdata, "shapes", {}).values():
        if "radius" in gdf.columns:
            pad = max(pad, 2.0 * float(gdf["radius"].max()))
    upper = _strict_inside(xy, x0 - pad, x1 + pad, y0 - pad, y1 + pad)
    sub, _ = mcp_call(client, "subset_to_region", {"polygons": [ring]})
    assert sub["status"] == "completed" and sub["child_session"], sub
    child_id = sub["child_session"]["id"]
    assert sub["child_session"]["parent_id"] == sid
    assert MANAGER.get(sid) is None, "subset should close the parent"
    child_n = MANAGER.get(child_id).active_table().n_obs
    assert expected <= child_n <= upper, (expected, child_n, upper)
    listing, _ = mcp_call(client, "list_sessions")
    assert listing["active_session_id"] == child_id
    closed, _ = mcp_call(client, "close_session", {"session_id": child_id})
    assert closed["ok"] and MANAGER.get(child_id) is None
    mcp_call(client, "release_control")
    print(f"[ok] mcp subset -> child with {child_n} cells, parent evicted, child closed")


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
        assert thumb.status_code == 200 and thumb.content, f"thumbnail fetch failed: {thumb.status_code}"
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

        # the polled session-state response must NOT inline job logs — a verbose compute
        # leaves tens of MB of log per record and this endpoint is refetched constantly.
        # The log stays reachable via the per-job endpoint (get_log reads it from app_state).
        assert all("_log" not in r for r in
                   st["app_state"]["compute_history"] + st["app_state"]["plots"]), \
            "session-state response inlined _log"
        nb = next(r for r in st["app_state"]["compute_history"] if r["function"] == "spatial_neighbors")
        lg_live = client.get(f"/api/sessions/{sid}/jobs/{nb['id']}/log")
        assert lg_live.status_code == 200 and isinstance(lg_live.json().get("log"), str), lg_live.text
        print("[ok] live session-state omits inline _log; per-job log endpoint still serves it")

        # save (must land under DATA_DIR — the save endpoint validates the target path)
        out = os.path.join(str(config.DATA_DIR), "session.zarr.zip")
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

        # reload into a NEW session, verify app_state preserved. The load runs on the
        # worker, so wait for the session to become ready before reading app_state.
        r2 = client.post("/api/sessions", json={"source": {"kind": "load", "path": out}})
        assert r2.status_code == 200, r2.text
        sid2 = r2.json()["id"]
        st2 = poll(client, sid2, lambda s: s["summary"]["status"] in ("ready", "errored"))
        assert st2["summary"]["status"] == "ready", "reloaded session errored"
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

        # --- checkpoint format: sharded rasters with per-channel inner chunks,
        # consolidated metadata, the `viewer/` sidecar, logs relocated. All of this
        # exists so the serverless viewer can read the checkpoint over HTTP Range
        # without this backend (DESIGN §14). ---
        import json as _json
        import zipfile as _zip
        name = os.path.basename(out)
        with _zip.ZipFile(out) as zf:
            root = _json.loads(zf.read("zarr.json"))
            consolidated = root.get("consolidated_metadata", {}).get("metadata", {})
            assert consolidated, "checkpoint root has no consolidated metadata"

            raster_entry = next(n for n in sorted(zf.namelist())
                                if n.startswith("images/") and n.endswith("zarr.json")
                                and _json.loads(zf.read(n)).get("node_type") == "array")
            raster_meta = _json.loads(zf.read(raster_entry))
            codecs = [c.get("name") for c in raster_meta.get("codecs", [])]
            assert "sharding_indexed" in codecs, f"{raster_entry} not sharded: {codecs}"
            # The sharding codec's own chunk_shape is the inner chunk; the array's
            # chunk_grid reports the shard. Viv fetches one channel at a time, so the
            # inner chunk must stay a single-channel tile.
            inner = next(c for c in raster_meta["codecs"]
                         if c["name"] == "sharding_indexed")["configuration"]["chunk_shape"]
            assert inner[-1] <= 512 and inner[-2] <= 512, \
                f"{raster_entry} inner chunk not tile-sized: {inner}"
            assert len(inner) < 3 or inner[0] == 1, \
                f"{raster_entry} inner chunk spans channels: {inner}"
            # The consolidated tree must report the sharded layout, or a browser
            # reading it would decode the pre-shard byte layout.
            assert "sharding_indexed" in [
                c.get("name") for c in
                consolidated[raster_entry[: -len("/zarr.json")]]["codecs"]
            ], "consolidated metadata does not report sharding"

            sidecar = consolidated["viewer"]["attributes"]
            assert sidecar["sidecar_version"] >= 1, sidecar
            hne = sidecar["images"]["hne"]
            assert set(hne) == {""} | set(sidecar["table_keys"]), \
                f"image manifest not baked per table: {list(hne)}"
            baked = hne[sidecar["table_keys"][0]]
            for field in ("pixel_to_world", "levels", "contrast_limits", "contrast_range",
                          "is_rgb", "channel_names"):
                assert field in baked, f"sidecar image manifest missing {field}"

            live_affine = client.get(f"/api/sessions/{sid}/points-transform").json()["affine"]
            assert sidecar["coords_transform"]["adata"] == live_affine, \
                f"sidecar coords_transform != live points-transform: {sidecar['coords_transform']}"

            csc = "viewer/tables/adata/X_csc"
            assert f"{csc}/data" in consolidated and f"{csc}/indices" in consolidated \
                and f"{csc}/indptr" in consolidated, "CSC mirror missing from sidecar"

            # app_state present but with no inline worker logs (relocated to logs/)
            saved_state = root["attributes"]["app_state"]
            assert all("_log" not in r for r in
                       saved_state["compute_history"] + saved_state["plots"]), "logs not relocated"
            logfiles = [n for n in zf.namelist() if n.startswith("logs/")]
        print(f"[ok] browser-readable checkpoint: {raster_entry} sharded inner={inner}; "
              f"{len(consolidated)} consolidated nodes; sidecar v{sidecar['sidecar_version']}; "
              f"logs relocated={len(logfiles)}")

        # The sidecar's baked manifest must agree with what the live route computes —
        # it is the same imaging.image_info call, and the viewer relies on that.
        live_info = client.get(f"/api/sessions/{sid}/image/hne/info").json()
        for field in ("pixel_to_world", "bounds", "is_rgb", "contrast_limits",
                      "contrast_range", "channel_names", "width", "height"):
            assert baked[field] == live_info[field], \
                f"sidecar {field} disagrees with live image_info: {baked[field]} != {live_info[field]}"
        print("[ok] sidecar image manifest matches live image_info")

        # The CSC mirror must densify to exactly what /data/X:<gene> serves from CSR.
        run_csc_mirror_check(client, sid, out)

        # Regression check: reopening a saved checkpoint must still advertise the
        # intended GPU-compositing path, not silently fall back to server-composited
        # tiles (rasters._is_canonical used to detect this reload as "already
        # tile-chunked, nothing to rebuild" and leave it with no raster_stores entry
        # at all, so client_compositing stayed permanently false for every reopened
        # session — see rasters.py).
        info2 = client.get(f"/api/sessions/{sid2}/image/hne/info").json()
        assert info2["client_compositing"] is True, \
            f"reopened checkpoint lost client_compositing: {info2}"
        print("[ok] reopened checkpoint still advertises client_compositing")

        # /api/checkpoints serves it with HTTP Range (206) (the checkpoint picker and
        # any other range-based consumer, e.g. resuming a large download)
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
        run_staging_flow(client)
        run_recipe_params_flow(client)
        run_regions_flow(client)
        run_shape_annotations_flow(client)
        run_transform_flow(client)
        run_incremental_save_flow(client, out)
        run_selective_save_flow(client, out)
        run_content_hash_flow(client)
        run_save_destination_flow(client)
        run_invalidation_flow(client)
        run_encoding_persistence_flow(client)
        run_encoding_defaults_parity()
        run_inspector_flow(client)
        run_session_lock_flow(client)
        run_cirro_auth_flow(client)
        run_isolation_flow(client)
        run_filter_reshape_flow(client)
        run_filter_rank_genes_save_flow(client)
        run_raster_locality_flow(client)
        run_mcp_flow(client)
        if have_fixture(XENIUM_TMA, "zarr-import flow"):
            run_zarr_import_flow(client)
        run_subset_coordinate_space_flow(client)
        if have_fixture(XENIUM, "subset coordinate-space flow"):
            run_xenium_subset_space_flow(client)
        if have_fixture(XENIUM, "segmentation flow"):
            run_segmentation_flow(client)
        if have_fixture(XENIUM, "raster flow"):
            run_raster_flow(client)
        if have_fixture(XENIUM, "raster-survives-reshape flow"):
            run_raster_survives_reshape_flow(client)

        if have_fixture(XENIUM_TMA, "custom-methods flow"):
            run_custom_methods_flow(client)

        print("\nALL BACKEND E2E CHECKS PASSED")


def _run_with_cleanup():
    """Run main(), then remove whatever the run wrote into the shared DATA_DIR
    (checkpoints, snapshots, leftover `.rasters`/`.save-` caches) so the input
    datasets stay pristine and a re-run starts clean."""
    data_dir = str(config.DATA_DIR)
    pre = set(os.listdir(data_dir)) if os.path.isdir(data_dir) else set()
    try:
        return main()
    finally:
        for entry in set(os.listdir(data_dir)) - pre:
            p = os.path.join(data_dir, entry)
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p, ignore_errors=True)
            else:
                try:
                    os.remove(p)
                except OSError:
                    pass


if __name__ == "__main__":
    sys.exit(_run_with_cleanup())
