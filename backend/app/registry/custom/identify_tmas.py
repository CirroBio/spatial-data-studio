"""Identify TMAs — automatic tissue-microarray core detection, labelling each
cell with the core it falls in."""
from __future__ import annotations

from ..base import Function, ParamSpec, CallResult, run_compute, resolve_obsm_key
from .tma_detect import assign_cores, NAMING_SCHEMES

_HELP = """Identify TMAs

Automatically detect the cores of a tissue microarray from the spatial layout of
the cells and label each cell with the core it belongs to. The grid dimensions
are estimated automatically unless you set them explicitly.

Parameters
----------
coords
    obsm key holding the coordinates (default: spatial).
angle
    Clockwise rotation (degrees) to align the array to the axes before detection.
nrows, ncols
    Grid dimensions; leave blank to auto-detect.
min_prop_cells
    Minimum fraction of all cells for a core to be kept (filters debris).
core_naming_scheme, row_start, col_start
    How cores are named (e.g. A1, B2) and where row/column numbering begins.
key_added
    Name of the obs column to write the core labels into.
"""


from ._docs import custom_doc

_CITATION = ("Original tissue-microarray core detector implemented in this repository "
             "(clustering of cell coordinates into cores).")
_DOC = custom_doc("identify-tmas")


class IdentifyTMAs(Function):
    source = "custom"
    key = "custom.identify_tmas"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "identify_tmas"
    effect_class = "compute"
    label = "Identify TMAs"
    summary = "Auto-detect tissue-microarray cores and label each cell."
    doc = _HELP
    partially_supported = False
    unsupported_params: list = []

    params = [
        ParamSpec("coords", {"type": "string", "default": "spatial"}, "obsm_key", None,
                  required=False, tooltip="obsm key of the coordinates"),
        ParamSpec("angle", {"type": "number", "default": 0.0}, "number", None,
                  required=False, tooltip="clockwise rotation in degrees before detection"),
        ParamSpec("nrows", {"type": "integer"}, "number", None,
                  required=False, tooltip="grid rows (blank = auto-detect)"),
        ParamSpec("ncols", {"type": "integer"}, "number", None,
                  required=False, tooltip="grid columns (blank = auto-detect)"),
        ParamSpec("min_prop_cells", {"type": "number", "default": 0.001}, "number", None,
                  required=False, tooltip="min fraction of cells per core"),
        ParamSpec("core_naming_scheme", {"type": "string", "enum": list(NAMING_SCHEMES)},
                  "select", None, required=False, tooltip="how cores are named"),
        ParamSpec("row_start", {"type": "string", "enum": ["Top", "Bottom"]}, "select", None,
                  required=False, tooltip="where row numbering starts"),
        ParamSpec("col_start", {"type": "string", "enum": ["Left", "Right"]}, "select", None,
                  required=False, tooltip="where column numbering starts"),
        ParamSpec("key_added", {"type": "string", "default": "tma_core"}, "text", None,
                  required=True, tooltip="obs column to write core labels into", role="output"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        import pandas as pd

        key_added = (params.get("key_added") or "tma_core").strip()

        adata = session.active_table()
        try:
            coords_key = resolve_obsm_key(adata, params)
        except KeyError as e:
            return CallResult(status="failed", error=f"obsm['{e.args[0]}'] does not exist")

        xy = adata.obsm[coords_key]
        coords = pd.DataFrame({"x": xy[:, 0], "y": xy[:, 1]}, index=adata.obs_names)

        def mutate(ad):
            labels, _cores = assign_cores(
                coords,
                angle=float(params.get("angle") or 0.0),
                nrows=int(params["nrows"]) if params.get("nrows") else None,
                ncols=int(params["ncols"]) if params.get("ncols") else None,
                min_prop_cells=float(params.get("min_prop_cells") or 0.001),
                core_naming_scheme=params.get("core_naming_scheme") or NAMING_SCHEMES[0],
                row_start=params.get("row_start") or "Top",
                col_start=params.get("col_start") or "Left",
            )
            ad.obs[key_added] = pd.Categorical(labels.values)

        return run_compute(session, mutate)
