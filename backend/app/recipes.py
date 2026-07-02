"""Curated analysis recipes — ordered squidpy step sequences that tell a complete
analysis story. Exposed to the AI agent (list_recipes/apply_recipe tools) and to
the UI (GET /api/recipes → run via /recipe/run). The app also supports ad-hoc
recipe export/import over the current history (see main.py /recipe endpoints).

Two families ship:
  * squidpy spatial recipes for the `visium_hne` example (a Visium H&E mouse-brain
    section): hexagonal grid (coord_type="grid", n_neighs=6), a named brain-region
    annotation in obs["cluster"], spatial coords in obsm["spatial"], already
    log-normalised X. Steps that read the spatial graph (nhood_enrichment,
    centrality_scores, interaction_matrix, spatial_autocorr) are preceded by
    spatial_neighbors (writes obsp["spatial_connectivities"]); co_occurrence and
    ripley build their own neighbourhoods.
  * scanpy recipes for unprocessed (raw-count) data such as Xenium: normalize →
    log1p → HVG → PCA → neighbours → Leiden (→ UMAP / markers / spatial), keyed on
    the obs["leiden"] they produce.

App constraints honoured: spatial_autocorr omits n_perms (the permutation path uses
joblib's process pool, which can't spawn on the worker thread); no spatial_scatter/
spatial_segment plots (the table lacks uns["spatial"]); every spatial-graph step is
preceded by spatial_neighbors in the same recipe.
"""
from __future__ import annotations

CLUSTER_KEY = "cluster"   # visium_hne's named brain-region annotation
LEIDEN_KEY = "leiden"     # produced by the scanpy preprocessing recipes below
_VISIUM_GRID = {"coord_type": "grid", "n_neighs": 6}


def _step(namespace: str, function: str, **params) -> dict:
    return {"namespace": namespace, "function": function, "params": params}


def _preprocess_to_leiden() -> list[dict]:
    """Scanpy path from raw counts to Leiden clusters, shared by the raw-data recipes.
    Returns fresh dicts each call so recipes never alias step objects. Scanpy lives
    under the `sc.pp`/`sc.tl` namespaces in the registry. No explicit HVG step: PCA
    uses an existing highly_variable flag if present (Visium) and all genes otherwise
    (targeted panels like Xenium have too few genes for a fixed n_top_genes). leiden
    uses the igraph flavor (scanpy's recommended, future-proof default)."""
    return [
        _step("sc.pp", "normalize_total"),
        _step("sc.pp", "log1p"),
        _step("sc.pp", "pca"),
        _step("sc.pp", "neighbors"),
        _step("sc.tl", "leiden", flavor="igraph", n_iterations=2),
    ]


_BUNDLED: dict[str, dict] = {
    "Neighborhood enrichment": {
        "description": "Which brain regions border each other more (or less) than chance, "
                       "from a permutation test over the spatial graph.",
        "steps": [
            _step("gr", "spatial_neighbors", **_VISIUM_GRID),
            _step("gr", "nhood_enrichment", cluster_key=CLUSTER_KEY, seed=0, show_progress_bar=False),
            _step("pl", "nhood_enrichment", cluster_key=CLUSTER_KEY),
        ],
    },
    "Spatially variable genes (Moran's I)": {
        "description": "Rank genes by spatial autocorrelation (Moran's I) over the spatial graph; "
                       "the ranking lands in uns['moranI'] (top genes can then color the canvas).",
        "steps": [
            _step("gr", "spatial_neighbors", **_VISIUM_GRID),
            # No n_perms: Moran's I is scored analytically. The permutation path uses
            # joblib's process pool, which can't spawn inside the worker thread.
            _step("gr", "spatial_autocorr", mode="moran"),
        ],
    },
    "Cluster co-occurrence": {
        "description": "How the chance of finding one region near another changes with distance "
                       "(computed directly on the spot coordinates).",
        "steps": [
            _step("gr", "co_occurrence", cluster_key=CLUSTER_KEY),
            _step("pl", "co_occurrence", cluster_key=CLUSTER_KEY, clusters="Hippocampus"),
        ],
    },
    "Region graph topology": {
        "description": "Each region's connectivity role (centrality scores) and the matrix of "
                       "inter-region edges over the spatial graph.",
        "steps": [
            _step("gr", "spatial_neighbors", **_VISIUM_GRID),
            _step("gr", "centrality_scores", cluster_key=CLUSTER_KEY),
            _step("pl", "centrality_scores", cluster_key=CLUSTER_KEY),
            _step("gr", "interaction_matrix", cluster_key=CLUSTER_KEY, normalized=True),
            _step("pl", "interaction_matrix", cluster_key=CLUSTER_KEY),
        ],
    },
    "Spatial point patterns (Ripley's L)": {
        "description": "Test whether each region's spots are clustered or dispersed across space "
                       "with Ripley's L statistic.",
        "steps": [
            _step("gr", "ripley", cluster_key=CLUSTER_KEY, mode="L"),
            _step("pl", "ripley", cluster_key=CLUSTER_KEY, mode="L"),
        ],
    },

    # --- scanpy-based recipes for unprocessed (raw-count) data, e.g. Xenium ---
    "Preprocess & cluster (raw counts)": {
        "description": "Turn raw counts into Leiden clusters with a UMAP embedding "
                       "(normalize → log1p → HVG → PCA → neighbors → Leiden → UMAP). "
                       "For unprocessed data such as Xenium — not for already-normalized sessions.",
        "steps": [
            *_preprocess_to_leiden(),
            _step("sc.tl", "umap"),
        ],
    },
    "QC, filter & cluster (raw counts)": {
        "description": "Compute QC metrics, drop low-quality cells and rare genes, then normalize "
                       "and cluster. For unprocessed data.",
        "steps": [
            _step("sc.pp", "calculate_qc_metrics", inplace=True, percent_top=[50, 100, 200]),
            _step("sc.pp", "filter_cells", min_genes=10),
            _step("sc.pp", "filter_genes", min_cells=3),
            *_preprocess_to_leiden(),
        ],
    },
    "Marker genes per cluster": {
        "description": "Rank differentially expressed marker genes per Leiden cluster (Wilcoxon), "
                       "then keep the significant ones (uns['rank_genes_groups'] + "
                       "uns['rank_genes_groups_filtered']). Needs an obs['leiden'] column "
                       "(present on visium_hne, or run a preprocessing recipe first).",
        "steps": [
            _step("sc.tl", "rank_genes_groups", groupby=LEIDEN_KEY, method="wilcoxon"),
            _step("sc.tl", "filter_rank_genes_groups"),
        ],
    },
    "Cluster & neighborhood enrichment (raw → spatial)": {
        "description": "End-to-end on unprocessed spatial data (e.g. Xenium): cluster the cells, "
                       "build the spatial graph, then test which clusters are spatially co-enriched.",
        "steps": [
            *_preprocess_to_leiden(),
            _step("gr", "spatial_neighbors", coord_type="generic", n_neighs=6),
            _step("gr", "nhood_enrichment", cluster_key=LEIDEN_KEY, seed=0, show_progress_bar=False),
            _step("pl", "nhood_enrichment", cluster_key=LEIDEN_KEY),
        ],
    },
}


def list_recipes() -> list[dict]:
    return [{"name": n, "description": r.get("description", "")} for n, r in _BUNDLED.items()]


def catalog() -> list[dict]:
    """Full recipes (including steps) — for the UI's recipe gallery."""
    return [{"name": n, "description": r.get("description", ""), "steps": r["steps"]}
            for n, r in _BUNDLED.items()]


def apply_recipe(session, name: str, mode: str = "run") -> dict:
    recipe = _BUNDLED.get(name)
    if recipe is None:
        return {"status": "failed", "error": f"no recipe named '{name}'"}
    n = 0
    for step in recipe.get("steps", []):
        session.stage_descriptor(step) if mode == "stage" else session.enqueue_descriptor(step)
        n += 1
    return {"status": "completed", "staged" if mode == "stage" else "queued": n}
