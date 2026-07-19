"""
lisi_compute.py
===============

COMPUTATION of the Local Inverse Simpson's Index (LISI). Plotting lives in
``lisi_plot.py``.

------------------------------------------------------------------------------
BIOLOGICAL CONTEXT
------------------------------------------------------------------------------
After integrating single-cell datasets (Harmony, scVI, Scanorama...), you need to
ask two things: did batches actually mix, and did distinct cell types stay
separate? LISI (Korsunsky et al., Nat Methods 2019) answers both with one local
diversity score per cell: the *effective number of categories* in that cell's
neighborhood.
  * iLISI (LISI on BATCH labels): ~1 = the cell sits among a single batch (bad
    mixing); ~B = neighborhood spans all B batches (good mixing).
  * cLISI (LISI on CELL-TYPE labels): ~1 = neighborhood is one cell type (good,
    types stayed distinct); high = types are blended (over-correction).

WHY THIS FILE EXISTS: LISI lives in scib / scib-metrics / harmonypy, not in
``scanpy`` or ``squidpy``. This is a standalone numpy/scipy/scikit-learn version.

------------------------------------------------------------------------------
COMPUTATIONAL APPROACH
------------------------------------------------------------------------------
For each cell: take its neighbors in an embedding, build a Gaussian kernel over
their distances whose bandwidth is tuned so the neighborhood's *perplexity*
(effective size) hits a target (default 30) via t-SNE-style binary search on the
entropy; convert kernel weights to a probability distribution over label
categories; LISI = 1 / sum_c p(c)^2 (inverse Simpson). Optionally rescale to
[0, 1] for cross-dataset comparability (Luecken et al. convention).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Sequence, Union

import numpy as np
import pandas as pd
from sklearn.neighbors import NearestNeighbors

ArrayLike = Union[np.ndarray, Sequence]


@dataclass
class LISIResult:
    """Per-cell LISI scores plus summaries, for handoff to lisi_plot."""

    scores: dict                     # {label_name: (n_cells,) LISI per cell}
    n_categories: dict               # {label_name: number of categories}
    summary: pd.DataFrame            # per-label median LISI (raw and normalized)
    perplexity: float                # effective neighborhood size used
    params: dict = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Perplexity-calibrated neighbor weights (t-SNE style)
# --------------------------------------------------------------------------- #
def _perplexity_weights(dist_row, perplexity, *, tol=1e-5, max_iter=50):
    """Gaussian kernel weights over one cell's neighbor distances at target perplexity.

    COMPUTATIONAL APPROACH
        Binary search the kernel precision beta so the Shannon entropy of the
        weight distribution equals log(perplexity); return normalized weights.
    """
    D = np.asarray(dist_row, dtype=float)                 # D = distances to this cell's neighbors
    beta = 1.0                                            # beta = kernel precision (1/2 sigma^2 scale)
    lo, hi = -np.inf, np.inf                              # lo/hi = binary-search bracket on beta
    logU = np.log(perplexity)                             # logU = target entropy = log(perplexity)
    P = np.exp(-D * beta)                                 # P = unnormalized kernel weights
    for _ in range(max_iter):
        sumP = P.sum() or 1e-12                           # sumP = normalizer (guard against 0)
        H = np.log(sumP) + beta * np.sum(D * P) / sumP    # H = entropy of the weight distribution
        diff = H - logU                                   # diff = distance from target entropy
        if abs(diff) < tol:                               # converged
            break
        if diff > 0:                                      # entropy too high -> increase precision
            lo = beta
            beta = beta * 2 if hi == np.inf else (beta + hi) / 2
        else:                                             # entropy too low -> decrease precision
            hi = beta
            beta = beta / 2 if lo == -np.inf else (beta + lo) / 2
        P = np.exp(-D * beta)                             # recompute weights with new beta
    sumP = P.sum() or 1e-12                               # final normalizer
    return P / sumP                                       # return probability weights over neighbors


# --------------------------------------------------------------------------- #
# Core: per-cell LISI for one label set
# --------------------------------------------------------------------------- #
def compute_lisi(embedding: np.ndarray, labels: ArrayLike, *, perplexity: float = 30.0):
    """Per-cell LISI for a single categorical label.

    BIOLOGICAL CONTEXT
        Returns, for each cell, the effective number of label categories in its
        local neighborhood.
    COMPUTATIONAL APPROACH
        KNN (k = 3*perplexity) in the embedding; per cell, perplexity-calibrated
        kernel weights -> label probabilities -> inverse Simpson index.

    Returns (n_cells,) LISI scores.
    """
    emb = np.asarray(embedding, dtype=float)              # emb = (n_cells, n_dims) embedding
    labels = np.asarray(labels)                           # labels = (n_cells,) category per cell
    cats, codes = np.unique(labels, return_inverse=True)  # cats = category names; codes = per-cell code
    n = emb.shape[0]                                      # n = number of cells
    k = int(min(n - 1, 3 * perplexity))                   # k = neighbors to consider
    nn = NearestNeighbors(n_neighbors=k + 1).fit(emb)     # nn = fitted index (+1 to drop self)
    dist, ind = nn.kneighbors(emb)                        # dist/ind = neighbor distances/indices
    dist, ind = dist[:, 1:], ind[:, 1:]                   # drop the self column
    out = np.empty(n)                                     # out = LISI per cell
    n_cats = cats.shape[0]                                # n_cats = number of categories
    for i in range(n):                                    # i = cell index
        w = _perplexity_weights(dist[i], perplexity)      # w = calibrated neighbor weights
        p = np.zeros(n_cats)                              # p = probability mass per category
        np.add.at(p, codes[ind[i]], w)                    # accumulate weights into category bins
        out[i] = 1.0 / np.sum(p ** 2)                     # inverse Simpson index
    return out


# --------------------------------------------------------------------------- #
# Orchestrator
# --------------------------------------------------------------------------- #
def lisi_scores(
    embedding: np.ndarray,
    *,
    batch: Optional[ArrayLike] = None,
    label: Optional[ArrayLike] = None,
    perplexity: float = 30.0,
) -> LISIResult:
    """Compute iLISI (batch) and/or cLISI (cell type) for an embedding.

    BIOLOGICAL CONTEXT
        Run with `batch` to score mixing (higher = better) and `label` to score
        cell-type separation (lower = better). Both are diagnostics of an
        integration.
    COMPUTATIONAL APPROACH
        Call compute_lisi per provided label set; also report a normalized score
        in [0, 1]: iLISI -> (LISI-1)/(B-1) (1 = perfectly mixed), cLISI ->
        (C-LISI)/(C-1) (1 = perfectly separated).

    Parameters
    ----------
    embedding   (n_cells, n_dims) representation to evaluate.
    batch       (n_cells,) batch labels for iLISI.
    label       (n_cells,) cell-type labels for cLISI.
    perplexity  effective neighborhood size.
    """
    emb = np.asarray(embedding, dtype=float)              # emb = embedding
    scores, n_categories, rows = {}, {}, []               # accumulators for outputs

    if batch is not None:                                 # iLISI on batch labels
        b = np.asarray(batch)                             # b = batch label per cell
        B = np.unique(b).shape[0]                         # B = number of batches
        s = compute_lisi(emb, b, perplexity=perplexity)   # s = per-cell iLISI
        scores["iLISI"] = s
        n_categories["iLISI"] = B
        norm = (np.median(s) - 1) / max(B - 1, 1)         # norm = mixing in [0,1] (1 = well mixed)
        rows.append(("iLISI", B, float(np.median(s)), float(np.clip(norm, 0, 1))))

    if label is not None:                                 # cLISI on cell-type labels
        l = np.asarray(label)                             # l = cell-type label per cell
        C = np.unique(l).shape[0]                         # C = number of cell types
        s = compute_lisi(emb, l, perplexity=perplexity)   # s = per-cell cLISI
        scores["cLISI"] = s
        n_categories["cLISI"] = C
        norm = (C - np.median(s)) / max(C - 1, 1)         # norm = separation in [0,1] (1 = separated)
        rows.append(("cLISI", C, float(np.median(s)), float(np.clip(norm, 0, 1))))

    summary = pd.DataFrame(                               # summary = per-label median + normalized
        rows, columns=["metric", "n_categories", "median_LISI", "normalized"]
    )
    return LISIResult(scores=scores, n_categories=n_categories, summary=summary,
                      perplexity=perplexity, params={"perplexity": perplexity})


# --------------------------------------------------------------------------- #
# AnnData wrapper
# --------------------------------------------------------------------------- #
def lisi_adata(
    adata,
    *,
    use_rep: str = "X_pca",
    batch_key: Optional[str] = None,
    label_key: Optional[str] = None,
    perplexity: float = 30.0,
    key_added: str = "lisi",
) -> LISIResult:
    """Compute LISI on an AnnData; write per-cell scores to ``.obs`` and summary to ``.uns``.

    COMPUTATIONAL APPROACH
        Pull the embedding from ``adata.obsm[use_rep]`` and labels from
        ``adata.obs``; store per-cell iLISI/cLISI in ``adata.obs`` and the summary
        table in ``adata.uns[key_added]``.
    """
    emb = np.asarray(adata.obsm[use_rep])                 # emb = embedding from obsm
    batch = np.asarray(adata.obs[batch_key].values) if batch_key else None  # batch labels
    label = np.asarray(adata.obs[label_key].values) if label_key else None  # cell-type labels
    res = lisi_scores(emb, batch=batch, label=label, perplexity=perplexity)
    for name, s in res.scores.items():                    # write each per-cell score to obs
        adata.obs[f"{key_added}_{name}"] = s
    adata.uns[key_added] = {"summary": res.summary, "params": res.params}
    return res


# --------------------------------------------------------------------------- #
# Synthetic data + demo
# --------------------------------------------------------------------------- #
def make_synthetic_integration(seed: int = 0, n: int = 1500):
    """Two batches x two cell types, in a WELL-MIXED and a POORLY-MIXED embedding.

    BIOLOGICAL CONTEXT
        Emulates a good integration (batches overlap, types separate) and a failed
        one (batches form their own islands), with known expected LISI behavior.
    COMPUTATIONAL APPROACH
        Two cell-type clusters; in the mixed embedding both batches occupy each
        cluster; in the unmixed embedding each batch is shifted apart.

    Returns (emb_mixed, emb_unmixed, batch, cell_type).
    """
    rng = np.random.default_rng(seed)                     # rng = seeded RNG
    ct = np.array(["T", "B"])                             # ct = two cell types
    cell_type = np.repeat(ct, n)                          # cell_type = n T cells then n B cells
    batch = np.tile(np.repeat(["b1", "b2"], n // 2), 2)   # batch = alternating batch labels
    centers = {"T": np.array([0, 0]), "B": np.array([8, 0])}  # centers = per-type cluster centers
    base = np.vstack([rng.normal(centers[t], 1.0, (n, 2)) for t in ct])  # base = type-clustered points
    emb_mixed = base.copy()                               # emb_mixed = batches overlap within types
    shift = np.where(batch == "b2", 1, -1)[:, None] * np.array([0, 4])  # per-batch displacement
    emb_unmixed = base + shift                            # emb_unmixed = batches pulled apart
    return emb_mixed, emb_unmixed, batch, cell_type


def _demo():
    """Show iLISI/cLISI distinguish a good integration from a batch-confounded one."""
    emb_mixed, emb_unmixed, batch, cell_type = make_synthetic_integration()
    good = lisi_scores(emb_mixed, batch=batch, label=cell_type, perplexity=30)
    bad = lisi_scores(emb_unmixed, batch=batch, label=cell_type, perplexity=30)
    print("Well-mixed embedding (expect iLISI->2, cLISI->1):")
    print(good.summary.to_string(index=False))
    print("\nBatch-confounded embedding (expect iLISI->1):")
    print(bad.summary.to_string(index=False))


if __name__ == "__main__":
    _demo()
