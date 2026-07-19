"""
proximity_compute.py
====================

COMPUTATION for a nearest-neighbor cell-type PROXIMITY / AVOIDANCE test on spatial
data. Plotting lives in ``proximity_plot.py``.

------------------------------------------------------------------------------
BIOLOGICAL CONTEXT
------------------------------------------------------------------------------
A recurring spatial question: are cells of type A physically closer to (or farther
from) cells of type B than expected by chance? "Closer" suggests interaction or
recruitment (e.g. CD8 T cells hugging tumor cells); "farther" suggests exclusion
(e.g. T cells kept out of a tumor nest). The natural statistic is the distance
from each A cell to its NEAREST B cell, summarized and compared to a null in which
cell-type labels are shuffled.

WHY THIS FILE EXISTS: squidpy provides ``nhood_enrichment`` (permutation test on
GRAPH EDGE counts) and ``co_occurrence`` (co-occurrence PROBABILITY across distance
bins), but neither is a nearest-neighbor-DISTANCE test. This fills that gap and is
complementary: it works directly in microns and reports an interpretable "closer /
farther than chance" effect per ordered cell-type pair.

------------------------------------------------------------------------------
COMPUTATIONAL APPROACH
------------------------------------------------------------------------------
  1. For each ordered pair (A -> B), compute the summary (median by default) of the
     distance from every A cell to its nearest B cell, using a KD-tree per type.
  2. Build a null by permuting the cell-type labels many times (WITHIN each sample
     if a batch key is given) and recomputing the same statistic.
  3. Report a z-score (observed - null mean) / null sd and an empirical two-sided
     p-value per pair. Negative z = closer than chance (attraction); positive z =
     farther (avoidance).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Sequence, Union

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

ArrayLike = Union[np.ndarray, Sequence]


@dataclass
class ProximityResult:
    """Proximity-test outputs, for handoff to proximity_plot."""

    categories: list                 # ordered cell-type names (matrix axes)
    observed: np.ndarray             # (T, T) observed nearest-neighbor distance stat
    zscore: np.ndarray               # (T, T) (observed - null mean) / null sd
    pvalue: np.ndarray               # (T, T) empirical two-sided p-value
    null_mean: np.ndarray            # (T, T) mean statistic under permutation
    null_std: np.ndarray             # (T, T) sd of statistic under permutation
    distances: dict                  # {(A, B): array of A->nearest-B distances} observed
    params: dict = field(default_factory=dict)

    def as_frame(self, which: str = "zscore") -> pd.DataFrame:
        """Return one of the (T, T) matrices as a labeled DataFrame."""
        mat = getattr(self, which)                        # mat = the requested matrix
        return pd.DataFrame(mat, index=self.categories, columns=self.categories)


# --------------------------------------------------------------------------- #
# Nearest-neighbor distance statistic
# --------------------------------------------------------------------------- #
def _pair_statistic(coords, labels, categories, stat="median"):
    """(T, T) matrix of A->nearest-B distance summaries plus raw A->B distances.

    COMPUTATIONAL APPROACH
        One KD-tree per cell type; for each source type A, query every A cell for
        its nearest B cell (k=2 and drop self when A == B). Summarize with median
        or mean.
    """
    T = len(categories)                                   # T = number of cell types
    mat = np.full((T, T), np.nan)                         # mat = (T, T) statistic matrix
    dist_store = {}                                       # dist_store = raw distances per (A, B)
    trees = {                                             # trees = KD-tree per non-empty type
        c: cKDTree(coords[labels == c])
        for c in categories if np.any(labels == c)
    }
    for i, a in enumerate(categories):                    # i, a = source type index/name
        A = coords[labels == a]                           # A = coordinates of type-A cells
        if A.shape[0] == 0:                               # skip absent source type
            continue
        for j, b in enumerate(categories):                # j, b = target type index/name
            if b not in trees:                            # skip absent target type
                continue
            kq = 2 if a == b else 1                        # query 2 NNs for self-pairs (to drop self)
            d, _ = trees[b].query(A, k=kq)                # d = nearest-B distance(s) for each A cell
            d = d[:, 1] if a == b else np.asarray(d).ravel()  # drop self column when A == B
            mat[i, j] = np.median(d) if stat == "median" else np.mean(d)  # summarize
            dist_store[(a, b)] = d                        # keep raw distances for plotting
    return mat, dist_store


# --------------------------------------------------------------------------- #
# Orchestrator (array interface)
# --------------------------------------------------------------------------- #
def proximity_test(
    coords: np.ndarray,
    labels: ArrayLike,
    *,
    n_perm: int = 500,
    stat: str = "median",
    batch: Optional[ArrayLike] = None,
    random_state: int = 0,
) -> ProximityResult:
    """Nearest-neighbor proximity / avoidance test between all cell-type pairs.

    BIOLOGICAL CONTEXT
        For every ordered pair (A -> B), test whether A cells sit closer to /
        farther from B cells than random labeling would produce.
    COMPUTATIONAL APPROACH
        Observed statistic vs. a label-permutation null (permuted within `batch`
        if given). z-score and empirical two-sided p-value per pair.

    Parameters
    ----------
    coords        (n_cells, 2 or 3) spatial coordinates.
    labels        (n_cells,) cell-type labels.
    n_perm        number of label permutations for the null.
    stat          "median" (robust) or "mean".
    batch         (n_cells,) sample ids; labels are permuted within each sample.
    random_state  seed.
    """
    coords = np.asarray(coords, dtype=float)              # coords = spatial coordinates
    labels = np.asarray(labels)                           # labels = cell-type per cell
    categories = list(np.unique(labels))                  # categories = ordered cell-type names
    rng = np.random.default_rng(random_state)             # rng = seeded RNG for permutations
    batch = None if batch is None else np.asarray(batch)  # batch = sample id per cell (or None)

    observed, dist_store = _pair_statistic(coords, labels, categories, stat)  # observed statistic

    T = len(categories)                                   # T = number of cell types
    null = np.full((n_perm, T, T), np.nan)                # null = permutation statistics
    for p in range(n_perm):                               # p = permutation index
        if batch is None:                                 # global label shuffle
            perm = rng.permutation(labels)                # perm = shuffled labels
        else:                                             # within-sample label shuffle
            perm = labels.copy()                          # perm = start from real labels
            for s in np.unique(batch):                    # s = one sample id
                m = batch == s                            # m = cells in sample s
                perm[m] = rng.permutation(labels[m])      # shuffle labels only within the sample
        null[p], _ = _pair_statistic(coords, perm, categories, stat)  # null statistic for this perm

    null_mean = np.nanmean(null, axis=0)                  # null_mean = mean statistic under null
    null_std = np.nanstd(null, axis=0) + 1e-12            # null_std = sd under null (guarded)
    zscore = (observed - null_mean) / null_std            # zscore = signed effect (neg = closer)
    # empirical two-sided p: fraction of null as/more extreme than observed
    more_extreme = np.nansum(                             # more_extreme = null count beyond observed
        np.abs(null - null_mean[None]) >= np.abs(observed - null_mean)[None], axis=0
    )
    pvalue = (more_extreme + 1) / (n_perm + 1)            # pvalue = empirical two-sided p (add-one)

    return ProximityResult(
        categories=categories,
        observed=observed,
        zscore=zscore,
        pvalue=pvalue,
        null_mean=null_mean,
        null_std=null_std,
        distances=dist_store,
        params={"n_perm": n_perm, "stat": stat, "random_state": random_state,
                "batched": batch is not None},
    )


# --------------------------------------------------------------------------- #
# AnnData wrapper
# --------------------------------------------------------------------------- #
def proximity_adata(
    adata,
    cell_type_key: str,
    *,
    spatial_key: str = "spatial",
    library_key: Optional[str] = None,
    n_perm: int = 500,
    stat: str = "median",
    random_state: int = 0,
    key_added: str = "proximity",
) -> ProximityResult:
    """Run the proximity test on an AnnData; store matrices in ``.uns``.

    COMPUTATIONAL APPROACH
        Pull coordinates from ``adata.obsm[spatial_key]`` and labels from
        ``adata.obs``; permute within ``library_key`` if given; write z-score and
        p-value DataFrames to ``adata.uns[key_added]``.
    """
    coords = np.asarray(adata.obsm[spatial_key])          # coords = spatial coordinates
    labels = np.asarray(adata.obs[cell_type_key].values)  # labels = cell-type per cell
    batch = np.asarray(adata.obs[library_key].values) if library_key else None  # sample ids
    res = proximity_test(coords, labels, n_perm=n_perm, stat=stat,
                         batch=batch, random_state=random_state)
    adata.uns[key_added] = {                              # store labeled result matrices
        "zscore": res.as_frame("zscore"),
        "pvalue": res.as_frame("pvalue"),
        "observed": res.as_frame("observed"),
        "params": res.params,
    }
    return res


# --------------------------------------------------------------------------- #
# Synthetic data + demo
# --------------------------------------------------------------------------- #
def make_synthetic_spatial(seed: int = 0, n: int = 800):
    """Tissue where types A and B co-localize and type C is spatially separate.

    BIOLOGICAL CONTEXT
        A and B interact (should score as mutual attraction); C sits in its own
        territory (should score as avoidance vs. A and B).
    COMPUTATIONAL APPROACH
        A and B share a Gaussian cloud at the origin; C is a distant cloud.

    Returns (coords, labels).
    """
    rng = np.random.default_rng(seed)                     # rng = seeded RNG
    A = rng.normal([0, 0], 1.0, (n, 2))                   # A = cloud at origin
    B = rng.normal([0, 0], 1.0, (n, 2))                   # B = overlapping cloud at origin
    C = rng.normal([20, 20], 1.0, (n, 2))                 # C = distant cloud
    coords = np.vstack([A, B, C])                         # coords = all coordinates
    labels = np.array(["A"] * n + ["B"] * n + ["C"] * n)  # labels = cell types
    return coords, labels


def _demo():
    """Recover A-B attraction and C avoidance from synthetic tissue."""
    coords, labels = make_synthetic_spatial()             # synthetic tissue with known structure
    res = proximity_test(coords, labels, n_perm=200, random_state=0)  # run the test
    print("Proximity z-scores (negative = closer than chance):")
    print(res.as_frame("zscore").round(1).to_string())
    print("\nEmpirical p-values:")
    print(res.as_frame("pvalue").round(3).to_string())


if __name__ == "__main__":
    _demo()
