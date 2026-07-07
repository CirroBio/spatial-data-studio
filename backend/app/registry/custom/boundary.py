"""Region boundary / infiltration profile — derive a tissue region from cell-type
labels (no hand-drawn geometry needed), compute each cell's signed distance to
the region margin, and profile a target population's abundance as a function of
that distance (the "infiltration curve"). See _vendor/boundary_compute.py for the
two-tier method (rasterized mask + distance transform, or a boundary-free local
interior fraction) and biological rationale."""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pandas as pd

from ..base import CallResult, Function, ParamSpec, capture_log, missing_obs_column, render_plot, run_compute, \
    resolve_obsm_key
from ._vendor import boundary_compute, boundary_plot

_NUMERIC_KWARGS = ("bin_size", "bandwidth", "threshold", "min_area", "radius", "margin_width")


def _bad_labels(adata, cell_type_key: str, labels: list) -> list:
    observed = set(adata.obs[cell_type_key].astype(str))
    return [v for v in labels if v not in observed]


from ._docs import custom_doc

_CITATION = ("Original method implemented in this repository (tissue region derived from cell-type "
             "labels; each cell's signed distance to the region margin, and the infiltration profile "
             "along that distance).")
_DOC = custom_doc("region-boundary-and-infiltration")


class RegionBoundary(Function):
    source = "custom"
    key = "custom.region_boundary"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "region_boundary"
    effect_class = "compute"
    label = "Region boundary / infiltration distance"
    summary = "Derive a region from cell-type labels and each cell's signed distance to its margin."
    doc = """Region boundary / infiltration distance

Derive a tissue region (e.g. a tumor nest) from one or more cell-type labels
and compute each cell's signed distance to the region margin (negative =
interior, 0 = margin, positive = exterior), plus a core/margin/stroma
compartment call. Two methods: "mask" rasterizes interior-cell density into a
binary region and takes a Euclidean distance transform (yields a true margin);
"soft" is a boundary-free local interior fraction, mapped to the same signed
coordinate, for regions too scattered for a mask to be defensible. Feed the
resulting `<key_added>_signed_distance` column into "Infiltration profile" to
measure how deeply another population penetrates the region.

Parameters
----------
cell_type_key
    Categorical obs column (cell types/clusters) that includes the interior label(s).
interior_labels
    One or more values of cell_type_key forming the region interior (e.g. a tumor label).
coords
    obsm key holding the coordinates (default: spatial).
method
    "mask" (rasterized density + distance transform) or "soft" (local interior
    fraction, no raster).
bin_size
    Raster pixel size, mask method (blank = ~1/60 of the smaller coordinate extent).
bandwidth
    Gaussian smoothing scale, mask method (blank = 3x bin_size).
threshold
    Relative density threshold in [0, 1] for the mask, mask method.
min_area
    Minimum region area (coordinate-unit^2) to keep, mask method; filters specks.
radius
    Neighborhood radius, soft method (blank = ~1/15 of the smaller coordinate extent).
margin_width
    Half-width of the margin band in signed-distance units (blank = bandwidth for
    mask, 0.15 for soft).
key_added
    Prefix for the obs columns this step writes (`<key_added>_signed_distance`,
    `<key_added>_compartment`, and `<key_added>_insideness` for the soft method)
    and the uns key storing its run parameters.
"""
    params = [
        ParamSpec("cell_type_key", {"type": "string"}, "obs_categorical", "obs_categorical",
                  required=True, tooltip="cell-type/cluster column containing the interior label(s)"),
        ParamSpec("interior_labels", {"type": "array", "items": {"type": "string"}}, "multitext", None,
                  required=True, tooltip="one or more cell_type_key values forming the region interior"),
        ParamSpec("coords", {"type": "string", "default": "spatial"}, "obsm_key", "obsm",
                  required=False, tooltip="obsm key of the coordinates"),
        ParamSpec("method", {"type": "string", "enum": ["mask", "soft"], "default": "mask"}, "select", None,
                  required=False, tooltip="mask = rasterized density + distance transform; soft = local interior fraction"),
        ParamSpec("bin_size", {"type": "number"}, "number", None,
                  required=False, tooltip="raster pixel size, mask method (blank = auto)"),
        ParamSpec("bandwidth", {"type": "number"}, "number", None,
                  required=False, tooltip="density smoothing scale, mask method (blank = 3x bin_size)"),
        ParamSpec("threshold", {"type": "number", "default": 0.25}, "number", None,
                  required=False, tooltip="relative density threshold in [0, 1], mask method"),
        ParamSpec("min_area", {"type": "number", "default": 0.0}, "number", None,
                  required=False, tooltip="minimum region area to keep, mask method; filters specks"),
        ParamSpec("radius", {"type": "number"}, "number", None,
                  required=False, tooltip="neighborhood radius, soft method (blank = auto)"),
        ParamSpec("margin_width", {"type": "number"}, "number", None,
                  required=False, tooltip="half-width of the margin band (blank = auto)"),
        ParamSpec("key_added", {"type": "string", "default": "boundary"}, "text", None,
                  required=True, tooltip="prefix for the obs columns/uns key this step writes", role="output"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        cell_type_key = params.get("cell_type_key")
        interior_labels = params.get("interior_labels") or []
        method = params.get("method") or "mask"
        key_added = (params.get("key_added") or "boundary").strip()

        adata = session.active_table()
        error = missing_obs_column(adata, cell_type_key)
        if error:
            return CallResult(status="failed", error=error)
        if not interior_labels:
            return CallResult(status="failed", error="interior_labels is required")
        try:
            coords = resolve_obsm_key(adata, params)
        except KeyError as e:
            return CallResult(status="failed", error=f"obsm['{e.args[0]}'] does not exist")

        bad = _bad_labels(adata, cell_type_key, interior_labels)
        if bad:
            return CallResult(status="failed",
                              error=f"interior_labels value(s) not found in obs['{cell_type_key}']: {bad}")

        kwargs = {name: float(params[name]) for name in _NUMERIC_KWARGS if params.get(name) not in (None, "")}

        def mutate(ad):
            res = boundary_compute.boundary_adata(
                ad, cell_type_key, interior_labels, spatial_key=coords, method=method,
                key_added=key_added, **kwargs)
            uns = ad.uns[key_added]
            uns["cell_type_key"] = cell_type_key
            uns["coords"] = coords
            if res.method == "mask" and res.mask is not None:
                uns["mask"] = res.mask.tolist()
                uns["signed_grid"] = res.signed_grid.tolist()
                uns["grid_origin"] = list(res.grid_origin)
                uns["bin_size"] = float(res.bin_size)
            ad.uns[key_added] = uns

        return run_compute(session, mutate)


class RegionBoundaryPlot(Function):
    source = "custom"
    key = "custom.region_boundary_plot"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "region_boundary_plot"
    effect_class = "plot"
    label = "Region boundary (plot)"
    summary = "Cells colored by compartment, with the derived region margin overlaid."
    doc = """Region boundary (plot)

QC view for "Region boundary / infiltration distance": cells colored by
core/margin/stroma compartment (or, for the soft method, by local interior
fraction), with the derived region margin drawn as a contour (mask method
only). Because the region is inferred and its scale is a free parameter, this
is where you judge whether to trust it before reading the infiltration
profile. Run "Region boundary / infiltration distance" first.

Parameters
----------
key_added
    Prefix the "Region boundary / infiltration distance" step used.
color_by
    "compartment" (core/margin/stroma) or "insideness" (soft method only).
"""
    params = [
        ParamSpec("key_added", {"type": "string", "default": "boundary"}, "text", None,
                  required=True, tooltip="prefix used by the boundary step"),
        ParamSpec("color_by", {"type": "string", "enum": ["compartment", "insideness"], "default": "compartment"},
                  "select", None, required=False, tooltip="color cells by compartment or local interior fraction"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        key_added = (params.get("key_added") or "boundary").strip()
        color_by = params.get("color_by") or "compartment"
        adata = session.active_table()
        if key_added not in adata.uns:
            return CallResult(
                status="failed",
                error=f"run 'Region boundary / infiltration distance' for this key first (uns['{key_added}'] not found)")
        error = missing_obs_column(adata, f"{key_added}_compartment")
        if error:
            return CallResult(status="failed", error=error)

        def fn(ad):
            data = ad.uns[key_added]
            insideness_col = f"{key_added}_insideness"
            result = SimpleNamespace(
                compartment=ad.obs[f"{key_added}_compartment"].astype(str).values,
                insideness=ad.obs[insideness_col].values if insideness_col in ad.obs.columns else None,
                method=data["params"]["method"],
                mask=np.asarray(data["mask"], dtype=bool) if "mask" in data else None,
                signed_grid=np.asarray(data["signed_grid"]) if "signed_grid" in data else None,
                grid_origin=tuple(data["grid_origin"]) if "grid_origin" in data else None,
                bin_size=data.get("bin_size"),
                interior_labels=data["interior_labels"],
            )
            coords = ad.obsm[data["coords"]]
            labels = ad.obs[data["cell_type_key"]].values
            return boundary_plot.plot_region_mask(result, coords, labels, color_by=color_by)

        with capture_log() as buf:
            return render_plot(fn, [adata], {}, buf)


class InfiltrationProfile(Function):
    source = "custom"
    key = "custom.infiltration_profile"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "infiltration_profile"
    effect_class = "compute"
    label = "Infiltration profile"
    summary = "Target population abundance vs. signed distance to the region margin."
    doc = """Infiltration profile

Bin cells by the signed distance to the region margin computed by "Region
boundary / infiltration distance" and report a target population's abundance
per bin: fraction of cells that are the target type (or raw count). A target
that infiltrates the region shows abundance extending to negative distances
(inside); an excluded target piles up just outside the margin. Run "Region
boundary / infiltration distance" first.

Parameters
----------
key_added
    Prefix used by a prior "Region boundary / infiltration distance" run
    (reads `<key_added>_signed_distance` from obs).
cell_type_key
    Categorical obs column (cell types/clusters) the target_labels come from;
    should match the column used for that boundary run.
target_labels
    One or more cell_type_key values to profile.
bins
    Number of equal-width bins across the signed-distance range.
value
    "fraction" (target share of cells per bin) or "count" (raw cell count).
profile_key
    uns key to store the resulting profile table under.
"""
    params = [
        ParamSpec("key_added", {"type": "string", "default": "boundary"}, "text", None,
                  required=True, tooltip="prefix used by a prior 'Region boundary' run"),
        ParamSpec("cell_type_key", {"type": "string"}, "obs_categorical", "obs_categorical",
                  required=True, tooltip="cell-type/cluster column the target_labels come from"),
        ParamSpec("target_labels", {"type": "array", "items": {"type": "string"}}, "multitext", None,
                  required=True, tooltip="one or more cell_type_key values to profile"),
        ParamSpec("bins", {"type": "integer", "default": 20}, "number", None,
                  required=False, tooltip="number of equal-width bins across the signed-distance range"),
        ParamSpec("value", {"type": "string", "enum": ["fraction", "count"], "default": "fraction"}, "select", None,
                  required=False, tooltip="target share of cells per bin, or raw count"),
        ParamSpec("profile_key", {"type": "string", "default": "infiltration_profile"}, "text", None,
                  required=True, tooltip="uns key to store the profile table under", role="output"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        key_added = (params.get("key_added") or "boundary").strip()
        cell_type_key = params.get("cell_type_key")
        target_labels = params.get("target_labels") or []
        bins = int(params.get("bins") or 20)
        value = params.get("value") or "fraction"
        profile_key = (params.get("profile_key") or "infiltration_profile").strip()

        adata = session.active_table()
        signed_distance_col = f"{key_added}_signed_distance"
        error = missing_obs_column(adata, cell_type_key)
        if error:
            return CallResult(status="failed", error=error)
        if signed_distance_col not in adata.obs.columns:
            return CallResult(
                status="failed",
                error=f"run 'Region boundary / infiltration distance' first (obs['{signed_distance_col}'] not found)")
        if not target_labels:
            return CallResult(status="failed", error="target_labels is required")
        bad = _bad_labels(adata, cell_type_key, target_labels)
        if bad:
            return CallResult(status="failed",
                              error=f"target_labels value(s) not found in obs['{cell_type_key}']: {bad}")

        def mutate(ad):
            profile = boundary_compute.infiltration_profile(
                ad.obs[signed_distance_col].values, ad.obs[cell_type_key].values,
                target_labels, bins=bins, value=value)
            ad.uns[profile_key] = {
                "signed_distance": profile.index.values.tolist(),
                "columns": profile.columns.astype(str).tolist(),
                "data": profile.values.tolist(),
                "target_labels": list(target_labels),
                "cell_type_key": cell_type_key,
                "key_added": key_added,
            }

        return run_compute(session, mutate)


class InfiltrationProfilePlot(Function):
    source = "custom"
    key = "custom.infiltration_profile_plot"
    citation = _CITATION
    documentation = _DOC
    namespace = "custom"
    function = "infiltration_profile_plot"
    effect_class = "plot"
    label = "Infiltration profile (plot)"
    summary = "Line plot of target population abundance vs. signed distance to the margin."
    doc = """Infiltration profile (plot)

The infiltration curve computed by "Infiltration profile": target-population
abundance against signed distance to the region margin. Mass at negative
distances means the target infiltrates the region; a peak piled up just past
the margin (positive distances) with nothing inside means the target is
excluded. The dashed line marks the margin. Run "Infiltration profile" first.

Parameters
----------
profile_key
    uns key the "Infiltration profile" step stored its result under.
"""
    params = [
        ParamSpec("profile_key", {"type": "string", "default": "infiltration_profile"}, "text", None,
                  required=True, tooltip="uns key the 'Infiltration profile' step stored its result under"),
    ]

    def execute(self, params: dict, session) -> CallResult:
        profile_key = (params.get("profile_key") or "infiltration_profile").strip()
        adata = session.active_table()
        if profile_key not in adata.uns:
            return CallResult(status="failed",
                              error=f"run 'Infiltration profile' for this key first (uns['{profile_key}'] not found)")

        def fn(ad):
            data = ad.uns[profile_key]
            profile = pd.DataFrame(data["data"], columns=data["columns"],
                                    index=pd.Index(data["signed_distance"], name="signed_distance"))
            key_added = data["key_added"]
            margin_width = ad.uns[key_added]["params"].get("margin_width") if key_added in ad.uns else None
            return boundary_plot.plot_infiltration_profile(profile, margin_width=margin_width)

        with capture_log() as buf:
            return render_plot(fn, [adata], {}, buf)
