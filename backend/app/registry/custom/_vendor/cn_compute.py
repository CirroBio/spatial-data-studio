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
  3. cluster_neighborhoods    — k-means over those composition vectors; each
     cluster is one cellular neighborhood.
  4. characterize_neighborhoods — summarize each CN as mean composition and as
     log2 enrichment over the tissue-wide cell-type frequencies.

The core depends only on numpy / scipy / scikit-learn and operates on plain
arrays. ``cellular_neighborhoods_adata`` is a thin AnnData wrapper.

NOTE: this is distinct from ``squidpy.gr.nhood_enrichment``, which is a
permutation test for *pairwise* cell-type co-localization. CN analysis instead
assigns every cell to a multicellular niche by clustering composition vectors.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Sequence, Union

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix, spmatrix
from sklearn.cluster import KMeans, MiniBatchKMeans
from sklearn.neighbors import NearestNeighbors

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
    centroids         (n_cn, n_types)  k-means cluster centers (= idealized niche).
    enrichment        DataFrame        log2(CN proportion / global frequency).
    mean_composition  DataFrame        mean cell-type proportion within each CN.
    estimator         fitted k-means   the clustering object (for reuse/predict).
    """

    labels: np.ndarray                     # (n_cells,) integer neighborhood id per cell
    composition: np.ndarray               # (n_cells, n_types) proportion matrix
    celltype_order: list                  # ordered cell-type names = matrix columns
    centroids: np.ndarray                 # (n_cn, n_types) k-means centroids
    enrichment: pd.DataFrame              # (n_cn x n_types) log2 fold-enrichment
    mean_composition: pd.DataFrame       # (n_cn x n_types) mean proportion per CN
    estimator: object = field(repr=False)  # fitted (MiniBatch)KMeans instance

    @property
    def n_neighborhoods(self) -> int:
        """Number of neighborhoods = number of centroid rows."""
        return self.centroids.shape[0]   # rows of centroid matrix = one per CN


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
    n_neighborhoods: int = 10,
    method: str = "minibatch",
    random_state: int = 0,
    **kwargs,
):
    """Cluster per-cell composition vectors into discrete neighborhoods.

    BIOLOGICAL CONTEXT
        Cells whose surroundings look alike get grouped into the same niche.
        `n_neighborhoods` sets granularity: too few and distinct niches merge, too
        many and one biological niche fragments. It is worth scanning a few values
        and reading the enrichment heatmap to pick an interpretable number.

    COMPUTATIONAL APPROACH
        k-means in composition space (each point is a length-n_types proportion
        vector). MiniBatchKMeans is the default because the original method used it
        for scalability to millions of cells; plain KMeans is available for small
        datasets. Euclidean k-means on proportions is the field-standard choice.

    Parameters
    ----------
    composition      (n_cells, n_types) window compositions.
    n_neighborhoods  number of neighborhoods (k) to fit.
    method           "minibatch" (default) or "kmeans".
    random_state     seed for reproducible cluster assignments.
    **kwargs         forwarded to the scikit-learn estimator.

    Returns
    -------
    labels     (n_cells,) integer CN id per cell.
    estimator  the fitted (MiniBatch)KMeans object.
    """
    if method == "minibatch":
        est = MiniBatchKMeans(                              # est = scalable k-means estimator
            n_clusters=n_neighborhoods,                    # k = number of niches
            random_state=random_state,                     # reproducibility seed
            n_init=kwargs.pop("n_init", 10),               # restarts to avoid poor local minima
            **kwargs,
        )
    elif method == "kmeans":
        est = KMeans(                                       # est = exact k-means estimator
            n_clusters=n_neighborhoods,
            random_state=random_state,
            n_init=kwargs.pop("n_init", 10),
            **kwargs,
        )
    else:
        raise ValueError(f"Unknown method {method!r}; use 'minibatch' or 'kmeans'.")
    labels = est.fit_predict(composition)                  # labels = (n_cells,) CN id per cell
    return labels, est                                     # assignments + fitted model


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
    n_neighborhoods: int = 10,
    method: str = "knn",
    radius: Optional[float] = None,
    batch: Optional[ArrayLike] = None,
    cluster_method: str = "minibatch",
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
    coords           (n_cells, 2 or 3) spatial coordinates.
    cell_types       (n_cells,) cell-type calls.
    n_neighs         window size W (knn).
    n_neighborhoods  number of niches (k) to fit.
    method           graph type "knn" or "radius".
    radius           radius for method="radius".
    batch            (n_cells,) sample ids to keep windows within-sample.
    cluster_method   "minibatch" or "kmeans".
    random_state     reproducibility seed.
    adjacency        optional prebuilt window-membership matrix.

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
    labels, est = cluster_neighborhoods(                  # labels = per-cell CN id; est = fitted k-means
        comp, n_neighborhoods=n_neighborhoods,
        method=cluster_method, random_state=random_state,
    )
    mean_df, enr_df = characterize_neighborhoods(         # mean_df / enr_df = per-CN summary tables
        labels, comp, order, cell_types
    )

    return CNResult(                                      # bundle all outputs for downstream plotting
        labels=labels,
        composition=comp,
        celltype_order=order,
        centroids=est.cluster_centers_,                  # (n_cn, n_types) idealized niche compositions
        enrichment=enr_df,
        mean_composition=mean_df,
        estimator=est,
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
    n_neighborhoods: int = 10,
    method: str = "knn",
    radius: Optional[float] = None,
    cluster_method: str = "minibatch",
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
        n_neighs=n_neighs, n_neighborhoods=n_neighborhoods,
        method=method, radius=radius, batch=batch,
        cluster_method=cluster_method, random_state=random_state,
        adjacency=adjacency,
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
            "n_neighborhoods": n_neighborhoods,
            "method": method,
            "radius": radius,
            "cluster_method": cluster_method,
            "random_state": random_state,
            "used_squidpy_graph": use_squidpy_graph,
        },
    }
    return adata if copy else res                        # copy -> return AnnData; else return CNResult


# --------------------------------------------------------------------------- #
# Synthetic dataset generator (shared by the demo and by cn_plot's demo)
# --------------------------------------------------------------------------- #
def make_synthetic_tissue(seed: int = 0, n_per_domain: int = 500):
    """Generate a toy 3-domain tissue for testing/demos (no external deps).

    BIOLOGICAL CONTEXT
        Mimics a tissue with three spatial compartments — a tumor core, an immune
        infiltrate, and a stromal region — each with a distinct but overlapping
        cell-type mixture, so the recovered CNs have a known ground truth.

    COMPUTATIONAL APPROACH
        Sample three Gaussian blobs of (x, y) positions, drawing each cell's type
        from a domain-specific multinomial. Returns coordinates, cell types, and
        the true domain id per cell.

    Returns
    -------
    coords       (n, 2) coordinates.
    cell_types   (n,) cell-type calls.
    true_domain  (n,) ground-truth domain id (0/1/2) for validation.
    """
    rng = np.random.default_rng(seed)                    # rng = seeded random generator
    types = np.array(["Tumor", "CD8T", "Macrophage", "Bcell", "Stroma"])  # cell-type vocabulary

    def blob(cx, cy, probs):                             # helper: one Gaussian domain
        xy = rng.normal([cx, cy], 6.0, size=(n_per_domain, 2))  # xy = (n_per, 2) positions around (cx, cy)
        ct = types[rng.choice(len(probs), size=n_per_domain, p=probs)]  # ct = cell types from multinomial
        return xy, ct

    xy1, c1 = blob(0, 0,   [0.70, 0.10, 0.10, 0.05, 0.05])  # domain 0: tumor core
    xy2, c2 = blob(40, 0,  [0.10, 0.35, 0.30, 0.20, 0.05])  # domain 1: immune infiltrate
    xy3, c3 = blob(20, 35, [0.05, 0.05, 0.10, 0.10, 0.70])  # domain 2: stroma
    coords = np.vstack([xy1, xy2, xy3])                  # coords = stacked positions of all domains
    cell_types = np.concatenate([c1, c2, c3])           # cell_types = stacked type calls
    true_domain = np.repeat([0, 1, 2], n_per_domain)    # true_domain = ground-truth domain id per cell
    return coords, cell_types, true_domain


def _demo():
    """Run the pipeline on synthetic tissue and print the summary tables."""
    coords, cell_types, true_domain = make_synthetic_tissue()  # generate toy tissue with known truth
    res = cellular_neighborhoods(                              # res = CNResult from the pipeline
        coords, cell_types, n_neighs=20, n_neighborhoods=3, random_state=0
    )
    print("Mean cell-type composition per neighborhood (proportions):")
    print(res.mean_composition.round(2).to_string())
    print("\nLog2 enrichment over tissue baseline (CN x cell type):")
    print(res.enrichment.round(2).to_string())

    from sklearn.metrics import adjusted_rand_score              # imported lazily; validation only
    ari = adjusted_rand_score(true_domain, res.labels)          # ari = agreement of CNs with planted domains
    print("\nARI of recovered CNs vs. planted spatial domains:", round(ari, 3))


if __name__ == "__main__":
    _demo()
