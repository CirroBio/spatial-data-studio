// Spatial statistics over a k-nearest-neighbour graph of cell positions, following
// squidpy's `gr.spatial_neighbors(n_neighs=k)` (generic coordinates: directed kNN,
// self excluded), `gr.spatial_autocorr(mode='moran')` and `gr.nhood_enrichment`.
import type { ExpressionMatrix } from '@cirrobio/spatial-viewer';
import { relabelBySize } from './labels';
import { cellsDetected } from './matrix';
import { silent, type Progress } from './progress';
import { mulberry32, randomInt, shuffle } from './random';
import { benjaminiHochberg, normalSf } from './stats';

/** Exact k nearest neighbours of each point in 2-D (self excluded), nearest first.
 * `xy` is interleaved [x0, y0, x1, y1, ...]; the result is row-major n × k. */
export function spatialKnn(xy: Float32Array, n: number, k: number, progress: Progress = silent): Int32Array {
  if (!Number.isInteger(n) || xy.length !== 2 * n) throw new RangeError(`expected ${n} interleaved x, y pairs, got ${xy.length} values`);
  if (!(k >= 1 && k < n)) throw new RangeError(`k must be between 1 and ${n - 1}, got ${k}`);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError(`cell ${i} has no finite position`);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  // About two points per grid cell; the second term keeps a near-degenerate (line-like)
  // layout from producing a grid with far more cells than points.
  let size = Math.max(Math.sqrt((2 * (maxX - minX) * (maxY - minY)) / n), Math.max(maxX - minX, maxY - minY) / n);
  if (!(size > 0)) size = 1;
  const nx = Math.floor((maxX - minX) / size) + 1;
  const ny = Math.floor((maxY - minY) / size) + 1;
  const column = (x: number) => Math.min(nx - 1, Math.floor((x - minX) / size));
  const row = (y: number) => Math.min(ny - 1, Math.floor((y - minY) / size));

  const start = new Int32Array(nx * ny + 1);
  const home = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    home[i] = row(xy[2 * i + 1]) * nx + column(xy[2 * i]);
    start[home[i] + 1]++;
  }
  for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
  const members = new Int32Array(n);
  const fill = start.slice(0, nx * ny);
  for (let i = 0; i < n; i++) members[fill[home[i]]++] = i;

  const heap = new KnnHeap(k);
  const out = new Int32Array(n * k);
  for (let i = 0; i < n; i++) {
    const px = xy[2 * i];
    const py = xy[2 * i + 1];
    const cx = column(px);
    const cy = row(py);
    heap.clear();
    const visit = (gx: number, gy: number) => {
      const c = gy * nx + gx;
      for (let m = start[c]; m < start[c + 1]; m++) {
        const j = members[m];
        if (j === i) continue;
        const dx = xy[2 * j] - px;
        const dy = xy[2 * j + 1] - py;
        heap.offer(dx * dx + dy * dy, j);
      }
    };
    for (let r = 0; ; r++) {
      const x0 = cx - r;
      const x1 = cx + r;
      const y0 = cy - r;
      const y1 = cy + r;
      for (let gy = Math.max(y0, 0); gy <= Math.min(y1, ny - 1); gy++) {
        if (gy === y0 || gy === y1) {
          for (let gx = Math.max(x0, 0); gx <= Math.min(x1, nx - 1); gx++) visit(gx, gy);
        } else {
          if (x0 >= 0) visit(x0, gy);
          if (x1 < nx) visit(x1, gy);
        }
      }
      if (x0 <= 0 && y0 <= 0 && x1 >= nx - 1 && y1 >= ny - 1) break;
      if (heap.full()) {
        // Anything not yet visited lies outside the searched block of cells.
        let gap = Infinity;
        if (x0 > 0) gap = Math.min(gap, px - (minX + x0 * size));
        if (x1 < nx - 1) gap = Math.min(gap, minX + (x1 + 1) * size - px);
        if (y0 > 0) gap = Math.min(gap, py - (minY + y0 * size));
        if (y1 < ny - 1) gap = Math.min(gap, minY + (y1 + 1) * size - py);
        if (gap * gap >= heap.worst()) break;
      }
    }
    heap.drainInto(out, i * k);
    if ((i & 4095) === 0) progress(i / n, 'Finding spatial neighbours');
  }
  progress(1, 'Finding spatial neighbours');
  return out;
}

/** A bounded max-heap of (distance, index): keeps the k smallest distances offered. */
class KnnHeap {
  private readonly dist: Float64Array;
  private readonly index: Int32Array;
  private size = 0;

  constructor(private readonly k: number) {
    this.dist = new Float64Array(k);
    this.index = new Int32Array(k);
  }

  clear() {
    this.size = 0;
  }

  full() {
    return this.size === this.k;
  }

  worst() {
    return this.dist[0];
  }

  offer(d: number, j: number) {
    const { dist, index } = this;
    if (this.size < this.k) {
      let c = this.size++;
      while (c > 0) {
        const parent = (c - 1) >> 1;
        if (dist[parent] >= d) break;
        dist[c] = dist[parent];
        index[c] = index[parent];
        c = parent;
      }
      dist[c] = d;
      index[c] = j;
    } else if (d < dist[0]) {
      this.siftDown(d, j, this.k);
    }
  }

  /** Writes the kept indices to `out[at..at+k)`, nearest first, emptying the heap. */
  drainInto(out: Int32Array, at: number) {
    for (let last = this.size - 1; last >= 0; last--) {
      out[at + last] = this.index[0];
      this.siftDown(this.dist[last], this.index[last], last);
    }
    this.size = 0;
  }

  private siftDown(d: number, j: number, size: number) {
    const { dist, index } = this;
    let c = 0;
    for (;;) {
      let child = 2 * c + 1;
      if (child >= size) break;
      if (child + 1 < size && dist[child + 1] > dist[child]) child++;
      if (dist[child] <= d) break;
      dist[c] = dist[child];
      index[c] = index[child];
      c = child;
    }
    dist[c] = d;
    index[c] = j;
  }
}

export interface MoranResult {
  gene: string;
  I: number;
  z: number;
  // One-sided, in the direction of z, as squidpy's default `pval_norm` (two_tailed=False).
  pval: number;
  padj: number;
}

/** Moran's I per gene with row-standardised kNN weights and the analytical variance under
 * normality (Cliff & Ord; squidpy/PySAL `pval_norm`), sorted by I, highest first. Genes
 * detected (nonzero) in fewer than `minCells` cells, or constant, are not tested. */
export function moransI(
  m: ExpressionMatrix, neighbors: Int32Array, k: number, opts: { minCells: number }, progress: Progress = silent,
): MoranResult[] {
  const n = m.nCells;
  if (neighbors.length !== n * k) throw new RangeError(`expected ${n * k} neighbour indices, got ${neighbors.length}`);
  const inDegree = new Float64Array(n);
  for (const j of neighbors) inDegree[j]++;

  // Weight-matrix moments for w_ij = 1/k: s0 = n; s1 sums (w_ij + w_ji)^2 over pairs,
  // which is 2/k^2 per edge whose reverse also exists and 1/k^2 per one-way edge.
  let s1 = 0;
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      const j = neighbors[i * k + a];
      let mutual = false;
      for (let b = 0; b < k; b++) if (neighbors[j * k + b] === i) mutual = true;
      s1 += mutual ? 2 : 1;
    }
  }
  s1 /= k * k;
  let s2 = 0;
  for (let i = 0; i < n; i++) s2 += (1 + inDegree[i] / k) ** 2;
  const s0 = n;
  const expected = -1 / (n - 1);
  const variance = (n * n * s1 - n * s2 + 3 * s0 * s0) / ((n - 1) * (n + 1) * s0 * s0) - expected * expected;
  const se = Math.sqrt(variance);

  const { genes, indptr, indices, data } = m;
  const detected = cellsDetected(m);
  const dense = new Float64Array(n);
  const tested: { gene: string; I: number; z: number; pval: number }[] = [];
  for (let g = 0; g < genes.length; g++) {
    progress(g / genes.length, "Computing Moran's I");
    if (detected[g] < opts.minCells) continue;
    const begin = indptr[g];
    const end = indptr[g + 1];
    let sum = 0;
    let colWeighted = 0;
    for (let p = begin; p < end; p++) {
      const v = data[p];
      dense[indices[p]] = v;
      sum += v;
      colWeighted += v * inDegree[indices[p]];
    }
    const mean = sum / n;
    // Sum over i of x_i times the sum of x over i's neighbours: only nonzero x_i contribute.
    let lagged = 0;
    let squares = (n - (end - begin)) * mean * mean;
    for (let p = begin; p < end; p++) {
      const i = indices[p];
      let neighbourSum = 0;
      for (let a = 0; a < k; a++) neighbourSum += dense[neighbors[i * k + a]];
      lagged += data[p] * neighbourSum;
      squares += (data[p] - mean) ** 2;
    }
    for (let p = begin; p < end; p++) dense[indices[p]] = 0;
    if (!(squares > 0)) continue;
    // sum_ij w_ij (x_i - mean)(x_j - mean), expanded so only the sparse terms are summed.
    const cross = lagged / k - mean * (colWeighted / k) - mean * sum + mean * mean * n;
    const I = cross / squares;
    const z = (I - expected) / se;
    tested.push({ gene: genes[g], I, z, pval: z > 0 ? normalSf(z) : normalSf(-z) });
  }
  progress(1, "Computing Moran's I");
  const padj = benjaminiHochberg(tested.map((t) => t.pval));
  return tested.map((t, i) => ({ ...t, padj: padj[i] })).sort((a, b) => b.I - a.I);
}

export interface NeighborhoodEnrichment {
  // nCategories × nCategories, row-major: edges from a cell of the row category to a
  // neighbour of the column category.
  counts: Float64Array;
  // (count − permutation mean) / permutation standard deviation; NaN where every
  // permutation gave the same count.
  z: Float64Array;
}

/** squidpy `nhood_enrichment`: neighbour-pair counts by category against random
 * relabelings. Cells with a negative code keep their place in the graph but are never
 * counted, and the permutations shuffle labels among the labelled cells only. */
export function neighborhoodEnrichment(
  codes: Int32Array, nCategories: number, neighbors: Int32Array, k: number, permutations: number, seed: number,
  progress: Progress = silent,
): NeighborhoodEnrichment {
  const n = codes.length;
  if (neighbors.length !== n * k) throw new RangeError(`expected ${n * k} neighbour indices, got ${neighbors.length}`);
  for (const code of codes) if (code >= nCategories) throw new RangeError(`category code ${code} is outside 0..${nCategories - 1}`);
  const pairCount = nCategories * nCategories;
  const count = (labels: Int32Array, into: Float64Array) => {
    into.fill(0);
    for (let i = 0; i < n; i++) {
      const a = labels[i];
      if (a < 0) continue;
      for (let e = i * k; e < i * k + k; e++) {
        const b = labels[neighbors[e]];
        if (b >= 0) into[a * nCategories + b]++;
      }
    }
  };
  const counts = new Float64Array(pairCount);
  count(codes, counts);

  const labelledCells = Int32Array.from(codes.keys()).filter((i) => codes[i] >= 0);
  const labels = codes.filter((code) => code >= 0);
  const permuted = Int32Array.from(codes);
  const random = mulberry32(seed);
  const trial = new Float64Array(pairCount);
  // Welford's running mean and sum of squared deviations.
  const mean = new Float64Array(pairCount);
  const m2 = new Float64Array(pairCount);
  for (let p = 1; p <= permutations; p++) {
    shuffle(labels, random);
    labelledCells.forEach((cell, t) => {
      permuted[cell] = labels[t];
    });
    count(permuted, trial);
    for (let c = 0; c < pairCount; c++) {
      const delta = trial[c] - mean[c];
      mean[c] += delta / p;
      m2[c] += delta * (trial[c] - mean[c]);
    }
    progress(p / permutations, 'Permuting labels');
  }
  const z = new Float64Array(pairCount);
  for (let c = 0; c < pairCount; c++) {
    const sd = Math.sqrt(m2[c] / permutations);
    z[c] = sd > 0 ? (counts[c] - mean[c]) / sd : NaN;
  }
  return { counts, z };
}

/** Each cell's neighbourhood make-up: the fraction of each category among the labelled
 * cells in {the cell itself and its k neighbours}, row-major n × nCategories. A cell with
 * no labelled cell in its neighbourhood gets an all-zero row. */
export function nicheComposition(codes: Int32Array, nCategories: number, neighbors: Int32Array, k: number): Float32Array {
  const n = codes.length;
  if (neighbors.length !== n * k) throw new RangeError(`expected ${n * k} neighbour indices, got ${neighbors.length}`);
  const out = new Float32Array(n * nCategories);
  for (let i = 0; i < n; i++) {
    let labelled = 0;
    const add = (code: number) => {
      if (code < 0) return;
      out[i * nCategories + code]++;
      labelled++;
    };
    add(codes[i]);
    for (let e = i * k; e < i * k + k; e++) add(codes[neighbors[e]]);
    if (labelled > 0) for (let c = 0; c < nCategories; c++) out[i * nCategories + c] /= labelled;
  }
  return out;
}

/** Lloyd's k-means with k-means++ seeding on row-major n × dim data; labels are
 * renumbered so cluster 0 is the largest. Stops when no point changes cluster. */
export function kmeans(
  data: Float32Array, n: number, dim: number, nClusters: number, seed: number, maxIter = 300, progress: Progress = silent,
): Int32Array {
  if (data.length !== n * dim) throw new RangeError(`expected ${n * dim} values, got ${data.length}`);
  if (!(nClusters >= 1 && nClusters <= n)) throw new RangeError(`nClusters must be between 1 and ${n}, got ${nClusters}`);
  const random = mulberry32(seed);
  const centres = new Float64Array(nClusters * dim);
  const distanceTo = (i: number, c: number) => {
    let d = 0;
    for (let t = 0; t < dim; t++) {
      const diff = data[i * dim + t] - centres[c * dim + t];
      d += diff * diff;
    }
    return d;
  };
  const setCentre = (c: number, i: number) => {
    for (let t = 0; t < dim; t++) centres[c * dim + t] = data[i * dim + t];
  };

  // k-means++: each further centre is drawn with probability proportional to the squared
  // distance from the nearest centre chosen so far.
  const nearest = new Float64Array(n);
  setCentre(0, randomInt(random, n));
  for (let i = 0; i < n; i++) nearest[i] = distanceTo(i, 0);
  for (let c = 1; c < nClusters; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) total += nearest[i];
    let pick = randomInt(random, n);
    if (total > 0) {
      let target = random() * total;
      for (let i = 0; i < n; i++) {
        target -= nearest[i];
        if (target <= 0 && nearest[i] > 0) {
          pick = i;
          break;
        }
      }
    }
    setCentre(c, pick);
    for (let i = 0; i < n; i++) nearest[i] = Math.min(nearest[i], distanceTo(i, c));
  }

  const labels = new Int32Array(n).fill(-1);
  const sums = new Float64Array(nClusters * dim);
  const sizes = new Float64Array(nClusters);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < nClusters; c++) {
        const d = distanceTo(i, c);
        if (d < bestDistance) {
          bestDistance = d;
          best = c;
        }
      }
      nearest[i] = bestDistance;
      if (labels[i] !== best) {
        labels[i] = best;
        changed++;
      }
    }
    progress(iter / maxIter, `k-means iteration ${iter + 1}`);
    if (changed === 0) break;
    sums.fill(0);
    sizes.fill(0);
    for (let i = 0; i < n; i++) {
      const c = labels[i];
      sizes[c]++;
      for (let t = 0; t < dim; t++) sums[c * dim + t] += data[i * dim + t];
    }
    for (let c = 0; c < nClusters; c++) {
      if (sizes[c] > 0) {
        for (let t = 0; t < dim; t++) centres[c * dim + t] = sums[c * dim + t] / sizes[c];
        continue;
      }
      // An emptied cluster restarts at the point worst served by its current centre.
      let far = 0;
      for (let i = 1; i < n; i++) if (nearest[i] > nearest[far]) far = i;
      setCentre(c, far);
      nearest[far] = 0;
    }
  }
  progress(1, 'k-means');
  return relabelBySize(labels);
}
