"""
milo_da_compute.py
==================

COMPUTATION for Milo-style differential-abundance (DA) testing on single-cell
data. Plotting lives in ``milo_da_plot.py``.

------------------------------------------------------------------------------
BIOLOGICAL CONTEXT
------------------------------------------------------------------------------
When you compare conditions (disease vs. healthy, treated vs. control), the
biology of interest is often "which cell states got more or less abundant?"
Testing this on discrete clusters is blunt: a shift confined to part of a cluster,
or spread along a continuous trajectory, is averaged away. Milo (Dann et al.,
Nat Biotechnol 2021) instead tests abundance in many small, overlapping
neighborhoods on the KNN graph, so it can localize compositional change at the
resolution of the manifold itself.

WHY THIS FILE EXISTS: Milo ships as an R package (miloR); there is no
``scanpy``/``squidpy`` function for it. This is a faithful, dependency-light
reimplementation on numpy/scipy/scikit-learn.

------------------------------------------------------------------------------
COMPUTATIONAL APPROACH
------------------------------------------------------------------------------
  1. build_knn_graph        — KNN graph on a low-dim embedding (e.g. PCA).
  2. make_neighborhoods     — pick representative index cells (random sample,
                              optionally refined to the cell nearest each sampled
                              window's median position) and define each
                              neighborhood as an index cell + its KNN.
  3. count_cells            — cells per neighborhood per sample -> count matrix.
  4. test_da                — per-neighborhood negative-binomial GLM (IRLS) with a
                              log-library-size offset; Wald test on the condition
                              coefficient gives logFC + p-value.
  5. spatial_fdr            — weighted Benjamini-Hochberg (cydar/Milo adaptation)
                              that down-weights overlapping neighborhoods, using
                              the reciprocal of the k-th nearest-neighbor distance.
  6. annotate_neighborhoods — majority cell-type label per neighborhood, for
                              grouping results in the beeswarm plot.

NOTE: unlike edgeR (which Milo uses), this GLM has no empirical-Bayes dispersion
shrinkage; a `prior_count` stabilizes fold-changes for sparse neighborhoods.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Sequence, Union

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix, spmatrix
from scipy.stats import norm
from sklearn.neighbors import NearestNeighbors

ArrayLike = Union[np.ndarray, Sequence]


@dataclass
class MiloResult:
    """Everything a Milo DA run produces, for handoff to milo_da_plot."""

    index_cells: np.ndarray          # (M,) row index of each neighborhood's index cell
    membership: csr_matrix           # (M, n_cells) 0/1 neighborhood-membership matrix
    counts: np.ndarray               # (M, n_samples) cells per neighborhood per sample
    sample_order: list               # sample ids matching count columns
    logFC: np.ndarray                # (M,) log2 fold-change (condition vs. reference)
    pvalue: np.ndarray               # (M,) raw Wald p-value
    fdr: np.ndarray                  # (M,) spatial-FDR-corrected p-value
    nhood_size: np.ndarray           # (M,) number of cells in each neighborhood
    annotation: Optional[np.ndarray] # (M,) majority cell-type label per neighborhood
    annotation_frac: Optional[np.ndarray]  # (M,) purity of that majority label
    params: dict = field(default_factory=dict)

    @property
    def n_neighborhoods(self) -> int:
        return self.counts.shape[0]


# --------------------------------------------------------------------------- #
# Step 1 — KNN graph
# --------------------------------------------------------------------------- #
def build_knn_graph(embedding: np.ndarray, *, k: int = 30):
    """KNN graph on a cell embedding.

    BIOLOGICAL CONTEXT
        Neighbors in a good embedding (PCA/scVI) are cells in a similar
        transcriptional state; DA is tested over these local states.
    COMPUTATIONAL APPROACH
        Exact KNN via scikit-learn; returns neighbor indices and distances.

    Returns
    -------
    knn_idx   (n_cells, k) neighbor indices (col 0 is self).
    knn_dist  (n_cells, k) neighbor distances (col 0 is 0).
    """
    emb = np.asarray(embedding, dtype=float)              # emb = (n_cells, n_dims) coordinates
    k = min(k, emb.shape[0])                              # k = neighbors (capped for tiny inputs)
    nn = NearestNeighbors(n_neighbors=k).fit(emb)         # nn = fitted index
    knn_dist, knn_idx = nn.kneighbors(emb)                # distances + indices; self is column 0
    return knn_idx, knn_dist


# --------------------------------------------------------------------------- #
# Step 2 — representative neighborhoods
# --------------------------------------------------------------------------- #
def make_neighborhoods(
    embedding: np.ndarray,
    knn_idx: np.ndarray,
    *,
    prop: float = 0.1,
    refine: bool = True,
    random_state: int = 0,
):
    """Select index cells and build their neighborhoods.

    BIOLOGICAL CONTEXT
        Testing every cell's neighborhood is redundant and costly; Milo samples a
        representative subset that still tiles the manifold, giving fewer but more
        robust neighborhoods.
    COMPUTATIONAL APPROACH
        Randomly sample a fraction `prop` of cells. If `refine`, replace each
        sampled cell by the cell nearest to the *median embedding position* of its
        KNN window (Milo's refinement, which makes selection robust and
        neighborhoods larger/more representative). Deduplicate index cells;
        membership matrix = index cell + its KNN.

    Returns
    -------
    index_cells  (M,) chosen index-cell row indices.
    membership   (M, n_cells) sparse 0/1 membership matrix.
    """
    emb = np.asarray(embedding, dtype=float)              # emb = (n_cells, n_dims) coordinates
    n = emb.shape[0]                                      # n = number of cells
    rng = np.random.default_rng(random_state)             # rng = seeded RNG for sampling
    n_sample = max(1, int(prop * n))                      # n_sample = number of initial seeds
    seeds = rng.choice(n, size=n_sample, replace=False)   # seeds = randomly sampled cell indices

    if refine:                                            # Milo refinement to a representative cell
        refined = np.empty(n_sample, dtype=int)           # refined = index cell per seed
        for i, s in enumerate(seeds):                     # s = one sampled seed cell
            window = knn_idx[s]                           # window = seed's KNN indices
            median_pos = np.median(emb[window], axis=0)   # median_pos = center of the window
            d = np.linalg.norm(emb[window] - median_pos, axis=1)  # d = distance of members to center
            refined[i] = window[np.argmin(d)]             # pick the member closest to the median
        index_cells = np.unique(refined)                 # dedupe (dense regions collapse to same cell)
    else:
        index_cells = np.unique(seeds)                    # no refinement: seeds themselves

    M = index_cells.shape[0]                              # M = number of neighborhoods
    nhood_members = knn_idx[index_cells]                  # (M, k) members of each neighborhood
    rows = np.repeat(np.arange(M), nhood_members.shape[1])  # rows = neighborhood id per edge
    cols = nhood_members.ravel()                          # cols = member cell index per edge
    membership = csr_matrix(                              # membership = (M, n_cells) 0/1 matrix
        (np.ones(rows.shape[0], dtype=np.float32), (rows, cols)), shape=(M, n)
    )
    membership.data[:] = 1.0                              # collapse any duplicate edges to 1
    return index_cells, membership


# --------------------------------------------------------------------------- #
# Step 3 — count matrix
# --------------------------------------------------------------------------- #
def count_cells(membership: spmatrix, sample: ArrayLike):
    """Count cells per neighborhood per sample.

    BIOLOGICAL CONTEXT
        The replicate-level counts are the raw material of the DA test: how many
        cells each biological sample contributes to each neighborhood.
    COMPUTATIONAL APPROACH
        One-hot the sample labels; ``membership @ onehot`` yields the count matrix.

    Returns
    -------
    counts        (M, n_samples).
    sample_order  list of sample ids matching the columns.
    """
    sample = np.asarray(sample)                           # sample = (n_cells,) sample id per cell
    cats, codes = np.unique(sample, return_inverse=True)  # cats = sample ids; codes = per-cell code
    n = sample.shape[0]                                   # n = number of cells
    onehot = csr_matrix(                                  # onehot = (n_cells, n_samples) indicator
        (np.ones(n, dtype=np.float32), (np.arange(n), codes)), shape=(n, cats.shape[0])
    )
    counts = np.asarray((membership @ onehot).todense(), dtype=float)  # counts = (M, n_samples)
    return counts, list(cats)


# --------------------------------------------------------------------------- #
# Step 4 — negative-binomial GLM per neighborhood
# --------------------------------------------------------------------------- #
def _nb_glm_wald(y, X, offset, *, max_iter=50, tol=1e-8):
    """Fit a negative-binomial GLM (log link) by IRLS; Wald-test the last coef.

    COMPUTATIONAL APPROACH
        IRLS with NB working weights W = mu / (1 + alpha*mu) for a log link, where
        the dispersion alpha is updated each iteration by method of moments on the
        Pearson residuals. The Wald z on the final (condition) coefficient gives a
        two-sided p-value; the coefficient converted to base-2 is the logFC.

    Returns (logFC, pvalue).
    """
    n, p = X.shape                                        # n = samples, p = design columns
    beta = np.zeros(p)                                    # beta = coefficient vector
    beta[0] = np.log(y.mean() + 1e-6)                     # init intercept at log mean count
    alpha = 0.1                                           # alpha = NB dispersion (updated below)
    for _ in range(max_iter):
        eta = X @ beta + offset                           # eta = linear predictor (with library offset)
        mu = np.exp(np.clip(eta, -30, 30))                # mu = expected counts
        W = mu / (1.0 + alpha * mu)                       # W = NB IRLS weights for log link
        z = eta - offset + (y - mu) / mu                  # z = working response
        WX = X * W[:, None]                               # WX = weight-scaled design
        beta_new = np.linalg.solve(                       # solve weighted normal equations
            X.T @ WX + 1e-8 * np.eye(p), WX.T @ z
        )
        mu = np.exp(np.clip(X @ beta_new + offset, -30, 30))  # mu = refit means
        alpha = max(1e-6, np.sum((y - mu) ** 2 - mu) / np.sum(mu ** 2))  # MoM dispersion update
        if np.max(np.abs(beta_new - beta)) < tol:         # convergence check
            beta = beta_new
            break
        beta = beta_new                                   # accept step
    eta = X @ beta + offset                               # final linear predictor
    mu = np.exp(np.clip(eta, -30, 30))                    # final means
    W = mu / (1.0 + alpha * mu)                           # final weights
    cov = np.linalg.inv(X.T @ (X * W[:, None]) + 1e-8 * np.eye(p))  # coefficient covariance
    se = np.sqrt(np.diag(cov))                            # se = standard errors
    zstat = beta[-1] / se[-1]                             # zstat = Wald statistic on condition coef
    pval = 2.0 * norm.sf(abs(zstat))                      # pval = two-sided p-value
    logFC = beta[-1] / np.log(2.0)                        # logFC = condition effect in log2 units
    return logFC, pval


def test_da(counts: np.ndarray, condition: np.ndarray, *, prior_count: float = 1.0):
    """Per-neighborhood DA test between two conditions.

    BIOLOGICAL CONTEXT
        Positive logFC = the neighborhood is enriched in the second condition
        (the "treatment" level); negative = depleted. The p-value asks whether
        that shift exceeds replicate-to-replicate noise.
    COMPUTATIONAL APPROACH
        Build a design [intercept, condition]; offset = log(library size per
        sample). Add `prior_count` to counts to stabilize sparse neighborhoods,
        then fit the NB GLM per neighborhood.

    Parameters
    ----------
    counts       (M, n_samples) count matrix from count_cells.
    condition    (n_samples,) condition code per SAMPLE (two levels, 0 = reference).
    prior_count  pseudocount added to every entry to tame extreme fold-changes.

    Returns
    -------
    logFC (M,), pvalue (M,).
    """
    condition = np.asarray(condition)                     # condition = (n_samples,) group code
    levels = np.unique(condition)                         # levels = distinct condition values
    if levels.shape[0] != 2:
        raise ValueError("test_da supports exactly two conditions; got "
                         f"{levels.shape[0]}.")
    cond_code = (condition == levels[1]).astype(float)    # cond_code = 1 for treatment, 0 for reference
    X = np.column_stack([np.ones_like(cond_code), cond_code])  # X = design [intercept, condition]
    libsize = counts.sum(axis=0)                          # libsize = total cells per sample (column sums)
    libsize[libsize == 0] = 1.0                           # guard against empty samples
    offset = np.log(libsize)                              # offset = log library size per sample
    y_all = counts + prior_count                          # y_all = stabilized counts
    M = counts.shape[0]                                   # M = number of neighborhoods
    logFC = np.empty(M)                                   # logFC = per-neighborhood effect sizes
    pval = np.empty(M)                                    # pval = per-neighborhood p-values
    for m in range(M):                                    # m = neighborhood index
        logFC[m], pval[m] = _nb_glm_wald(y_all[m], X, offset)  # fit + test this neighborhood
    return logFC, pval


# --------------------------------------------------------------------------- #
# Step 5 — spatial (overlap-aware) FDR
# --------------------------------------------------------------------------- #
def spatial_fdr(pvalue: np.ndarray, weights: np.ndarray):
    """Weighted Benjamini-Hochberg correction (cydar/Milo spatial FDR).

    BIOLOGICAL CONTEXT
        Neighborhoods overlap, so naive BH over-counts tests in dense regions.
        Weighting each p-value by a density proxy (reciprocal of the k-th NN
        distance) restores calibrated error control across the graph.
    COMPUTATIONAL APPROACH
        Sort by p-value; replace integer ranks in BH with cumulative weights,
        then enforce monotonicity via a reverse running minimum.

    Parameters
    ----------
    pvalue   (M,) raw p-values.
    weights  (M,) per-neighborhood weights (e.g. 1 / kth-NN distance).

    Returns
    -------
    (M,) spatial-FDR-adjusted p-values.
    """
    pvalue = np.asarray(pvalue, dtype=float)              # pvalue = raw p-values
    w = np.asarray(weights, dtype=float)                  # w = per-neighborhood weights
    w = w / w.sum() * w.shape[0]                          # normalize so weights average ~1
    order = np.argsort(pvalue)                            # order = indices sorting p ascending
    p_ord = pvalue[order]                                 # p_ord = sorted p-values
    w_ord = w[order]                                      # w_ord = weights in that order
    cumw = np.cumsum(w_ord)                               # cumw = cumulative weight (weighted rank)
    total = w_ord.sum()                                   # total = sum of weights
    adj_ord = p_ord * total / cumw                        # adj_ord = weighted BH factor
    adj_ord = np.minimum.accumulate(adj_ord[::-1])[::-1]  # enforce monotone non-decreasing in p
    adj = np.empty_like(adj_ord)                          # adj = adjusted p in original order
    adj[order] = np.clip(adj_ord, 0, 1)                   # scatter back and clamp to [0, 1]
    return adj


# --------------------------------------------------------------------------- #
# Step 6 — neighborhood annotation
# --------------------------------------------------------------------------- #
def annotate_neighborhoods(membership: spmatrix, cell_type: ArrayLike):
    """Majority cell-type label (and its purity) for each neighborhood.

    BIOLOGICAL CONTEXT
        DA results are read by cell type: "which cell types shifted?" The majority
        label lets the beeswarm group neighborhoods by identity.
    COMPUTATIONAL APPROACH
        Composition per neighborhood via ``membership @ onehot``; take the argmax
        type and its fraction.

    Returns
    -------
    annotation       (M,) majority cell-type per neighborhood.
    annotation_frac  (M,) fraction of that type (purity).
    """
    cell_type = np.asarray(cell_type)                     # cell_type = (n_cells,) type per cell
    cats, codes = np.unique(cell_type, return_inverse=True)  # cats = type names; codes = per-cell code
    n = cell_type.shape[0]                                # n = number of cells
    onehot = csr_matrix(                                  # onehot = (n_cells, n_types) indicator
        (np.ones(n, dtype=np.float32), (np.arange(n), codes)), shape=(n, cats.shape[0])
    )
    comp = np.asarray((membership @ onehot).todense(), dtype=float)  # comp = (M, n_types) counts
    comp = comp / comp.sum(axis=1, keepdims=True)         # comp -> proportions per neighborhood
    top = comp.argmax(axis=1)                             # top = majority type code per neighborhood
    annotation = cats[top]                                # annotation = majority type name
    annotation_frac = comp[np.arange(comp.shape[0]), top]  # purity of the majority type
    return annotation, annotation_frac


# --------------------------------------------------------------------------- #
# Orchestrator (array interface)
# --------------------------------------------------------------------------- #
def milo(
    embedding: np.ndarray,
    sample: ArrayLike,
    condition: ArrayLike,
    *,
    cell_type: Optional[ArrayLike] = None,
    k: int = 30,
    prop: float = 0.1,
    refine: bool = True,
    prior_count: float = 1.0,
    random_state: int = 0,
) -> MiloResult:
    """Run the full Milo DA pipeline on arrays.

    BIOLOGICAL CONTEXT
        Given an embedding, a per-cell sample id, and a per-cell condition label,
        find neighborhoods whose cell abundance differs between the two conditions.
    COMPUTATIONAL APPROACH
        Chains steps 1-6. `condition` and `sample` are per-CELL; the design is
        collapsed to one condition value per sample internally.

    Parameters
    ----------
    embedding    (n_cells, n_dims) low-dim representation.
    sample       (n_cells,) biological replicate id per cell.
    condition    (n_cells,) two-level condition label per cell.
    cell_type    (n_cells,) optional labels for annotating/grouping neighborhoods.
    k            KNN size.
    prop         fraction of cells sampled as neighborhood seeds.
    refine       use Milo's index-cell refinement.
    prior_count  pseudocount stabilizing sparse-neighborhood fold-changes.
    random_state seed.
    """
    emb = np.asarray(embedding, dtype=float)              # emb = embedding coordinates
    sample = np.asarray(sample)                           # sample = per-cell sample id
    condition = np.asarray(condition)                     # condition = per-cell condition label

    knn_idx, knn_dist = build_knn_graph(emb, k=k)         # step 1: KNN graph
    index_cells, membership = make_neighborhoods(         # step 2: neighborhoods
        emb, knn_idx, prop=prop, refine=refine, random_state=random_state
    )
    counts, sample_order = count_cells(membership, sample)  # step 3: count matrix

    # collapse per-cell condition to one value per sample (order matches columns)
    cond_per_sample = np.array([                          # cond_per_sample = condition of each sample
        condition[sample == s][0] for s in sample_order
    ])
    logFC, pval = test_da(counts, cond_per_sample, prior_count=prior_count)  # step 4: GLM test

    kth_dist = knn_dist[index_cells, -1]                  # kth_dist = distance to k-th NN of each index cell
    weights = 1.0 / np.maximum(kth_dist, 1e-12)           # weights = density proxy (reciprocal distance)
    fdr = spatial_fdr(pval, weights)                      # step 5: overlap-aware FDR

    annotation = annotation_frac = None                   # default: no annotation
    if cell_type is not None:                             # step 6: annotate if labels provided
        annotation, annotation_frac = annotate_neighborhoods(membership, cell_type)

    nhood_size = np.asarray(membership.sum(axis=1)).ravel()  # nhood_size = cells per neighborhood

    return MiloResult(
        index_cells=index_cells,
        membership=membership,
        counts=counts,
        sample_order=sample_order,
        logFC=logFC,
        pvalue=pval,
        fdr=fdr,
        nhood_size=nhood_size,
        annotation=annotation,
        annotation_frac=annotation_frac,
        params={"k": k, "prop": prop, "refine": refine,
                "prior_count": prior_count, "random_state": random_state,
                "condition_levels": list(np.unique(condition))},
    )


# --------------------------------------------------------------------------- #
# AnnData wrapper
# --------------------------------------------------------------------------- #
def milo_adata(
    adata,
    sample_key: str,
    condition_key: str,
    *,
    use_rep: str = "X_pca",
    cell_type_key: Optional[str] = None,
    k: int = 30,
    prop: float = 0.1,
    refine: bool = True,
    prior_count: float = 1.0,
    random_state: int = 0,
    key_added: str = "milo",
) -> MiloResult:
    """Run Milo on an AnnData; store the neighborhood-level results in ``.uns``.

    COMPUTATIONAL APPROACH
        Pull the embedding from ``adata.obsm[use_rep]`` and labels from
        ``adata.obs``; call ``milo``; write a per-neighborhood results DataFrame to
        ``adata.uns[key_added]`` (neighborhoods are not cells, so results live in
        ``.uns`` rather than ``.obs``).
    """
    emb = np.asarray(adata.obsm[use_rep])                 # emb = embedding from obsm
    sample = np.asarray(adata.obs[sample_key].values)     # sample = per-cell sample id
    condition = np.asarray(adata.obs[condition_key].values)  # condition = per-cell condition
    cell_type = (np.asarray(adata.obs[cell_type_key].values)  # cell_type = optional labels
                 if cell_type_key is not None else None)
    res = milo(emb, sample, condition, cell_type=cell_type, k=k, prop=prop,
               refine=refine, prior_count=prior_count, random_state=random_state)
    adata.uns[key_added] = {                              # store neighborhood-level results table
        "results": pd.DataFrame({
            "index_cell": res.index_cells,
            "logFC": res.logFC,
            "pvalue": res.pvalue,
            "spatial_fdr": res.fdr,
            "nhood_size": res.nhood_size,
            "annotation": res.annotation if res.annotation is not None else np.nan,
        }),
        "params": res.params,
    }
    return res


# --------------------------------------------------------------------------- #
# Synthetic data + demo
# --------------------------------------------------------------------------- #
def make_synthetic_da(seed: int = 1, n_per_sample: int = 1200):
    """Two conditions over a 1-D trajectory with a planted abundance gradient.

    BIOLOGICAL CONTEXT
        Condition B cells concentrate at the high end of a trajectory, A at the
        low end — a continuous DA shift that cluster-level testing would blur.
    COMPUTATIONAL APPROACH
        Draw each sample's cells' latent positions from a condition-dependent Beta
        distribution; embed as position + jitter. Samples 0-2 = condition A,
        3-5 = condition B.

    Returns embedding, sample, condition, position (ground truth).
    """
    rng = np.random.default_rng(seed)                     # rng = seeded RNG
    pos_list, samp_list, cond_list = [], [], []           # accumulators
    for sid in range(6):                                  # sid = sample id (0-5)
        is_B = sid >= 3                                   # is_B = True for condition-B samples
        a, b = (2.5, 1.2) if is_B else (1.2, 2.5)         # Beta shape: B skews high, A skews low
        p = rng.beta(a, b, n_per_sample)                  # p = latent positions for this sample
        pos_list.append(p)
        samp_list.append(np.full(n_per_sample, sid))      # sample id per cell
        cond_list.append(np.full(n_per_sample, "B" if is_B else "A"))  # condition per cell
    pos = np.concatenate(pos_list)                        # pos = all latent positions
    sample = np.concatenate(samp_list)                    # sample = all sample ids
    condition = np.concatenate(cond_list)                 # condition = all condition labels
    emb = pos[:, None] + rng.normal(0, 0.005, (pos.shape[0], 1))  # emb = 1-D embedding with jitter
    return emb, sample, condition, pos


def _demo():
    """Recover the planted abundance gradient and report detection by region."""
    emb, sample, condition, pos = make_synthetic_da()     # synthetic data with known gradient
    res = milo(emb, sample, condition, k=30, prop=0.15, random_state=0)  # run Milo
    pos_of_nhood = pos[res.index_cells]                   # position of each neighborhood's index cell
    sig = res.fdr < 0.1                                   # sig = significant at 10% spatial FDR
    hi = pos_of_nhood > 0.8                               # hi = neighborhoods at trajectory high end
    lo = pos_of_nhood < 0.2                               # lo = neighborhoods at low end
    mid = (pos_of_nhood > 0.45) & (pos_of_nhood < 0.55)   # mid = middle (null) neighborhoods
    print(f"neighborhoods: {res.n_neighborhoods}")
    print(f"high end  mean logFC {res.logFC[hi].mean():+.2f}  "
          f"significant {100*sig[hi].mean():.0f}%  (expect + and enriched in B)")
    print(f"low end   mean logFC {res.logFC[lo].mean():+.2f}  "
          f"significant {100*sig[lo].mean():.0f}%  (expect - and enriched in A)")
    print(f"middle    mean logFC {res.logFC[mid].mean():+.2f}  "
          f"significant {100*sig[mid].mean():.0f}%  (expect ~0, few significant)")


if __name__ == "__main__":
    _demo()
