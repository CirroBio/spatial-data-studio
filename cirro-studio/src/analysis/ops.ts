// The analyses the worker runs, by name. Expression ops log-normalize first when the
// stored values look like raw counts; spatial ops build the kNN graph from positions.
import type { ExpressionMatrix } from '@cirrobio/spatial-viewer';
import { ENRICHMENT_PERMUTATIONS, MORAN_MIN_CELLS, NICHE_COUNT, NICHE_NEIGHBOURS, SPATIAL_NEIGHBOURS } from './defaults';
import { highlyVariableGenes, pca } from './embedding';
import { labelCount } from './labels';
import { leiden } from './leiden';
import { logNormalize, looksLikeCounts } from './matrix';
import { knnGraph, umapConnectivities } from './neighbors';
import { stage, type Progress } from './progress';
import { compareGroups, markersForAll } from './rankGenes';
import { scoreGenes } from './score';
import { kmeans, moransI, neighborhoodEnrichment, nicheComposition, spatialKnn } from './spatial';
import { transferables } from './transfer';

export interface ClusterResult {
  labels: Int32Array;
  nClusters: number;
  // Row-major nCells × nComps, as obsm['X_pca'].
  pca: Float32Array;
  nComps: number;
  varianceRatio: Float64Array;
  // The genes the PCA used: the highly variable ones, or every gene of a small panel.
  genes: Int32Array;
  // True when the stored values were taken as counts and log-normalized first.
  normalized: boolean;
}

export interface NicheResult {
  // Niche of each cell; -1 where no labelled cell is within its neighbourhood.
  labels: Int32Array;
  nNiches: number;
  // Row-major nNiches × nCategories: each niche's mean neighbourhood composition.
  profiles: Float32Array;
}

/** The values an expression analysis runs on: log-normalized when they look like counts. */
function analysisMatrix(m: ExpressionMatrix): ExpressionMatrix {
  return looksLikeCounts(m) ? logNormalize(m) : m;
}

export const ops = {
  compareGroups: (args: { matrix: ExpressionMatrix; membership: Uint8Array }, progress: Progress) =>
    compareGroups(analysisMatrix(args.matrix), args.membership, progress),

  markersForAll: (args: { matrix: ExpressionMatrix; codes: Int32Array; nGroups: number }, progress: Progress) =>
    markersForAll(analysisMatrix(args.matrix), args.codes, args.nGroups, progress),

  spatialKnn: (args: { xy: Float32Array; k: number }, progress: Progress) => spatialKnn(args.xy, args.xy.length / 2, args.k, progress),

  moransI: (args: { matrix: ExpressionMatrix; xy: Float32Array; k?: number; minCells?: number }, progress: Progress) => {
    const { matrix, xy, k = SPATIAL_NEIGHBOURS, minCells = MORAN_MIN_CELLS } = args;
    const neighbors = spatialKnn(xy, matrix.nCells, k, stage(progress, 0, 0.1));
    return moransI(analysisMatrix(matrix), neighbors, k, { minCells }, stage(progress, 0.1, 1));
  },

  neighborhoodEnrichment: (
    args: { codes: Int32Array; nCategories: number; xy: Float32Array; k?: number; permutations?: number; seed?: number },
    progress: Progress,
  ) => {
    const { codes, nCategories, xy, k = SPATIAL_NEIGHBOURS, permutations = ENRICHMENT_PERMUTATIONS, seed = 0 } = args;
    const neighbors = spatialKnn(xy, codes.length, k, stage(progress, 0, 0.1));
    return neighborhoodEnrichment(codes, nCategories, neighbors, k, permutations, seed, stage(progress, 0.1, 1));
  },

  niches: (
    args: { codes: Int32Array; nCategories: number; xy: Float32Array; k?: number; nNiches?: number; seed?: number },
    progress: Progress,
  ): NicheResult => {
    const { codes, nCategories, xy, k = NICHE_NEIGHBOURS, nNiches = NICHE_COUNT, seed = 0 } = args;
    const n = codes.length;
    const neighbors = spatialKnn(xy, n, k, stage(progress, 0, 0.2));
    const composition = nicheComposition(codes, nCategories, neighbors, k);
    const kept: number[] = [];
    for (let i = 0; i < n; i++) if (composition.subarray(i * nCategories, (i + 1) * nCategories).some((f) => f > 0)) kept.push(i);
    const rows = new Float32Array(kept.length * nCategories);
    if (kept.length === 0) throw new Error('No cell has a labelled cell in its neighbourhood.');
    kept.forEach((cell, r) => rows.set(composition.subarray(cell * nCategories, (cell + 1) * nCategories), r * nCategories));
    const keptLabels = kmeans(rows, kept.length, nCategories, Math.min(nNiches, kept.length), seed, 300, stage(progress, 0.2, 1));
    const found = labelCount(keptLabels);
    const labels = new Int32Array(n).fill(-1);
    const profiles = new Float32Array(found * nCategories);
    const sizes = new Float64Array(found);
    kept.forEach((cell, r) => {
      const niche = keptLabels[r];
      labels[cell] = niche;
      sizes[niche]++;
      for (let c = 0; c < nCategories; c++) profiles[niche * nCategories + c] += rows[r * nCategories + c];
    });
    for (let i = 0; i < profiles.length; i++) profiles[i] /= sizes[Math.floor(i / nCategories)];
    return { labels, nNiches: found, profiles };
  },

  cluster: (
    args: { matrix: ExpressionMatrix; resolution?: number; nTopGenes?: number; nComps?: number; k?: number; seed?: number },
    progress: Progress,
  ): ClusterResult => {
    // k excludes the cell itself, so the default 14 is scanpy's n_neighbors=15.
    const { matrix, resolution = 1, nTopGenes = 2000, nComps = 50, k = 14, seed = 0 } = args;
    const normalized = looksLikeCounts(matrix);
    const m = normalized ? logNormalize(matrix) : matrix;
    progress(0.02, 'Selecting variable genes');
    const genes = highlyVariableGenes(m, nTopGenes);
    const comps = Math.min(nComps, genes.length - 1, m.nCells - 1);
    const { scores, varianceRatio } = pca(m, genes, comps, seed, stage(progress, 0.05, 0.2));
    const knn = knnGraph(scores, m.nCells, comps, k, seed, stage(progress, 0.2, 0.9));
    const labels = leiden(umapConnectivities(knn, m.nCells, k), { resolution, seed }, stage(progress, 0.9, 1));
    return {
      labels,
      nClusters: labelCount(labels),
      pca: scores,
      nComps: comps,
      varianceRatio,
      genes: Int32Array.from(genes),
      normalized,
    };
  },

  scoreGenes: (args: { matrix: ExpressionMatrix; genes: number[]; seed?: number; ctrlSize?: number; nBins?: number }) =>
    scoreGenes(analysisMatrix(args.matrix), args.genes, args.seed ?? 0, { ctrlSize: args.ctrlSize, nBins: args.nBins }),
};

export type Ops = typeof ops;
export type OpName = keyof Ops;
export type OpArgs<O extends OpName> = Parameters<Ops[O]>[0];
export type OpResult<O extends OpName> = ReturnType<Ops[O]>;

export interface AnalysisRequest<O extends OpName = OpName> {
  op: O;
  args: OpArgs<O>;
}

export type AnalysisMessage = { progress: number; message: string } | { result: unknown } | { error: string };

const PROGRESS_INTERVAL_MS = 200;
const PROGRESS_STEP = 0.05;

/** Runs one request, posting throttled progress and then the result (its typed-array
 * buffers listed for transfer) or the error message. */
export function handleRequest(request: AnalysisRequest, post: (message: AnalysisMessage, transfer: Transferable[]) => void): void {
  let lastTime = -Infinity;
  let lastFraction = -1;
  let lastMessage = '';
  const progress: Progress = (fraction, message) => {
    const now = performance.now();
    const moved = fraction > lastFraction;
    if (message !== lastMessage || fraction - lastFraction >= PROGRESS_STEP || (moved && now - lastTime >= PROGRESS_INTERVAL_MS)) {
      lastTime = now;
      lastFraction = fraction;
      lastMessage = message;
      post({ progress: fraction, message }, []);
    }
  };
  try {
    const run = ops[request.op] as (args: OpArgs<OpName>, progress: Progress) => unknown;
    const result = run(request.args, progress);
    post({ result }, transferables(result));
  } catch (error) {
    post({ error: error instanceof Error ? error.message : String(error) }, []);
  }
}
