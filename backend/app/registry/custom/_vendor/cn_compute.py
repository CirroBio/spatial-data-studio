"""
cn_compute.py
=============

COMPUTATION half of a cellular-neighborhood (CN) / spatial-niche analysis for
spatial omics. All plotting lives in the companion module ``cn_plot.py``; this
file returns numbers and tables only and imports no plotting libraries.

------------------------------------------------------------------------------
BIOLOGICAL CONTEXT
------------------------------------------------------------------------------
A tissue is not a bag of cells. The same cell type behaves differently depending
on what surrounds it: a CD8 T cell buried in a tumor nest is doing something
different from a CD8 T cell in a tertiary lymphoid structure. "Cellular
neighborhood" analysis captures that context. It partitions the tissue into
recurring *multicellular* motifs — regions with a characteristic *mixture* of
cell types (e.g. "tumor + macrophage boundary", "B/T follicle", "stroma") — that
recur across a slide and across patients. These niches, not individual cells, are
often what correlate with outcome. The approach was introduced for CODEX imaging
by Schürch, Bhate et al. (Cell, 2020), who found nine conserved neighborhoods in
the colorectal-cancer immune microenvironment, and it is now standard for imaging
(CODEX, IMC, MERSCOPE, Xenium) and sequencing-based spatial data alike
(imcRtools, squidpy-based niche workflows, CellCharter).

------------------------------------------------------------------------------
COMPUTATIONAL APPROACH
------------------------------------------------------------------------------
Four steps, each a function below:

  1. build_spatial_neighbors  — define a spatial "window" per cell (its W nearest
     neighbors, self included), encoded as a sparse membership matrix.
  2. neighborhood_composition — turn each window into a vector of cell-type
     PROPORTIONS via one sparse matrix product (counts) + row normalization.
  3. cluster_neighborhoods    — Leiden community detection over those composition
     vectors; each community is one cellular neighborhood.
  4. characterize_neighborhoods — summarize each CN as mean composition and as
     log2 enrichment over the tissue-wide cell-type frequencies.

The core operates on plain arrays, depending on numpy / scipy / scikit-learn plus
the app's shared Leiden partitioner (``custom/_leiden.py``, graspologic-native).
``cellular_neighborhoods_adata`` is a thin AnnData wrapper.

NOTE: this is distinct from ``squidpy.gr.nhood_enrichment``, which is a
permutation test for *pairwise* cell-type co-localization. CN analysis instead
assigns every cell to a multicellular niche by clustering composition vectors.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence, Union

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix, spmatrix
from sklearn.neighbors import NearestNeighbors, kneighbors_graph

# Convenience alias: anything that can be coerced to a 1-D/2-D numpy array.
ArrayLike = Union[np.ndarray, Sequence]


# --------------------------------------------------------------------------- #
# Result container
# --------------------------------------------------------------------------- #
@dataclass
class CNResult:
    """Bundle of everything a CN computation produces, for handoff to cn_plot.

    BIOLOGICAL CONTEXT
        Each field answers a different question about the tissue's niche
        structure: which niche each cell belongs to (`labels`), what each niche
        is made of (`mean_composition`), and which cell types define / avoid each
        niche relative to the whole tissue (`enrichment`).

    COMPUTATIONAL APPROACH
        A plain data holder (dataclass). No computation happens here; the fields
        are populated by `cellular_neighborhoods`.

    Fields
    ------
    labels            (n_cells,) int   CN id assigned to each cell.
    composition       (n_cells, n_types) float   per-cell window composition.
    celltype_order    list             column order shared by all matrices/tables.
    enrichment        DataFrame        log2(CN proportion / global frequency).
    mean_composition  DataFrame        mean cell-type proportion within each CN.
    """

    labels: np.ndarray                     # (n_cells,) integer neighborhood id per cell
    composition: np.ndarray               # (n_cells, n_types) proportion matrix
    celltype_order: list                  # ordered cell-type names = matrix columns
    enrichment: pd.DataFrame              # (n_cn x n_types) log2 fold-enrichment
    mean_composition: pd.DataFrame       # (n_cn x n_types) mean proportion per CN

    @property
    def n_neighborhoods(self) -> int:
        """Number of neighborhoods Leiden found = number of summary-table rows."""
        return self.mean_composition.shape[0]   # one row per CN


# --------------------------------------------------------------------------- #
# Step 1 — spatial window graph
# --------------------------------------------------------------------------- #
def build_spatial_neighbors(
    coords: np.ndarray,
    *,
    method: str = "knn",
    n_neighs: int = 20,
    radius: Optional[float] = None,
    include_self: bool = True,
    batch: Optional[np.ndarray] = None,
) -> csr_matrix:
    """Define each cell's spatial window as a sparse membership matrix ``A``.

    BIOLOGICAL CONTEXT
        A "window" is the patch of tissue immediately around a cell — the cells it
        could plausibly be signaling to or touching. The window size sets the
        physical scale of the niches you will find: a small window (few neighbors)
        finds fine motifs like a single vessel wall; a large window finds broad
        compartments like "tumor bulk" vs "stroma". Windows must never cross
        physical samples (different slides / cores), hence `batch`.

    COMPUTATIONAL APPROACH
        Build a k-nearest-neighbor (or fixed-radius) graph on the (x, y[, z])
        coordinates with scikit-learn, then store it as a binary sparse matrix
        where row i lists the members of cell i's window. Doing this per-batch and
        remapping indices keeps windows within-sample.

    Parameters
    ----------
    coords        (n_cells, 2 or 3) spatial coordinates (e.g. adata.obsm['spatial']).
    method        "knn" (fixed neighbor count, Schürch default) or "radius".
    n_neighs      window size W for method="knn".
    radius        neighborhood radius for method="radius" (coordinate units).
    include_self  keep the index cell in its own window (recommended).
    batch         (n_cells,) sample ids; windows are built within each id only.

    Returns
    -------
    csr_matrix    (n_cells, n_cells) binary window-membership matrix A.
    """
    coords = np.asarray(coords, dtype=float)   # (n_cells, dim) numeric coordinates
    n = coords.shape[0]                        # n = total number of cells

    # ---- per-sample dispatch: build each sample's graph, then stitch together ----
    if batch is not None:
        batch = np.asarray(batch)              # (n_cells,) sample/slide label per cell
        blocks = []                            # list of per-sample sparse graphs (global indexing)
        for b in pd.unique(batch):             # b = one sample id
            mask = np.where(batch == b)[0]     # mask = global row indices of cells in sample b
            sub = build_spatial_neighbors(     # sub = graph for just this sample (local indices)
                coords[mask],
                method=method,
                n_neighs=n_neighs,
                radius=radius,
                include_self=include_self,
                batch=None,
            ).tocoo()                          # COO form exposes .row/.col for remapping
            blocks.append(                     # remap local indices -> global and store
                csr_matrix(
                    (sub.data, (mask[sub.row], mask[sub.col])),  # local->global row/col
                    shape=(n, n),
                )
            )
        A = blocks[0]                          # A = accumulator, start with first sample's block
        for blk in blocks[1:]:                 # blk = each remaining per-sample block
            A = A + blk                        # disjoint supports, so addition = block-diagonal union
        return A.tocsr()                       # CSR is the efficient form for later row ops

    # ---- single-sample construction ----
    if method == "knn":
        k = min(n_neighs, n)                   # k = neighbors to fetch (cap at n for tiny inputs)
        nn = NearestNeighbors(n_neighbors=k).fit(coords)  # nn = fitted spatial index
        _, idx = nn.kneighbors(coords)         # idx = (n, k) neighbor indices; col 0 is self (dist 0)
        if not include_self:                   # optionally drop the self column
            idx = idx[:, 1:]                   # keep neighbors 1..k-1
        rows = np.repeat(np.arange(n), idx.shape[1])  # rows = source cell repeated once per neighbor
        cols = idx.ravel()                     # cols = flattened neighbor (target) indices
        data = np.ones(rows.shape[0], dtype=np.float32)  # data = 1.0 for every (row, col) edge
        A = csr_matrix((data, (rows, cols)), shape=(n, n))  # A = membership matrix

    elif method == "radius":
        if radius is None:                     # radius is mandatory for this mode
            raise ValueError("`radius` must be given when method='radius'.")
        nn = NearestNeighbors(radius=radius).fit(coords)  # nn = fitted radius index
        A = nn.radius_neighbors_graph(coords, mode="connectivity")  # A = binary adjacency within radius
        if include_self:                       # radius graph excludes self by default; add it back
            A = A.tolil()                      # LIL allows cheap diagonal assignment
            A.setdiag(1.0)                     # put each cell in its own window
            A = A.tocsr()                      # convert back to CSR for downstream math
    else:
        raise ValueError(f"Unknown method {method!r}; use 'knn' or 'radius'.")

    return A                                   # sparse (n, n) window-membership matrix


# --------------------------------------------------------------------------- #
# Step 2 — windowed cell-type composition
# --------------------------------------------------------------------------- #
def neighborhood_composition(
    adjacency: spmatrix,
    labels: ArrayLike,
    *,
    normalize: bool = True,
):
    """Turn each cell's window into a vector of cell-type proportions.

    BIOLOGICAL CONTEXT
        This is the quantitative fingerprint of a cell's microenvironment: "your
        surroundings are 60% tumor, 25% macrophage, 15% T cell." Two cells with
        similar fingerprints sit in the same kind of niche even if they are far
        apart in the tissue or are different cell types themselves.

    COMPUTATIONAL APPROACH
        One-hot encode the cell types, then a single sparse product
        ``A @ onehot`` sums, for each cell, how many of each type fall in its
        window. Row-normalizing converts counts to proportions. Cost is
        O(nnz(A)); scales to millions of cells.

    Parameters
    ----------
    adjacency   window-membership matrix A from build_spatial_neighbors.
    labels      (n_cells,) categorical cell-type calls (any hashable dtype).
    normalize   True -> proportions summing to 1 per row; False -> raw counts.

    Returns
    -------
    composition     (n_cells, n_types) float array of window compositions.
    celltype_order  list of cell-type names giving the column order.
    """
    labels = np.asarray(labels)                            # (n_cells,) cell-type label per cell
    categories, codes = np.unique(labels, return_inverse=True)
    # categories = sorted unique cell-type names (defines column order)
    # codes      = (n_cells,) integer code of each cell's type into `categories`
    n = labels.shape[0]                                    # n = number of cells
    onehot = csr_matrix(                                   # onehot = (n_cells, n_types) indicator matrix
        (np.ones(n, dtype=np.float32), (np.arange(n), codes)),  # a 1 at (cell, its type)
        shape=(n, categories.shape[0]),
    )
    counts = np.asarray((adjacency @ onehot).todense(), dtype=float)
    # counts = (n_cells, n_types); counts[i, t] = # of type-t cells in window of cell i
    if normalize:
        row = counts.sum(axis=1, keepdims=True)           # row = (n_cells, 1) window size per cell
        row[row == 0] = 1.0                               # guard: avoid divide-by-zero for empty windows
        counts = counts / row                             # counts -> proportions summing to 1 per row
    return counts, list(categories)                       # composition matrix + column names


# --------------------------------------------------------------------------- #
# Step 3 — cluster composition vectors into neighborhoods
# --------------------------------------------------------------------------- #
def cluster_neighborhoods(
    composition: np.ndarray,
    *,
    resolution: float = 0.1,
    n_neighbors: int = 15,
    random_state: int = 0,
    n_iterations: int = 2,
) -> np.ndarray:
    """Cluster per-cell composition vectors into discrete neighborhoods.

    BIOLOGICAL CONTEXT
        Cells whose surroundings look alike get grouped into the same niche.
        `resolution` sets granularity: too low and distinct niches merge, too high
        and one biological niche fragments. The number of niches is not fixed up
        front — it falls out of the data — so it is worth scanning a few
        resolutions and reading the enrichment heatmap to pick an interpretable
        partition.

    COMPUTATIONAL APPROACH
        Build a k-nearest-neighbor graph in composition space (each point is a
        length-n_types proportion vector), then run Leiden community detection on
        it. Leiden finds modular communities without being told how many to look
        for, and unlike Euclidean k-means it does not assume niches are equally
        sized, isotropic blobs. Composition space has only n_types dimensions and
        its kNN graph is far more modular than an expression-space one, so useful
        resolutions sit well below the 1.0 that is customary for clustering cells:
        the 0.1 default lands around ten niches on a typical slide.

    Parameters
    ----------
    composition   (n_cells, n_types) window compositions.
    resolution    Leiden resolution; higher yields more, smaller neighborhoods.
    n_neighbors   neighborhood size of the kNN graph built over compositions.
    random_state  seed for reproducible cluster assignments.
    n_iterations  Leiden refinement iterations over the graph.

    Returns
    -------
    labels  (n_cells,) integer CN id per cell, contiguous from 0.
    """
    from .._leiden import leiden_labels                     # shared graspologic-native Leiden core

    n = composition.shape[0]                                # n = number of cells
    graph = kneighbors_graph(                               # graph = binary kNN graph over compositions
        composition,
        n_neighbors=min(n_neighbors, n - 1),               # cap for inputs smaller than the graph size
        mode="connectivity",                               # unweighted: many cells tie on distance
        include_self=False,
    )
    partition = leiden_labels(                              # partition = Categorical of string cluster ids
        graph, resolution=resolution, random_state=random_state, n_iterations=n_iterations
    )
    return np.asarray(partition.codes, dtype=int)           # codes = CN id per cell, contiguous from 0


# --------------------------------------------------------------------------- #
# Step 4 — characterize neighborhoods
# --------------------------------------------------------------------------- #
def characterize_neighborhoods(
    labels: np.ndarray,
    composition: np.ndarray,
    celltype_order: Sequence,
    cell_labels: Optional[ArrayLike] = None,
):
    """Summarize each neighborhood by mean composition and log2 enrichment.

    BIOLOGICAL CONTEXT
        `mean_composition` answers "what is this niche made of?" while
        `enrichment` answers "which cell types make this niche *distinctive*
        relative to the tissue as a whole?" Enrichment is what you read to name a
        CN ("this one is enriched for CD8 T cells and macrophages -> immune
        infiltrate"), because it corrects for globally abundant cell types.

    COMPUTATIONAL APPROACH
        Average the window compositions of the cells assigned to each CN, then
        divide by the tissue-wide cell-type frequency and take a log2 to get a
        symmetric fold-change (positive = enriched, negative = depleted). A small
        epsilon avoids log(0).

    Parameters
    ----------
    labels          (n_cells,) CN id per cell.
    composition     (n_cells, n_types) window compositions.
    celltype_order  column names matching composition.
    cell_labels     (n_cells,) actual cell-type calls; used for the global
                    baseline if given, else the mean window composition is used.

    Returns
    -------
    mean_composition_df  (n_cn x n_types) mean proportion per CN.
    enrichment_df        (n_cn x n_types) log2 fold-enrichment per CN.
    """
    labels = np.asarray(labels)                            # (n_cells,) CN id per cell
    cn_ids = np.unique(labels)                             # cn_ids = sorted distinct CN ids present
    mean_comp = np.vstack(                                 # mean_comp = (n_cn, n_types) per-CN mean composition
        [composition[labels == c].mean(axis=0) for c in cn_ids]  # average over cells in CN c
    )
    mean_df = pd.DataFrame(                                # mean_df = labeled version of mean_comp
        mean_comp,
        index=[f"CN{c}" for c in cn_ids],                 # row names "CN0", "CN1", ...
        columns=list(celltype_order),                     # column names = cell types
    )

    if cell_labels is not None:
        cl = np.asarray(cell_labels)                      # cl = (n_cells,) actual cell-type calls
        global_freq = np.array(                           # global_freq = tissue-wide fraction of each type
            [np.mean(cl == t) for t in celltype_order], dtype=float
        )
    else:
        global_freq = composition.mean(axis=0)            # fallback baseline = mean window composition

    eps = 1e-9                                             # eps = pseudocount to keep log finite
    enr = np.log2((mean_comp + eps) / (global_freq + eps))  # enr = (n_cn, n_types) log2 fold-enrichment
    enr_df = pd.DataFrame(                                 # enr_df = labeled enrichment table
        enr, index=mean_df.index, columns=list(celltype_order)
    )
    return mean_df, enr_df                                 # mean composition + enrichment tables


# --------------------------------------------------------------------------- #
# Orchestrator (array interface)
# --------------------------------------------------------------------------- #
def cellular_neighborhoods(
    coords: np.ndarray,
    cell_types: ArrayLike,
    *,
    n_neighs: int = 20,
    resolution: float = 0.1,
    cluster_n_neighbors: int = 15,
    n_iterations: int = 2,
    method: str = "knn",
    radius: Optional[float] = None,
    batch: Optional[ArrayLike] = None,
    random_state: int = 0,
    adjacency: Optional[spmatrix] = None,
) -> CNResult:
    """Run the complete CN pipeline on plain arrays and return a CNResult.

    BIOLOGICAL CONTEXT
        End-to-end: from cell positions + cell-type calls to a niche label for
        every cell plus tables describing each niche. This is the object you then
        hand to ``cn_plot`` to see the tissue architecture.

    COMPUTATIONAL APPROACH
        Chains steps 1-4. Pass `adjacency` to reuse a prebuilt graph (e.g.
        squidpy's ``spatial_connectivities``) and skip step 1.

    Parameters
    ----------
    coords               (n_cells, 2 or 3) spatial coordinates.
    cell_types           (n_cells,) cell-type calls.
    n_neighs             window size W (knn).
    resolution           Leiden resolution; higher yields more, smaller niches.
    cluster_n_neighbors  kNN graph size in composition space, for Leiden.
    n_iterations         Leiden refinement iterations.
    method               graph type "knn" or "radius".
    radius               radius for method="radius".
    batch                (n_cells,) sample ids to keep windows within-sample.
    random_state         reproducibility seed.
    adjacency            optional prebuilt window-membership matrix.

    Returns
    -------
    CNResult
    """
    cell_types = np.asarray(cell_types)                    # (n_cells,) cell-type calls
    batch_arr = None if batch is None else np.asarray(batch)  # batch_arr = sample ids or None

    if adjacency is None:                                  # build the window graph unless one is supplied
        adjacency = build_spatial_neighbors(              # adjacency = (n, n) window-membership matrix
            coords, method=method, n_neighs=n_neighs, radius=radius,
            include_self=True, batch=batch_arr,
        )

    comp, order = neighborhood_composition(               # comp = (n, n_types) proportions; order = type names
        adjacency, cell_types, normalize=True
    )
    labels = cluster_neighborhoods(                        # labels = per-cell CN id from Leiden
        comp, resolution=resolution, n_neighbors=cluster_n_neighbors,
        random_state=random_state, n_iterations=n_iterations,
    )
    mean_df, enr_df = characterize_neighborhoods(         # mean_df / enr_df = per-CN summary tables
        labels, comp, order, cell_types
    )

    return CNResult(                                      # bundle all outputs for downstream plotting
        labels=labels,
        composition=comp,
        celltype_order=order,
        enrichment=enr_df,
        mean_composition=mean_df,
    )


# --------------------------------------------------------------------------- #
# AnnData / scanpy / squidpy wrapper
# --------------------------------------------------------------------------- #
def cellular_neighborhoods_adata(
    adata,
    cell_type_key: str,
    *,
    spatial_key: str = "spatial",
    library_key: Optional[str] = None,
    n_neighs: int = 20,
    resolution: float = 0.1,
    cluster_n_neighbors: int = 15,
    n_iterations: int = 2,
    method: str = "knn",
    radius: Optional[float] = None,
    random_state: int = 0,
    use_squidpy_graph: bool = False,
    key_added: str = "cellular_neighborhood",
    copy: bool = False,
):
    """Compute CNs on an AnnData object, scanpy/squidpy style.

    BIOLOGICAL CONTEXT
        Same analysis, wired into the standard single-cell/spatial data container
        so it fits an existing scanpy/squidpy pipeline. Results land in the
        conventional slots so downstream tools and plots can find them.

    COMPUTATIONAL APPROACH
        Pull coordinates and labels out of the AnnData, call the array pipeline,
        write results back:
          * adata.obs[key_added]                    -> categorical CN per cell
          * adata.obsm[key_added + "_composition"]  -> composition matrix
          * adata.uns[key_added]                    -> enrichment, mean comp, params

    Set `use_squidpy_graph=True` to reuse ``adata.obsp['spatial_connectivities']``
    (run ``squidpy.gr.spatial_neighbors`` first).

    Returns
    -------
    CNResult if copy=False (results also written in place); else the AnnData copy.
    """
    if copy:                                              # optionally work on a copy, leaving input untouched
        adata = adata.copy()                             # adata = independent duplicate

    coords = np.asarray(adata.obsm[spatial_key])         # coords = (n_cells, dim) spatial coordinates
    cell_types = np.asarray(adata.obs[cell_type_key].values)  # cell_types = (n_cells,) type calls
    batch = None if library_key is None else np.asarray(adata.obs[library_key].values)
    # batch = per-cell sample id (or None if single sample)

    adjacency = None                                     # adjacency = graph to reuse; None -> build fresh
    if use_squidpy_graph:                                # reuse squidpy's precomputed spatial graph
        if "spatial_connectivities" not in adata.obsp:
            raise KeyError(
                "adata.obsp['spatial_connectivities'] not found. Run "
                "squidpy.gr.spatial_neighbors(adata) first, or set "
                "use_squidpy_graph=False."
            )
        adjacency = adata.obsp["spatial_connectivities"].copy().tocsr()  # copy graph as CSR
        adjacency.setdiag(1.0)                           # include self so the index cell counts in its window

    res = cellular_neighborhoods(                        # res = CNResult from the array pipeline
        coords, cell_types,
        n_neighs=n_neighs, resolution=resolution,
        cluster_n_neighbors=cluster_n_neighbors, n_iterations=n_iterations,
        method=method, radius=radius, batch=batch,
        random_state=random_state, adjacency=adjacency,
    )

    adata.obs[key_added] = pd.Categorical(               # write per-cell CN label as an ordered categorical
        [f"CN{c}" for c in res.labels],                  # "CN{id}" string per cell
        categories=[f"CN{c}" for c in range(res.n_neighborhoods)],  # fixed category order
    )
    adata.obsm[f"{key_added}_composition"] = res.composition  # store composition matrix in obsm
    adata.uns[key_added] = {                             # store tables + params in uns
        "enrichment": res.enrichment,
        "mean_composition": res.mean_composition,
        "celltype_order": res.celltype_order,
        "params": {                                      # record settings for provenance/reproducibility
            "cell_type_key": cell_type_key,
            "n_neighs": n_neighs,
            "resolution": resolution,
            "cluster_n_neighbors": cluster_n_neighbors,
            "n_iterations": n_iterations,
            "method": method,
            "radius": radius,
            "random_state": random_state,
            "used_squidpy_graph": use_squidpy_graph,
        },
    }
    return adata if copy else res                        # copy -> return AnnData; else return CNResult
