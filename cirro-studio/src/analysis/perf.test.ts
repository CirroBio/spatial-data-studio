// @vitest-environment node
// Timings at realistic sizes; they log and assert nothing, so they are skipped unless
// asked for: ANALYSIS_PERF=1 npx vitest run src/analysis/perf.test.ts
import { describe, it } from 'vitest';
import { knnGraph } from './neighbors';
import { ops } from './ops';
import { silent } from './progress';
import { mulberry32 } from './random';
import { markersForAll } from './rankGenes';
import { moransI, neighborhoodEnrichment, spatialKnn } from './spatial';
import { adjustedRandIndex, gaussianBlobs, randomCounts, simulatedTypes } from './testData';

const LONG = 20 * 60 * 1000;

function timed<T>(label: string, run: () => T): T {
  const start = performance.now();
  const result = run();
  console.log(`${label}: ${((performance.now() - start) / 1000).toFixed(2)} s`);
  return result;
}

describe.skipIf(!process.env.ANALYSIS_PERF)('performance', () => {
  it('markersForAll, Xenium-sized: 120k cells × 400 genes (10% dense) × 20 groups', () => {
    const m = randomCounts(120_000, 400, 0.1, 1);
    const codes = Int32Array.from({ length: m.nCells }, (_, c) => c % 20);
    timed('markersForAll 120k × 400 × 20', () => markersForAll(m, codes, 20));
  }, LONG);

  it('markersForAll, Visium-sized: 6k spots × 18k genes (10% dense) × 15 groups', () => {
    const m = randomCounts(6_000, 18_000, 0.1, 2);
    const codes = Int32Array.from({ length: m.nCells }, (_, c) => c % 15);
    timed('markersForAll 6k × 18k × 15', () => markersForAll(m, codes, 15));
  }, LONG);

  it('cluster: 50k cells × 400 genes, 10 cell types', () => {
    const { matrix, types } = simulatedTypes(10, 50_000, 400, 20, 3);
    const result = timed('cluster 50k × 400', () => ops.cluster({ matrix }, silent));
    console.log(`  ${result.nClusters} clusters, ARI vs simulated types ${adjustedRandIndex(result.labels, types).toFixed(3)}`);
  }, LONG);

  it('cluster: 50k cells × 5000 genes (2% dense), 2000 variable genes', () => {
    const matrix = randomCounts(50_000, 5_000, 0.02, 7);
    const result = timed('cluster 50k × 5000 (HVG 2000)', () => ops.cluster({ matrix }, silent));
    console.log(`  ${result.nClusters} clusters`);
  }, LONG);

  it('knnGraph: 200k points × 50 dimensions', () => {
    const { points, n } = gaussianBlobs(20, 10_000, 50, 3, 4);
    timed('knnGraph 200k × 50, k=14', () => knnGraph(points, n, 50, 14, 0));
  }, LONG);

  it('spatial statistics: 200k cells', () => {
    const random = mulberry32(5);
    const n = 200_000;
    const xy = Float32Array.from({ length: 2 * n }, () => random() * 5000);
    const neighbors = timed('spatialKnn 200k, k=6', () => spatialKnn(xy, n, 6));
    const m = randomCounts(n, 400, 0.1, 6);
    timed("moransI 200k × 400", () => moransI(m, neighbors, 6, { minCells: 10 }));
    const codes = Int32Array.from({ length: n }, () => Math.floor(random() * 15));
    timed('neighborhoodEnrichment 200k, 15 types, 1000 permutations', () => neighborhoodEnrichment(codes, 15, neighbors, 6, 1000, 0));
    timed('niches 200k, 15 types, k=10, 10 niches', () => ops.niches({ codes, nCategories: 15, xy }, silent));
  }, LONG);
});
