"""Hand-written (non-squidpy) functions. Each is a `Function` subclass registered
alongside the introspected squidpy functions (see registry/introspect.py)."""
from .leiden_regions import IdentifyRegionsLeiden
from .edit_annotations import EditAnnotations
from .identify_tmas import IdentifyTMAs
from .region_composition import RegionComposition, RegionCompositionPlot

CUSTOM_FUNCTIONS = [IdentifyRegionsLeiden(), EditAnnotations(), IdentifyTMAs(),
                    RegionComposition(), RegionCompositionPlot()]
