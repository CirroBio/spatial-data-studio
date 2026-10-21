import { describe, expect, it } from 'vitest';
import { mulberry32 } from './random';
import { kmeans, moransI, neighborhoodEnrichment, nicheComposition, spatialKnn } from './spatial';
import { adjustedRandIndex, cscFromDense, gaussianBlobs } from './testData';

function bruteKnnDistances(xy: Float32Array, n: number, k: number): number[][] {
  return Array.from({ length: n }, (_, i) => {
    const d: number[] = [];
    for (let j = 0; j < n; j++) if (j !== i) d.push((xy[2 * j] - xy[2 * i]) ** 2 + (xy[2 * j + 1] - xy[2 * i + 1]) ** 2);
    return d.sort((a, b) => a - b).slice(0, k);
  });
}

function knnDistances(xy: Float32Array, neighbors: Int32Array, n: number, k: number): number[][] {
  return Array.from({ length: n }, (_, i) =>
    Array.from(neighbors.subarray(i * k, i * k + k), (j) => (xy[2 * j] - xy[2 * i]) ** 2 + (xy[2 * j + 1] - xy[2 * i + 1]) ** 2));
}

function grid(width: number, height: number): Float32Array {
  const xy = new Float32Array(width * height * 2);
  for (let i = 0; i < width * height; i++) {
    xy[2 * i] = i % width;
    xy[2 * i + 1] = Math.floor(i / width);
  }
  return xy;
}

// Random positions (mulberry32, seed 42) and five genes, reproduced exactly in Python; the
// expected values are squidpy 1.8 `spatial_neighbors(coord_type='generic', n_neighs=6)`,
// `spatial_autocorr(mode='moran')` and `nhood_enrichment` on the same data.
function referenceLayout() {
  const n = 300;
  const random = mulberry32(42);
  const xy = new Float32Array(2 * n);
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    xy[2 * i] = random() * 100;
    xy[2 * i + 1] = random() * 100;
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    rows.push([
      Math.fround((Math.sin(x / 12) + 1) * (y / 100)),
      x > 70 ? Math.fround(y % 7) : 0,
      Math.fround(((i * 7919) % 13) / 3),
      (Math.floor(x / 10) + Math.floor(y / 10)) % 2 === 0 ? 1 : 0,
      i < 3 ? 1 : 0,
    ]);
  }
  const quadrant = Int32Array.from({ length: n }, (_, i) => (xy[2 * i] < 50 ? 0 : 1) + (xy[2 * i + 1] < 50 ? 0 : 2));
  return { n, xy, matrix: cscFromDense(rows), quadrant };
}

describe('spatialKnn', () => {
  it('finds the exact nearest neighbours, nearest first', () => {
    const random = mulberry32(1);
    const n = 2000;
    const xy = Float32Array.from({ length: 2 * n }, (_, i) => (i % 2 ? 300 : 1000) * random());
    const k = 8;
    const neighbors = spatialKnn(xy, n, k);
    expect(knnDistances(xy, neighbors, n, k)).toEqual(bruteKnnDistances(xy, n, k));
    for (let i = 0; i < n; i++) expect(neighbors.subarray(i * k, i * k + k)).not.toContain(i);
  });

  it('handles clustered, collinear and duplicated points', () => {
    const random = mulberry32(2);
    const layouts = [
      Float32Array.from({ length: 600 }, (_, i) => (i < 300 ? random() : 1e4 + random())),
      Float32Array.from({ length: 400 }, (_, i) => (i % 2 ? 5 : Math.floor(i / 2) * 0.25)),
      Float32Array.from({ length: 200 }, (_, i) => Math.floor(i / 20)),
    ];
    for (const xy of layouts) {
      const n = xy.length / 2;
      const neighbors = spatialKnn(xy, n, 6);
      expect(knnDistances(xy, neighbors, n, 6)).toEqual(bruteKnnDistances(xy, n, 6));
    }
  });

  it('rejects k that leaves too few cells', () => {
    expect(() => spatialKnn(new Float32Array(6), 3, 3)).toThrow(RangeError);
  });
});

describe('moransI', () => {
  it('matches squidpy spatial_autocorr', () => {
    const { n, xy, matrix } = referenceLayout();
    const results = moransI(matrix, spatialKnn(xy, n, 6), 6, { minCells: 0 });
    const expected = [
      { gene: 'g0', I: 0.9552737022454948, pval: 0 },
      { gene: 'g1', I: 0.6908162040547274, pval: 0 },
      { gene: 'g2', I: 0.033125052636579964, pval: 0.12287340324578011, padj: 0.1839432590961837 },
      { gene: 'g3', I: 0.02960526315789472, pval: 0.14715460727694696, padj: 0.1839432590961837 },
      { gene: 'g4', I: -0.008978675645342006, pval: 0.42884183115672614, padj: 0.42884183115672614 },
    ];
    expect(results.map((r) => r.gene)).toEqual(expected.map((r) => r.gene));
    const se = Math.sqrt(0.0009871631627902389);
    results.forEach((row, i) => {
      expect(row.I).toBeCloseTo(expected[i].I, 7);
      expect(Math.abs(row.z / ((expected[i].I + 1 / 299) / se) - 1)).toBeLessThan(1e-6);
      // squidpy computes 1 - cdf(z), which underflows to 0 for the two strongest genes.
      if (expected[i].pval === 0) expect(row.pval).toBeLessThan(1e-12);
      else expect(row.pval).toBeCloseTo(expected[i].pval, 7);
      if (expected[i].padj !== undefined) expect(row.padj).toBeCloseTo(expected[i].padj, 7);
    });
  });

  it('is strongly positive for blocks and strongly negative for a checkerboard', () => {
    const side = 30;
    const xy = grid(side, side);
    const n = side * side;
    const neighbors = spatialKnn(xy, n, 4);
    const rows = Array.from({ length: n }, (_, i) => {
      const x = i % side;
      const y = Math.floor(i / side);
      return [x < side / 2 && y < side / 2 ? 2 : 0, (x + y) % 2];
    });
    const [blocks, checkerboard] = ['g0', 'g1'].map((gene) => moransI(cscFromDense(rows), neighbors, 4, { minCells: 1 }).find((r) => r.gene === gene)!);
    expect(blocks.I).toBeGreaterThan(0.7);
    expect(blocks.padj).toBeLessThan(1e-6);
    expect(checkerboard.I).toBeLessThan(-0.7);
    expect(checkerboard.z).toBeLessThan(-10);
  });

  it('skips genes detected in too few cells', () => {
    const { n, xy, matrix } = referenceLayout();
    const genes = moransI(matrix, spatialKnn(xy, n, 6), 6, { minCells: 10 }).map((r) => r.gene);
    expect(genes).not.toContain('g4');
    expect(genes).toHaveLength(4);
  });
});

describe('neighborhoodEnrichment', () => {
  it('counts neighbour pairs exactly as squidpy and gives comparable z-scores', () => {
    const { n, xy, quadrant } = referenceLayout();
    const { counts, z } = neighborhoodEnrichment(quadrant, 4, spatialKnn(xy, n, 6), 6, 1000, 0);
    expect(Array.from(counts)).toEqual([364, 23, 21, 0, 19, 398, 1, 14, 17, 0, 427, 30, 0, 19, 27, 440]);
    // squidpy's z on its own permutations; ours differ only by permutation noise.
    const squidpyZ = [26.3, -8.71, -9.74, -12.58, -9.17, 26.63, -12.25, -11.16, -9.87, -12.6, 26.1, -10.31, -12.09, -10.25, -11.0, 25.98];
    squidpyZ.forEach((expected, c) => expect(Math.abs(z[c] / expected - 1)).toBeLessThan(0.15));
  });

  it('finds two separated halves enriched with themselves and leaves unlabelled cells out', () => {
    const side = 40;
    const n = side * side;
    const xy = grid(side, side);
    const codes = Int32Array.from({ length: n }, (_, i) => (i % 17 === 0 ? -1 : i % side < side / 2 ? 0 : 1));
    const neighbors = spatialKnn(xy, n, 6);
    const { counts, z } = neighborhoodEnrichment(codes, 2, neighbors, 6, 200, 1);
    expect(z[0]).toBeGreaterThan(5);
    expect(z[3]).toBeGreaterThan(5);
    expect(z[1]).toBeLessThan(-5);
    let labelledEdges = 0;
    for (let i = 0; i < n; i++) for (let e = 0; e < 6; e++) if (codes[i] >= 0 && codes[neighbors[i * 6 + e]] >= 0) labelledEdges++;
    expect(counts.reduce((a, b) => a + b, 0)).toBe(labelledEdges);
  });

  it('is reproducible for a seed', () => {
    const { n, xy, quadrant } = referenceLayout();
    const neighbors = spatialKnn(xy, n, 6);
    expect(neighborhoodEnrichment(quadrant, 4, neighbors, 6, 50, 7).z).toEqual(neighborhoodEnrichment(quadrant, 4, neighbors, 6, 50, 7).z);
  });
});

describe('niches', () => {
  it('describes each neighbourhood by its category fractions, counting the cell itself', () => {
    const codes = Int32Array.from([0, 1, 1, -1]);
    const neighbors = Int32Array.from([1, 2, 0, 3, 3, 0, 1, 2]);
    expect(Array.from(nicheComposition(codes, 2, neighbors, 2))).toEqual([1 / 3, 2 / 3, 1 / 2, 1 / 2, 1 / 2, 1 / 2, 0, 1].map(Math.fround));
  });

  it('k-means recovers separated blobs, largest cluster first', () => {
    const { points, labels, n } = gaussianBlobs(3, 200, 4, 12, 9);
    const found = kmeans(points.subarray(0, (n - 50) * 4), n - 50, 4, 3, 1);
    expect(adjustedRandIndex(found, labels.subarray(0, n - 50))).toBe(1);
    const sizes = [0, 1, 2].map((c) => found.filter((l) => l === c).length);
    expect(sizes[0]).toBeGreaterThanOrEqual(sizes[1]);
    expect(sizes[1]).toBeGreaterThanOrEqual(sizes[2]);
  });
});
