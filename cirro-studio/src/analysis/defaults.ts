// Op defaults that the task panels also use: recorded with a kept result, printed in its
// caption, or as a control's starting value. They sit apart from ops.ts because the main
// thread imports only types from the op table (see client.ts).

// squidpy's `spatial_neighbors` default.
export const SPATIAL_NEIGHBOURS = 6;
// Genes detected in fewer cells than this are not tested for Moran's I.
export const MORAN_MIN_CELLS = 10;
// squidpy's `nhood_enrichment` default.
export const ENRICHMENT_PERMUTATIONS = 1000;
// Cellular neighbourhoods as Schürch et al. (2020, Cell): windows of the 10 nearest
// cells, clustered into 10 neighbourhood types.
export const NICHE_NEIGHBOURS = 10;
export const NICHE_COUNT = 10;
