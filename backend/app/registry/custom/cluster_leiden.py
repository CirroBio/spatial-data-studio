"""Leiden clustering — community detection on the expression neighbours graph
(the graph produced by sc.pp.neighbors), written to a new obs column.

Drop-in for scanpy's sc.tl.leiden, whose GPL backends (igraph/leidenalg) this
app does not ship; the partitioning runs on the MIT graspologic-native core.
"""
from __future__ import annotations

from ..base import Function, ParamSpec, CallResult, run_compute
from ._leiden import leiden_labels, resolve_connectivities

_DOC = """Leiden clustering

Run Leiden community detection on the nearest-neighbour graph built by
`sc.pp.neighbors` (obsp['connectivities']) and store the cluster index as a
categorical label in a new obs column. Run `sc.pp.neighbors` first.

Parameters
----------
resolution
    Higher values yield more, smaller clusters.
n_iterations
    Number of Leiden refinement iterations over the graph.
random_state
    Seed for reproducible clustering.
neighbors_key
    uns key of a specific neighbours graph to cluster on; empty uses the
    standard obsp['connectivities'].
key_added
    Name of the obs column to write cluster labels into.
"""


from ._docs import custom_doc

_CITATION = ("Traag, V.A., Waltman, L. & van Eck, N.J. From Louvain to Leiden: guaranteeing "
             "well-connected communities. Sci Rep 9, 5233 (2019). doi:10.1038/s41598-019-41695-z "
             "(partitioning via graspologic, MIT).")
_DOC = custom_doc("leiden-clustering")


class ClusterLeiden(Function):
    source = "custom"
    key = "custom.leiden"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "leiden"
    effect_class = "compute"
    label = "Leiden clustering"
    summary = "Leiden community detection on the neighbours graph into a new obs column."
    doc = _DOC
    partially_supported = False
    unsupported_params: list = []

    params = [
        ParamSpec("resolution", {"type": "number", "default": 1.0}, "number", None,
                  required=False, tooltip="higher = more, smaller clusters"),
        ParamSpec("n_iterations", {"type": "integer", "default": 2}, "number", None,
                  required=False, tooltip="Leiden refinement iterations"),
        ParamSpec("random_state", {"type": "integer", "default": 0}, "number", None,
                  required=False, tooltip="random seed"),
        ParamSpec("neighbors_key", {"type": "string", "default": ""}, "text", None,
                  required=False, tooltip="uns key of a specific neighbours graph (empty = the standard one)"),
        ParamSpec("key_added", {"type": "string", "default": "leiden"}, "text", None,
                  required=True, tooltip="obs column to write cluster labels into", role="output"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        key_added = (params.get("key_added") or "leiden").strip()
        resolution = float(params.get("resolution") or 1.0)
        random_state = int(params.get("random_state") or 0)
        n_iterations = int(params.get("n_iterations") or 2)
        neighbors_key = (params.get("neighbors_key") or "").strip() or None

        adata = session.active_table()
        try:
            conn = resolve_connectivities(adata, neighbors_key)
        except KeyError as e:
            return CallResult(status="failed",
                              error=f"neighbours graph '{e.args[0]}' not found — run sc.pp.neighbors first")

        def mutate(ad):
            ad.obs[key_added] = leiden_labels(conn, resolution=resolution,
                                              random_state=random_state, n_iterations=n_iterations)

        return run_compute(session, mutate)
