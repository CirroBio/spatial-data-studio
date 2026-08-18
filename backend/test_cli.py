"""End-to-end test for the offline CLI (backend/cli.py). Drives cli.main in-process
(the registry build + squidpy compute is the same work test_e2e.py does) against the
real visium_hne dataset in zarr-load mode, then asserts the output SpatialData, its
display settings and the plot files are produced and reload cleanly. A second pass over
the Xenium fixture covers the display an embedding-producing recipe leaves behind.

Run from backend/:  python test_cli.py
Needs test-data/visium_hne.zarr (scripts/prepare_test_data.py writes it, ~375 MB).
"""
import contextlib
import io
import json
import os
import sys
import tempfile

os.environ.setdefault("SDS_CONTAINER_MEM_MB", "65536")
os.environ.setdefault("SDS_MAX_SESSIONS", "64")

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA = os.path.join(_REPO_ROOT, "test-data", "visium_hne.zarr")

# The three steps below are the exact compute + plot chain test_e2e.py proves runs
# clean on visium_hne (log-normalised X, obs["leiden"], obsm["spatial"]).
RECIPE = {
    "schema_version": 1,
    "meta": {"name": "cli-smoke", "description": "spatial neighbors -> nhood enrichment (+plot)"},
    "steps": [
        {"namespace": "gr", "function": "spatial_neighbors",
         "params": {"coord_type": "generic", "n_neighs": 6}},
        {"namespace": "gr", "function": "nhood_enrichment",
         "params": {"cluster_key": "leiden", "seed": 0, "show_progress_bar": False}},
        {"namespace": "pl", "function": "nhood_enrichment", "params": {"cluster_key": "leiden"}},
    ],
}

# The Xenium fixture's obsm holds only `spatial`, so its session is built with no
# embedding to display — the state every reader-mode run starts in. The embedding
# canvas can therefore only come from the pass the CLI makes once the recipe below has
# computed one, and a serverless viewer (read-only) cannot add it afterwards.
XENIUM = os.path.join(_REPO_ROOT, "test-data", "xenium.zarr")
EMBEDDING_RECIPE = {
    "schema_version": 1,
    "meta": {"name": "cli-embedding", "description": "normalize -> PCA -> neighbors -> UMAP"},
    "steps": [
        {"namespace": "sc.pp", "function": "normalize_total", "params": {}},
        {"namespace": "sc.pp", "function": "log1p", "params": {}},
        {"namespace": "sc.pp", "function": "pca", "params": {}},
        {"namespace": "sc.pp", "function": "neighbors", "params": {}},
        {"namespace": "sc.tl", "function": "umap", "params": {}},
    ],
}


def check_embedding_display(cli) -> int:
    """Skips with a [skip] line when the Xenium fixture is absent (as test_e2e.py's
    Xenium-backed flows do), so CI runs the visium_hne half alone."""
    if not os.path.isdir(XENIUM):
        print(f"[skip] {XENIUM} absent; post-recipe embedding display not checked")
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        recipe_path = os.path.join(tmp, "embedding.json")
        with open(recipe_path, "w") as f:
            json.dump(EMBEDDING_RECIPE, f)
        out_dir = os.path.join(tmp, "out")
        rc = cli.main(["--parser", "zarr", "--input", XENIUM, "--name", "xen_result",
                       "--recipe", recipe_path, "--output", out_dir])
        assert rc == 0, f"cli returned {rc}"

        from app.persistence.store import load_spatialdata
        _sdata, app_state, _newer, _extract, _hash = load_spatialdata(
            os.path.join(out_dir, "xen_result.zarr.zip"))
        types = [d["type"] for d in app_state["displays"]]
        assert types.count("spatial_canvas") == 1, types   # not duplicated by the second pass
        assert types.count("embedding_canvas") == 1, types
        emb = next(d for d in app_state["displays"] if d["type"] == "embedding_canvas")
        assert emb["encoding"]["obsm_key"] == "X_umap", emb["encoding"]
        print("[ok] embedding canvas added after the recipe computed it (obsm_key=X_umap)")
    return 0


def main() -> int:
    assert os.path.isdir(DATA), f"missing {DATA}; run scripts/prepare_test_data.py first"
    import cli

    # --list-parsers reports the spatialdata-io readers and the zarr sentinel.
    with tempfile.TemporaryDirectory() as tmp:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            cli.main(["--list-parsers", "--parser", "zarr", "--input", DATA,
                      "--recipe", "unused", "--output", tmp])
        listed = buf.getvalue().split()
        assert "zarr" in listed and any(k.startswith("io.") for k in listed), listed
        assert "io.xenium" in listed, listed
        print(f"[ok] --list-parsers: {len(listed)} parsers incl. io.xenium + zarr")

    with tempfile.TemporaryDirectory() as tmp:
        recipe_path = os.path.join(tmp, "recipe.json")
        with open(recipe_path, "w") as f:
            json.dump(RECIPE, f)
        out_dir = os.path.join(tmp, "out")

        rc = cli.main(["--parser", "zarr", "--input", DATA, "--name", "cli_result",
                       "--recipe", recipe_path, "--output", out_dir,
                       "--display-color-by", "obs:leiden",
                       "--display-render-mode", "points+shapes"])
        assert rc == 0, f"cli returned {rc}"

        out_zip = os.path.join(out_dir, "cli_result.zarr.zip")
        assert os.path.exists(out_zip) and os.path.getsize(out_zip) > 10_000, \
            f"output zip missing/too small: {out_zip}"
        print(f"[ok] wrote {out_zip} ({os.path.getsize(out_zip)/1e6:.1f} MB)")

        plot_dir = os.path.join(out_dir, "plots", "03_pl.nhood_enrichment")
        svg = os.path.join(plot_dir, "figure.svg")
        pdf = os.path.join(plot_dir, "figure.pdf")
        assert os.path.exists(svg) and os.path.exists(pdf), f"missing plot files in {plot_dir}"
        with open(svg, "rb") as f:
            head = f.read(5)
        assert head in (b"<?xml", b"<svg "), head
        print(f"[ok] plot written: {plot_dir}/figure.{{svg,pdf}}")

        # the saved store reloads with the recipe's compute history + plot record
        from app.persistence.store import load_spatialdata
        sdata, app_state, _newer, _extract, _hash = load_spatialdata(out_zip)
        fns = [c["function"] for c in app_state["compute_history"]]
        assert fns == ["spatial_neighbors", "nhood_enrichment"], fns
        assert any(p["function"] == "nhood_enrichment" for p in app_state["plots"]), app_state["plots"]
        # the computed graph survived the round trip
        assert "spatial_distances" in sdata.tables[next(iter(sdata.tables))].obsp, "obsp not persisted"
        print(f"[ok] reloaded: compute_history={fns}, plot record + obsp survived")

        # the display flags reached every saved display; render mode is spatial-only
        displays = app_state["displays"]
        assert displays and all(d["encoding"]["color_by"] == "obs:leiden" for d in displays), \
            [d["encoding"]["color_by"] for d in displays]
        modes = {d["type"]: d["encoding"].get("render_mode") for d in displays}
        assert modes["spatial_canvas"] == "points+shapes", modes
        assert modes.get("embedding_canvas") is None, modes
        # the embedding canvas opens on the UMAP, not the X_pca it was built from
        emb = next(d for d in displays if d["type"] == "embedding_canvas")
        assert emb["encoding"]["obsm_key"] == "X_umap", emb["encoding"]["obsm_key"]
        print(f"[ok] display settings persisted: color_by=obs:leiden, {modes}, "
              f"embedding on {emb['encoding']['obsm_key']}")

    check_embedding_display(cli)

    print("\nCLI E2E CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
