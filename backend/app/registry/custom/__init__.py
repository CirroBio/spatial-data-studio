"""Hand-written (non-squidpy) functions. Each is a `Function` subclass registered
alongside the introspected squidpy functions (see registry/introspect.py)."""
from .leiden_regions import IdentifyRegionsLeiden
from .edit_annotations import EditAnnotations
from .identify_tmas import IdentifyTMAs
from .region_composition import RegionComposition, RegionCompositionPlot
from .celltypist_annotate import CellTypistAnnotate
from .cellular_neighborhoods import CellularNeighborhoods, CellularNeighborhoodsPlot
from .milo_da import MiloDifferentialAbundance, MiloDifferentialAbundancePlot
from .lisi import LisiScores, LisiScoresPlot
from .proximity import ProximityTest, ProximityTestPlot
from .boundary import RegionBoundary, RegionBoundaryPlot, InfiltrationProfile, InfiltrationProfilePlot
from .pseudobulk_deseq2 import PseudobulkDESeq2, PseudobulkDESeq2Plot

CUSTOM_FUNCTIONS = [IdentifyRegionsLeiden(), EditAnnotations(), IdentifyTMAs(),
                    RegionComposition(), RegionCompositionPlot(), CellTypistAnnotate(),
                    CellularNeighborhoods(), CellularNeighborhoodsPlot(),
                    MiloDifferentialAbundance(), MiloDifferentialAbundancePlot(),
                    LisiScores(), LisiScoresPlot(),
                    ProximityTest(), ProximityTestPlot(),
                    RegionBoundary(), RegionBoundaryPlot(), InfiltrationProfile(), InfiltrationProfilePlot(),
                    PseudobulkDESeq2(), PseudobulkDESeq2Plot()]
