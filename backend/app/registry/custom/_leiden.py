"""Leiden partitioning on a scanpy neighbours graph, via the MIT
graspologic-native Rust core. Replaces scanpy's `sc.tl.leiden`, whose only
backends (python-igraph, leidenalg) are GPL. Shared by the general Leiden
clustering function (`custom.leiden`) and the spatial Identify-Regions function.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def resolve_connectivities(adata, neighbors_key: str | None = None):
    """Return the connectivities CSR matrix scanpy's neighbours step stored,
    mirroring scanpy's `neighbors_key` resolution: with a key the matrix lives at
    ``obsp[uns[key]['connectivities_key']]``; without, at ``obsp['connectivities']``.
    Raises KeyError(missing_key) so callers can build their own failure result."""
    if neighbors_key:
        if neighbors_key not in adata.uns:
            raise KeyError(neighbors_key)
        conn_key = adata.uns[neighbors_key]["connectivities_key"]
    else:
        conn_key = "connectivities"
    if conn_key not in adata.obsp:
        raise KeyError(conn_key)
    return adata.obsp[conn_key]


def leiden_labels(connectivities, resolution: float = 1.0, random_state: int = 0,
                  n_iterations: int = 2) -> pd.Categorical:
    """Run Leiden on a neighbours graph, returning a scanpy-style Categorical of
    string cluster labels ("0", "1", …) with categories ordered by cluster id."""
    import graspologic_native as gn

    conn = connectivities.tocsr()
    conn = conn.maximum(conn.T)  # graspologic requires an undirected (symmetric) graph
    _, partition = gn.leiden_csr(
        conn.indptr.astype(np.int64), conn.indices.astype(np.int32),
        conn.data.astype(np.float64), conn.shape[0],
        resolution=float(resolution), seed=int(random_state),
        iterations=max(1, int(n_iterations)))
    labels = [partition[i] for i in range(conn.shape[0])]
    categories = [str(c) for c in sorted(set(labels))]
    return pd.Categorical([str(x) for x in labels], categories=categories)
