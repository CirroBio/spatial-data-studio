// Synthetic inputs and scoring helpers shared by the analysis tests.
import type { ExpressionMatrix } from '@cirrobio/spatial-viewer';
import { gaussian, mulberry32, randomInt } from './random';

/** A CSC matrix from dense rows (`dense[cell][gene]`), storing only the nonzeros. */
export function cscFromDense(dense: number[][], genes?: string[]): ExpressionMatrix {
  const nCells = dense.length;
  const nGenes = dense[0].length;
  const indptr = new Float64Array(nGenes + 1);
  const indices: number[] = [];
  const data: number[] = [];
  for (let g = 0; g < nGenes; g++) {
    for (let c = 0; c < nCells; c++) {
      if (dense[c][g] !== 0) {
        indices.push(c);
        data.push(dense[c][g]);
      }
    }
    indptr[g + 1] = indices.length;
  }
  return {
    nCells,
    genes: genes ?? Array.from({ length: nGenes }, (_, g) => `g${g}`),
    indptr,
    indices: Int32Array.from(indices),
    data: Float32Array.from(data),
  };
}

/** A random sparse count matrix: each entry is nonzero with probability `density`,
 * drawn from 1..maxCount, built gene by gene so no dense copy is ever made. */
export function randomCounts(nCells: number, nGenes: number, density: number, seed: number, maxCount = 10): ExpressionMatrix {
  const random = mulberry32(seed);
  const indptr = new Float64Array(nGenes + 1);
  const capacity = Math.ceil(nCells * nGenes * density * 1.1) + 1024;
  let indices = new Int32Array(capacity);
  let data = new Float32Array(capacity);
  let nnz = 0;
  for (let g = 0; g < nGenes; g++) {
    for (let c = 0; c < nCells; c++) {
      if (random() >= density) continue;
      if (nnz === indices.length) {
        const grownIndices = new Int32Array(indices.length * 2);
        grownIndices.set(indices);
        indices = grownIndices;
        const grownData = new Float32Array(data.length * 2);
        grownData.set(data);
        data = grownData;
      }
      indices[nnz] = c;
      data[nnz] = 1 + randomInt(random, maxCount);
      nnz++;
    }
    indptr[g + 1] = nnz;
  }
  return {
    nCells,
    genes: Array.from({ length: nGenes }, (_, g) => `gene${g}`),
    indptr,
    indices: indices.slice(0, nnz),
    data: data.slice(0, nnz),
  };
}

/** `nPerBlob` points around each of `nBlobs` centres spaced `separation` apart on random
 * axes of a `dim`-dimensional space; returns row-major points and the true labels. */
export function gaussianBlobs(nBlobs: number, nPerBlob: number, dim: number, separation: number, seed: number) {
  const random = mulberry32(seed);
  const centres = Array.from({ length: nBlobs }, () => Array.from({ length: dim }, () => gaussian(random) * separation));
  const n = nBlobs * nPerBlob;
  const points = new Float32Array(n * dim);
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const blob = i % nBlobs;
    labels[i] = blob;
    for (let d = 0; d < dim; d++) points[i * dim + d] = centres[blob][d] + gaussian(random);
  }
  return { points, labels, n };
}

/** Hubert & Arabie's adjusted Rand index between two labelings. */
export function adjustedRandIndex(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const pairs = (x: number) => (x * (x - 1)) / 2;
  const table = new Map<string, number>();
  const rows = new Map<number, number>();
  const cols = new Map<number, number>();
  for (let i = 0; i < a.length; i++) {
    const key = `${a[i]},${b[i]}`;
    table.set(key, (table.get(key) ?? 0) + 1);
    rows.set(a[i], (rows.get(a[i]) ?? 0) + 1);
    cols.set(b[i], (cols.get(b[i]) ?? 0) + 1);
  }
  let index = 0;
  for (const v of table.values()) index += pairs(v);
  let rowSum = 0;
  for (const v of rows.values()) rowSum += pairs(v);
  let colSum = 0;
  for (const v of cols.values()) colSum += pairs(v);
  const expected = (rowSum * colSum) / pairs(a.length);
  return (index - expected) / ((rowSum + colSum) / 2 - expected);
}

// Counts drawn from mulberry32(5), reproduced exactly in Python: gene g is detected with
// probability 0.05 + 0.9 g/80 and genes 0-9 are raised in every third cell. `withRare`
// appends a gene seen in one cell only, whose scaled value scanpy clips at 10.
export function referenceCounts(withRare: boolean): number[][] {
  const random = mulberry32(5);
  const rows: number[][] = [];
  for (let c = 0; c < 300; c++) {
    const row: number[] = [];
    for (let g = 0; g < 80; g++) {
      const u = random();
      let v = u < 0.05 + (0.9 * g) / 80 ? 1 + Math.floor(random() * (1 + (g % 7))) : 0;
      if (g < 10 && c % 3 === 0) v += 4;
      row.push(v);
    }
    if (withRare) row.push(c === 0 ? 5 : 0);
    rows.push(row);
  }
  return rows;
}

function poisson(rate: number, random: () => number): number {
  const limit = Math.exp(-rate);
  let k = 0;
  let p = random();
  while (p > limit) {
    k++;
    p *= random();
  }
  return k;
}

/** Counts for `nTypes` cell types (cell i has type i % nTypes): every gene has a low
 * background rate, and each type raises its own block of `markersPerType` genes. Built
 * gene by gene as CSC, so large sizes stay cheap. */
export function simulatedTypes(nTypes: number, nCells: number, nGenes: number, markersPerType: number, seed: number) {
  const random = mulberry32(seed);
  const background = Array.from({ length: nGenes }, () => 0.05 + 0.5 * random());
  const indptr = new Float64Array(nGenes + 1);
  const indices: number[] = [];
  const data: number[] = [];
  for (let g = 0; g < nGenes; g++) {
    const owner = Math.floor(g / markersPerType);
    for (let c = 0; c < nCells; c++) {
      const v = poisson(owner === c % nTypes ? 4 : background[g], random);
      if (v > 0) {
        indices.push(c);
        data.push(v);
      }
    }
    indptr[g + 1] = indices.length;
  }
  const matrix: ExpressionMatrix = {
    nCells,
    genes: Array.from({ length: nGenes }, (_, g) => `gene${g}`),
    indptr,
    indices: Int32Array.from(indices),
    data: Float32Array.from(data),
  };
  return { matrix, types: Int32Array.from({ length: nCells }, (_, c) => c % nTypes) };
}
