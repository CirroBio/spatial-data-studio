"""Identify Regions (Leiden) — cluster cells on their spatial coordinates and
write the cluster index to a user-named obs column."""
from __future__ import annotations

from ..base import Function, ParamSpec, CallResult, run_compute, resolve_obsm_key
from ._leiden import leiden_labels, resolve_connectivities

_DOC = """Identify Regions (Leiden)

Run Leiden community detection on a nearest-neighbour graph built directly from
the spatial coordinates, and store the resulting cluster index as a categorical
label in a new obs column.

Parameters
----------
coords
    obsm key holding the coordinates to cluster on (default: spatial).
n_neighbors
    Size of the local neighbourhood used to build the kNN graph.
resolution
    Leiden resolution; higher values yield more, smaller regions.
random_state
    Seed for reproducible clustering.
key_added
    Name of the obs column to write the region labels into.
"""


from ._docs import custom_doc

_CITATION = ("Leiden community detection (Traag, Waltman & van Eck, Sci Rep 9:5233, 2019) applied "
             "to spatial coordinates; spatial-region variant original to this repository.")
_DOC = custom_doc("identify-regions-leiden")


class IdentifyRegionsLeiden(Function):
    source = "custom"
    key = "custom.identify_regions_leiden"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "identify_regions_leiden"
    effect_class = "compute"
    label = "Identify Regions (Leiden)"
    summary = "Leiden clustering on spatial coordinates into a new obs column."
    doc = _DOC
    partially_supported = False
    unsupported_params: list = []

    params = [
        ParamSpec("coords", {"type": "string", "default": "spatial"}, "obsm_key", "obsm",
                  required=False, tooltip="obsm key of the coordinates to cluster on"),
        ParamSpec("n_neighbors", {"type": "integer", "default": 15}, "number", None,
                  required=False, tooltip="neighbourhood size for the kNN graph"),
        ParamSpec("resolution", {"type": "number", "default": 1.0}, "number", None,
                  required=False, tooltip="higher = more, smaller regions"),
        ParamSpec("random_state", {"type": "integer", "default": 0}, "number", None,
                  required=False, tooltip="random seed"),
        ParamSpec("key_added", {"type": "string", "default": "leiden_spatial"}, "text", None,
                  required=True, tooltip="obs column to write region labels into", role="output"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        import scanpy as sc

        key_added = (params.get("key_added") or "leiden_spatial").strip()
        n_neighbors = int(params.get("n_neighbors") or 15)
        resolution = float(params.get("resolution") or 1.0)
        random_state = int(params.get("random_state") or 0)

        adata = session.active_table()
        try:
            coords = resolve_obsm_key(adata, params)
        except KeyError as e:
            return CallResult(status="failed", error=f"obsm['{e.args[0]}'] does not exist")

        neighbors_key = f"_{key_added}_neighbors"

        def mutate(ad):
            sc.pp.neighbors(ad, n_neighbors=n_neighbors, use_rep=coords,
                            random_state=random_state, key_added=neighbors_key)
            conn = resolve_connectivities(ad, neighbors_key)
            ad.obs[key_added] = leiden_labels(conn, resolution=resolution,
                                              random_state=random_state, n_iterations=2)

        return run_compute(session, mutate)
