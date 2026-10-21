import { describe, expect, it } from 'vitest';
import { knnGraph, umapConnectivities } from './neighbors';
import { leiden, type WeightedGraph } from './leiden';
import { mulberry32 } from './random';
import { adjustedRandIndex, gaussianBlobs } from './testData';

function graphFromEdges(n: number, edges: [number, number, number?][]): WeightedGraph {
  const rows: [number, number][][] = Array.from({ length: n }, () => []);
  for (const [a, b, w = 1] of edges) {
    rows[a].push([b, w]);
    rows[b].push([a, w]);
  }
  const indptr = new Int32Array(n + 1);
  rows.forEach((row, i) => {
    indptr[i + 1] = indptr[i] + row.length;
  });
  return {
    indptr,
    indices: Int32Array.from(rows.flat(), ([j]) => j),
    weights: Float64Array.from(rows.flat(), ([, w]) => w),
  };
}

/** `nCliques` cliques of `size` nodes, each joined to the next by one edge. */
function ringOfCliques(nCliques: number, size: number) {
  const edges: [number, number][] = [];
  for (let c = 0; c < nCliques; c++) {
    for (let a = 0; a < size; a++) for (let b = a + 1; b < size; b++) edges.push([c * size + a, c * size + b]);
    edges.push([c * size, ((c + 1) % nCliques) * size + 1]);
  }
  const truth = Int32Array.from({ length: nCliques * size }, (_, v) => Math.floor(v / size));
  return { graph: graphFromEdges(nCliques * size, edges), truth };
}

/** A planted-partition random graph: edge probability pIn within blocks, pOut across. */
function plantedPartition(nBlocks: number, size: number, pIn: number, pOut: number, seed: number) {
  const random = mulberry32(seed);
  const n = nBlocks * size;
  const truth = Int32Array.from({ length: n }, (_, v) => Math.floor(v / size));
  const edges: [number, number][] = [];
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) if (random() < (truth[a] === truth[b] ? pIn : pOut)) edges.push([a, b]);
  }
  return { graph: graphFromEdges(n, edges), truth };
}

describe('leiden', () => {
  it('splits a ring of cliques into its cliques', () => {
    const { graph, truth } = ringOfCliques(10, 6);
    expect(adjustedRandIndex(leiden(graph), truth)).toBe(1);
  });

  it('recovers planted communities', () => {
    const { graph, truth } = plantedPartition(4, 100, 0.15, 0.005, 3);
    expect(adjustedRandIndex(leiden(graph, { seed: 1 }), truth)).toBeGreaterThan(0.95);
  });

  it('recovers Gaussian blobs through the kNN graph and UMAP connectivities', () => {
    const { points, labels, n } = gaussianBlobs(4, 250, 10, 6, 21);
    const k = 15;
    const graph = umapConnectivities(knnGraph(points, n, 10, k, 0), n, k);
    expect(adjustedRandIndex(leiden(graph, { resolution: 1, seed: 0 }), labels)).toBeGreaterThan(0.9);
  });

  it('numbers communities by size, largest first', () => {
    // Two disconnected cliques, of 4 and 8 nodes.
    const edges: [number, number][] = [];
    for (const [from, to] of [[0, 4], [4, 12]]) for (let a = from; a < to; a++) for (let b = a + 1; b < to; b++) edges.push([a, b]);
    const labels = leiden(graphFromEdges(12, edges));
    expect(Array.from(labels)).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('finds more communities at higher resolution and is reproducible for a seed', () => {
    const { graph } = plantedPartition(6, 60, 0.2, 0.02, 9);
    const count = (labels: Int32Array) => new Set(labels).size;
    const coarse = leiden(graph, { resolution: 0.2, seed: 4 });
    const fine = leiden(graph, { resolution: 3, seed: 4 });
    expect(count(fine)).toBeGreaterThan(count(coarse));
    expect(leiden(graph, { resolution: 3, seed: 4 })).toEqual(fine);
  });
});
