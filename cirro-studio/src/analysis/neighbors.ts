// scanpy's `pp.neighbors`: approximate k nearest neighbours in PCA space (NN-descent, as
// pynndescent) and UMAP connectivities on them.
import type { WeightedGraph } from './leiden';
import { silent, type Progress } from './progress';
import { mulberry32, randomInt, type Random } from './random';

export interface KnnGraph {
  // Row-major n × k, nearest first, self excluded.
  indices: Int32Array;
  // Euclidean distances matching `indices`.
  distances: Float32Array;
}

const NN_DESCENT_DELTA = 0.001;

/** Approximate k nearest neighbours (self excluded) by NN-descent (Dong, Moses & Li
 * 2011) started from random-projection-tree leaves, with the tree and iteration counts
 * scanpy passes to pynndescent and its stopping threshold. Each round samples up to 2k
 * candidates per point where pynndescent samples k: on noisy 50-PC data (a Xenium
 * panel) that lifts recall from 0.94 to 0.97, above pynndescent's 0.95, for about a
 * quarter more time. */
export function knnGraph(points: Float32Array, n: number, dim: number, k: number, seed: number, progress: Progress = silent): KnnGraph {
  if (points.length !== n * dim) throw new RangeError(`expected ${n * dim} values, got ${points.length}`);
  if (!(k >= 1 && k < n)) throw new RangeError(`k must be between 1 and ${n - 1}, got ${k}`);
  const random = mulberry32(seed);
  // Squared Euclidean distance, four lanes at a time (most of the run time is spent here).
  const distance = (a: number, b: number) => {
    const oa = a * dim;
    const ob = b * dim;
    let d0 = 0;
    let d1 = 0;
    let d2 = 0;
    let d3 = 0;
    let t = 0;
    for (; t + 3 < dim; t += 4) {
      const x0 = points[oa + t] - points[ob + t];
      const x1 = points[oa + t + 1] - points[ob + t + 1];
      const x2 = points[oa + t + 2] - points[ob + t + 2];
      const x3 = points[oa + t + 3] - points[ob + t + 3];
      d0 += x0 * x0;
      d1 += x1 * x1;
      d2 += x2 * x2;
      d3 += x3 * x3;
    }
    for (; t < dim; t++) {
      const x = points[oa + t] - points[ob + t];
      d0 += x * x;
    }
    return d0 + d1 + d2 + d3;
  };
  const heaps = new FlaggedHeaps(n, k);

  const nTrees = Math.min(64, 5 + Math.round(Math.sqrt(n) / 20));
  const leafSize = Math.max(10, k);
  for (let tree = 0; tree < nTrees; tree++) {
    const { order, leaves } = randomProjectionLeaves(points, n, dim, leafSize, random);
    for (let l = 0; l < leaves.length; l += 2) {
      for (let x = leaves[l]; x < leaves[l + 1]; x++) {
        for (let y = x + 1; y < leaves[l + 1]; y++) {
          const a = order[x];
          const b = order[y];
          const d = distance(a, b);
          heaps.push(a, d, b);
          heaps.push(b, d, a);
        }
      }
    }
    progress((0.3 * (tree + 1)) / nTrees, 'Building neighbour graph');
  }
  for (let i = 0; i < n; i++) {
    while (heaps.count(i) < k) {
      const j = randomInt(random, n);
      if (j !== i) heaps.push(i, distance(i, j), j);
    }
  }

  const maxIterations = Math.max(5, Math.round(Math.log2(n)));
  const maxCandidates = Math.min(60, 2 * k);
  const fresh = new CandidateLists(n, maxCandidates);
  const old = new CandidateLists(n, maxCandidates);
  for (let iter = 0; iter < maxIterations; iter++) {
    fresh.clear();
    old.clear();
    for (let i = 0; i < n; i++) {
      for (let s = i * k; s < i * k + k; s++) {
        const j = heaps.index[s];
        const priority = random();
        const lists = heaps.isNew[s] ? fresh : old;
        lists.push(i, priority, j);
        lists.push(j, priority, i);
      }
    }
    // A neighbour that made it into the sampled new candidates has now been tried.
    for (let i = 0; i < n; i++) {
      for (let s = i * k; s < i * k + k; s++) if (heaps.isNew[s] && fresh.has(i, heaps.index[s])) heaps.isNew[s] = 0;
    }
    let updates = 0;
    for (let i = 0; i < n; i++) {
      const base = i * maxCandidates;
      for (let x = 0; x < maxCandidates; x++) {
        const a = fresh.index[base + x];
        if (a < 0) continue;
        for (let y = x + 1; y < maxCandidates; y++) {
          const b = fresh.index[base + y];
          if (b < 0) continue;
          const d = distance(a, b);
          updates += heaps.push(a, d, b) + heaps.push(b, d, a);
        }
        for (let y = 0; y < maxCandidates; y++) {
          const b = old.index[base + y];
          if (b < 0 || b === a) continue;
          const d = distance(a, b);
          updates += heaps.push(a, d, b) + heaps.push(b, d, a);
        }
      }
    }
    progress(0.3 + (0.7 * (iter + 1)) / maxIterations, 'Building neighbour graph');
    if (updates <= NN_DESCENT_DELTA * k * n) break;
  }
  progress(1, 'Building neighbour graph');
  return heaps.sorted();
}

/** Per-point bounded max-heaps of (squared distance, index) with a "not yet joined" flag,
 * as pynndescent's flagged heaps; `push` ignores duplicates and returns 1 on a change. */
class FlaggedHeaps {
  readonly index: Int32Array;
  readonly dist: Float32Array;
  readonly isNew: Uint8Array;

  constructor(private readonly n: number, private readonly k: number) {
    this.index = new Int32Array(n * k).fill(-1);
    this.dist = new Float32Array(n * k).fill(Infinity);
    this.isNew = new Uint8Array(n * k);
  }

  count(i: number): number {
    let filled = 0;
    for (let s = i * this.k; s < (i + 1) * this.k; s++) if (this.index[s] >= 0) filled++;
    return filled;
  }

  push(i: number, d: number, j: number): number {
    const { index, dist, isNew, k } = this;
    const base = i * k;
    if (!(d < dist[base])) return 0;
    for (let s = base; s < base + k; s++) if (index[s] === j) return 0;
    let c = 0;
    for (;;) {
      let child = 2 * c + 1;
      if (child >= k) break;
      if (child + 1 < k && dist[base + child + 1] > dist[base + child]) child++;
      if (dist[base + child] <= d) break;
      dist[base + c] = dist[base + child];
      index[base + c] = index[base + child];
      isNew[base + c] = isNew[base + child];
      c = child;
    }
    dist[base + c] = d;
    index[base + c] = j;
    isNew[base + c] = 1;
    return 1;
  }

  /** Each point's neighbours nearest first, with Euclidean (not squared) distances. */
  sorted(): KnnGraph {
    const { n, k } = this;
    const indices = new Int32Array(n * k);
    const distances = new Float32Array(n * k);
    const order = Array.from({ length: k }, (_, s) => s);
    for (let i = 0; i < n; i++) {
      const base = i * k;
      order.sort((a, b) => this.dist[base + a] - this.dist[base + b]);
      order.forEach((s, t) => {
        indices[base + t] = this.index[base + s];
        distances[base + t] = Math.sqrt(this.dist[base + s]);
      });
    }
    return { indices, distances };
  }
}

/** Per-point candidate lists keeping the entries with the smallest random priorities, a
 * uniform sample of at most `size` candidates without duplicates. */
class CandidateLists {
  readonly index: Int32Array;
  private readonly priority: Float32Array;

  constructor(n: number, private readonly size: number) {
    this.index = new Int32Array(n * size);
    this.priority = new Float32Array(n * size);
  }

  clear() {
    this.index.fill(-1);
    this.priority.fill(Infinity);
  }

  has(i: number, j: number): boolean {
    for (let s = i * this.size; s < (i + 1) * this.size; s++) if (this.index[s] === j) return true;
    return false;
  }

  push(i: number, priority: number, j: number) {
    const { index, size } = this;
    const pri = this.priority;
    const base = i * size;
    if (!(priority < pri[base])) return;
    for (let s = base; s < base + size; s++) if (index[s] === j) return;
    let c = 0;
    for (;;) {
      let child = 2 * c + 1;
      if (child >= size) break;
      if (child + 1 < size && pri[base + child + 1] > pri[base + child]) child++;
      if (pri[base + child] <= priority) break;
      pri[base + c] = pri[base + child];
      index[base + c] = index[base + child];
      c = child;
    }
    pri[base + c] = priority;
    index[base + c] = j;
  }
}

/** One random-projection tree: points split recursively by the hyperplane equidistant
 * from two random members until at most `leafSize` remain. Returns a permutation of the
 * points and the [start, end) range of each leaf in it. */
function randomProjectionLeaves(points: Float32Array, n: number, dim: number, leafSize: number, random: Random) {
  const order = Int32Array.from({ length: n }, (_, i) => i);
  const side = new Uint8Array(n);
  const normal = new Float64Array(dim);
  const leaves: number[] = [];
  const stack = [0, n];
  while (stack.length > 0) {
    const hi = stack.pop()!;
    const lo = stack.pop()!;
    const size = hi - lo;
    if (size <= leafSize) {
      leaves.push(lo, hi);
      continue;
    }
    const first = randomInt(random, size);
    let second = randomInt(random, size - 1);
    if (second >= first) second++;
    const a = order[lo + first];
    const b = order[lo + second];
    let offset = 0;
    for (let t = 0; t < dim; t++) {
      normal[t] = points[a * dim + t] - points[b * dim + t];
      offset -= (normal[t] * (points[a * dim + t] + points[b * dim + t])) / 2;
    }
    let left = 0;
    for (let x = lo; x < hi; x++) {
      const i = order[x];
      let margin = offset;
      for (let t = 0; t < dim; t++) margin += normal[t] * points[i * dim + t];
      side[i] = margin > 0 || (margin === 0 && random() < 0.5) ? 1 : 0;
      left += side[i];
    }
    // Coincident points give no usable hyperplane: split them at random instead.
    if (left === 0 || left === size) {
      left = 0;
      for (let x = lo; x < hi; x++) {
        side[order[x]] = random() < 0.5 ? 1 : 0;
        left += side[order[x]];
      }
      if (left === 0 || left === size) {
        left = size >> 1;
        for (let x = lo; x < hi; x++) side[order[x]] = x - lo < left ? 1 : 0;
      }
    }
    let write = lo;
    for (let x = lo; x < hi; x++) {
      if (side[order[x]] === 1) {
        const t = order[write];
        order[write] = order[x];
        order[x] = t;
        write++;
      }
    }
    stack.push(lo, write, write, hi);
  }
  return { order, leaves };
}

/** scanpy's connectivities: UMAP's fuzzy simplicial set (`fuzzy_simplicial_set`,
 * local_connectivity 1, set_op_mix_ratio 1) on a kNN graph whose k neighbours exclude
 * self, so it corresponds to scanpy's `n_neighbors = k + 1`. Symmetric, no self-loops. */
export function umapConnectivities(knn: KnnGraph, n: number, k: number): WeightedGraph {
  const { indices, distances } = knn;
  const target = Math.log2(k + 1);
  let meanAll = 0;
  for (const d of distances) meanAll += d;
  meanAll /= n * (k + 1);
  const membership = new Float64Array(n * k);
  for (let i = 0; i < n; i++) {
    const base = i * k;
    let rho = 0;
    for (let s = base; s < base + k; s++) {
      if (distances[s] > 0) {
        rho = distances[s];
        break;
      }
    }
    let lo = 0;
    let hi = Infinity;
    let sigma = 1;
    for (let iter = 0; iter < 64; iter++) {
      let psum = 0;
      for (let s = base; s < base + k; s++) {
        const d = distances[s] - rho;
        psum += d > 0 ? Math.exp(-d / sigma) : 1;
      }
      if (Math.abs(psum - target) < 1e-5) break;
      if (psum > target) {
        hi = sigma;
        sigma = (lo + hi) / 2;
      } else {
        lo = sigma;
        sigma = hi === Infinity ? sigma * 2 : (lo + hi) / 2;
      }
    }
    let meanOwn = 0;
    for (let s = base; s < base + k; s++) meanOwn += distances[s];
    meanOwn /= k + 1;
    sigma = Math.max(sigma, 1e-3 * (rho > 0 ? meanOwn : meanAll));
    for (let s = base; s < base + k; s++) {
      const d = distances[s] - rho;
      membership[s] = d <= 0 ? 1 : Math.exp(-d / sigma);
    }
  }

  // Fuzzy union a + b − ab over the two directions of each edge, as CSR.
  const degree = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    for (let s = i * k; s < i * k + k; s++) {
      degree[i + 1]++;
      degree[indices[s] + 1]++;
    }
  }
  for (let i = 0; i < n; i++) degree[i + 1] += degree[i];
  const fill = degree.slice(0, n);
  const column = new Int32Array(degree[n]);
  const weight = new Float64Array(degree[n]);
  for (let i = 0; i < n; i++) {
    for (let s = i * k; s < i * k + k; s++) {
      const j = indices[s];
      column[fill[i]] = j;
      weight[fill[i]++] = membership[s];
      column[fill[j]] = i;
      weight[fill[j]++] = membership[s];
    }
  }
  const indptr = new Int32Array(n + 1);
  const neighbor: number[] = [];
  const edgeWeight: number[] = [];
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    order.length = 0;
    for (let e = degree[i]; e < degree[i + 1]; e++) order.push(e);
    order.sort((a, b) => column[a] - column[b]);
    for (let x = 0; x < order.length; x++) {
      const j = column[order[x]];
      let w = weight[order[x]];
      if (x + 1 < order.length && column[order[x + 1]] === j) {
        const other = weight[order[++x]];
        w = w + other - w * other;
      }
      neighbor.push(j);
      edgeWeight.push(w);
    }
    indptr[i + 1] = neighbor.length;
  }
  return { indptr, indices: Int32Array.from(neighbor), weights: Float64Array.from(edgeWeight) };
}
