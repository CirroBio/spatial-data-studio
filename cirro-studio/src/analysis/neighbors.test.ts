import { describe, expect, it } from 'vitest';
import { knnGraph, umapConnectivities, type KnnGraph } from './neighbors';
import { mulberry32 } from './random';
import { gaussianBlobs } from './testData';

/** Exact kNN by scanning every pair, keeping each point's k best in insertion order. */
function bruteKnn(points: Float32Array, n: number, dim: number, k: number): KnnGraph {
  const indices = new Int32Array(n * k);
  const distances = new Float32Array(n * k);
  const best = new Float64Array(k);
  const which = new Int32Array(k);
  for (let i = 0; i < n; i++) {
    best.fill(Infinity);
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      let d = 0;
      for (let t = 0; t < dim; t++) d += (points[i * dim + t] - points[j * dim + t]) ** 2;
      if (d >= best[k - 1]) continue;
      let s = k - 1;
      for (; s > 0 && best[s - 1] > d; s--) {
        best[s] = best[s - 1];
        which[s] = which[s - 1];
      }
      best[s] = d;
      which[s] = j;
    }
    indices.set(which, i * k);
    distances.set(best.map(Math.sqrt), i * k);
  }
  return { indices, distances };
}

function recall(found: Int32Array, exact: Int32Array, n: number, k: number): number {
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const truth = new Set(exact.subarray(i * k, i * k + k));
    for (const j of found.subarray(i * k, i * k + k)) if (truth.has(j)) hits++;
  }
  return hits / (n * k);
}

describe('knnGraph', () => {
  it('finds nearly all true neighbours of 5000 random points', () => {
    // Uniform in 20-D is harder than PCA scores of real cells; k candidates per round
    // (pynndescent's choice) reach 0.95 here, 2k reach 0.97.
    const random = mulberry32(12);
    const n = 5000;
    const dim = 20;
    const points = Float32Array.from({ length: n * dim }, () => random());
    const k = 14;
    const { indices, distances } = knnGraph(points, n, dim, k, 0);
    expect(recall(indices, bruteKnn(points, n, dim, k).indices, n, k)).toBeGreaterThan(0.96);
    for (let i = 0; i < n; i++) {
      const row = indices.subarray(i * k, i * k + k);
      expect(new Set(row).size).toBe(k);
      expect(row).not.toContain(i);
      for (let s = 1; s < k; s++) expect(distances[i * k + s]).toBeGreaterThanOrEqual(distances[i * k + s - 1]);
    }
  });

  it('is exact on clustered data and reproducible for a seed', () => {
    const { points, n } = gaussianBlobs(4, 300, 10, 8, 2);
    const first = knnGraph(points, n, 10, 10, 3);
    expect(recall(first.indices, bruteKnn(points, n, 10, 10).indices, n, 10)).toBeGreaterThan(0.98);
    expect(knnGraph(points, n, 10, 10, 3).indices).toEqual(first.indices);
  });
});

describe('umapConnectivities', () => {
  it('matches scanpy neighbors(method="umap") connectivities', () => {
    // scanpy `neighbors(n_neighbors=11, use_rep='X')` (exact kNN at this size) on 200
    // uniform points in 5-D drawn from mulberry32(8); given the same exact kNN here.
    const random = mulberry32(8);
    const n = 200;
    const points = Float32Array.from({ length: n * 5 }, () => random() * 10);
    const k = 10;
    const graph = umapConnectivities(bruteKnn(points, n, 5, k), n, k);
    const row = (i: number) => {
      const entries: Record<number, number> = {};
      for (let e = graph.indptr[i]; e < graph.indptr[i + 1]; e++) entries[graph.indices[e]] = graph.weights[e];
      return entries;
    };
    const expected0 = { 6: 0.37467026710510254, 10: 0.46397966146469116, 14: 0.31509119272232056, 18: 0.1800103634595871, 23: 0.4838846027851105, 33: 0.21807175874710083, 36: 1.0, 40: 0.8525404930114746, 46: 0.0760640874505043, 85: 0.29611948132514954, 87: 0.1392662525177002, 104: 0.2891220450401306, 115: 0.3456730842590332, 125: 0.19322118163108826, 130: 0.2915291488170624, 131: 0.1687263697385788, 178: 0.7917908430099487 };
    const expected7 = { 4: 0.27997541427612305, 19: 1.0, 39: 0.5600249171257019, 57: 0.10397499054670334, 68: 0.4419352114200592, 75: 0.2700022757053375, 89: 0.6987385153770447, 102: 0.6228920221328735, 105: 0.20185808837413788, 106: 0.11211054772138596, 139: 0.2689388394355774, 144: 0.20651966333389282, 146: 0.23338952660560608, 161: 0.26849672198295593, 165: 0.08862612396478653, 177: 0.3857663571834564, 191: 0.8138754367828369 };
    for (const [i, expected] of [[0, expected0], [7, expected7]] as const) {
      const actual = row(i);
      expect(Object.keys(actual).map(Number).sort((a, b) => a - b)).toEqual(Object.keys(expected).map(Number));
      for (const [j, w] of Object.entries(expected)) expect(actual[Number(j)]).toBeCloseTo(w, 5);
    }
    expect(graph.indices.length).toBe(2494);
    expect(graph.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1042.9201156885829, 2);
  });
});
