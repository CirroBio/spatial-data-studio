// Gene patterns: genes whose expression is laid out alike on the tissue. Each gene's
// expression (log1p) is averaged over the cells in each bin of a coarse grid over the
// section, the binned maps are correlated, and the genes are clustered by average linkage
// on 1 − correlation (scipy's `linkage(method='average')` cut by `fcluster(t,
// criterion='distance')`). There is no randomness: the same genes give the same patterns.
import type { ExpressionMatrix } from '@cirrobio/spatial-viewer';
import type { Tissue } from '../charts/TissueThumb';

// Bins along the section's longer side.
export const PATTERN_GRID = 40;
// Two clusters join while their genes' maps correlate at least this well on average.
export const PATTERN_MIN_CORRELATION = 0.5;
// Fewer genes than this mapped alike is not a pattern.
export const PATTERN_MIN_GENES = 3;

/** Each cell's bin on a square grid of `grid` bins along the section's longer side, the
 * bins numbered over those that hold cells (-1 for a cell with no position), and how many
 * cells each holds. */
function gridOf({ xy, bounds: [x0, y0, x1, y1] }: Tissue, grid: number): { bin: Int32Array; cells: Float64Array } {
  const side = Math.max(x1 - x0, y1 - y0) / grid || 1;
  const n = xy.length / 2;
  const bin = new Int32Array(n).fill(-1);
  const numbered = new Int32Array(grid * grid).fill(-1);
  const cells: number[] = [];
  for (let c = 0; c < n; c++) {
    const x = xy[2 * c];
    const y = xy[2 * c + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const at = Math.min(grid - 1, Math.floor((y - y0) / side)) * grid + Math.min(grid - 1, Math.floor((x - x0) / side));
    if (numbered[at] < 0) {
      numbered[at] = cells.length;
      cells.push(0);
    }
    bin[c] = numbered[at];
    cells[bin[c]] += 1;
  }
  return { bin, cells: Float64Array.from(cells) };
}

/** A per-cell value as the patterns compare it: each cell given the mean over the cells in
 * its bin of a grid of `grid` bins along the longer side (NaN for a cell with no position). */
export function binnedMap(values: ArrayLike<number>, tissue: Tissue, grid: number): Float32Array {
  const { bin, cells } = gridOf(tissue, grid);
  const sums = new Float64Array(cells.length);
  for (let c = 0; c < bin.length; c++) if (bin[c] >= 0) sums[bin[c]] += values[c];
  return Float32Array.from(bin, (b) => (b >= 0 ? sums[b] / cells[b] : NaN));
}

/** Pearson correlation of every pair of rows of a row-major `rows` × `cols` matrix,
 * centring and scaling the rows in place. A constant row correlates 0 with everything. */
function rowCorrelations(maps: Float64Array, rows: number, cols: number): Float64Array {
  for (let r = 0; r < rows; r++) {
    const row = maps.subarray(r * cols, (r + 1) * cols);
    let mean = 0;
    for (const v of row) mean += v;
    mean /= cols;
    let norm = 0;
    for (let b = 0; b < cols; b++) {
      row[b] -= mean;
      norm += row[b] * row[b];
    }
    norm = Math.sqrt(norm);
    for (let b = 0; b < cols; b++) row[b] = norm > 0 ? row[b] / norm : 0;
  }
  const r = new Float64Array(rows * rows);
  for (let i = 0; i < rows; i++) {
    r[i * rows + i] = 1;
    for (let j = i + 1; j < rows; j++) {
      let dot = 0;
      for (let b = 0; b < cols; b++) dot += maps[i * cols + b] * maps[j * cols + b];
      r[i * rows + j] = dot;
      r[j * rows + i] = dot;
    }
  }
  return r;
}

/** Average-linkage clusters of `n` items under a symmetric distance matrix, merged while
 * the closest two clusters are at most `cut` apart: each item's cluster, named by the
 * lowest-numbered item it holds. Ties go to the lowest-numbered pair. */
function averageLinkage(distance: Float64Array, n: number, cut: number): Int32Array {
  const d = Float64Array.from(distance);
  const size = new Float64Array(n).fill(1);
  const active = new Uint8Array(n).fill(1);
  const cluster = Int32Array.from({ length: n }, (_, i) => i);
  for (;;) {
    let best = Infinity;
    let a = -1;
    let b = -1;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (active[j] && d[i * n + j] < best) {
          best = d[i * n + j];
          a = i;
          b = j;
        }
      }
    }
    if (a < 0 || best > cut) break;
    for (let c = 0; c < n; c++) {
      if (!active[c] || c === a || c === b) continue;
      const merged = (size[a] * d[a * n + c] + size[b] * d[b * n + c]) / (size[a] + size[b]);
      d[a * n + c] = merged;
      d[c * n + a] = merged;
    }
    size[a] += size[b];
    active[b] = 0;
    for (let i = 0; i < n; i++) if (cluster[i] === b) cluster[i] = a;
  }
  return cluster;
}

/** The pattern of each of `genes` (indices into the matrix) by how alike their maps on
 * the section are: patterns are numbered from 0, largest first (equal sizes in the order
 * of their first gene), and a gene in none is -1. */
export function spatialPatterns(m: ExpressionMatrix, genes: number[], tissue: Tissue): Int32Array {
  if (tissue.xy.length !== 2 * m.nCells) throw new RangeError(`expected ${m.nCells} interleaved x, y pairs, got ${tissue.xy.length} values`);
  const { bin, cells } = gridOf(tissue, PATTERN_GRID);
  const nBins = cells.length;
  const maps = new Float64Array(genes.length * nBins);
  genes.forEach((g, r) => {
    const row = maps.subarray(r * nBins, (r + 1) * nBins);
    for (let p = m.indptr[g]; p < m.indptr[g + 1]; p++) {
      const b = bin[m.indices[p]];
      if (b >= 0) row[b] += Math.log1p(m.data[p]);
    }
    for (let b = 0; b < nBins; b++) row[b] /= cells[b];
  });
  const distance = rowCorrelations(maps, genes.length, nBins).map((r) => 1 - r);
  const members = new Map<number, number[]>();
  averageLinkage(distance, genes.length, 1 - PATTERN_MIN_CORRELATION).forEach((c, i) => {
    const held = members.get(c);
    if (held) held.push(i);
    else members.set(c, [i]);
  });
  const patterns = [...members.values()].filter((g) => g.length >= PATTERN_MIN_GENES).sort((a, b) => b.length - a.length || a[0] - b[0]);
  const labels = new Int32Array(genes.length).fill(-1);
  patterns.forEach((g, p) => g.forEach((i) => { labels[i] = p; }));
  return labels;
}

// The section in thirds across and down, y down as the tissue is drawn.
const REGION_NAMES = ['top left', 'top', 'top right', 'left', 'middle', 'right', 'bottom left', 'bottom', 'bottom right'];
const ROW_EDGES = ['the top edge', null, 'the bottom edge'];
const COLUMN_EDGES = ['the left edge', null, 'the right edge'];
// A region holding fewer of the cells than this (an empty corner) is not compared.
const MIN_REGION_SHARE = 0.02;
// A region stands out when its mean is this many times the section's.
const STANDS_OUT = 1.25;
// Regions with at least this share of the highest region's mean are high too.
const NEAR_TOP = 0.8;

/** Where on the section a per-cell value is highest, in words, from its mean in each of
 * the nine regions the section's thirds across and down make. */
export function whereHigh(values: ArrayLike<number>, { xy, bounds: [x0, y0, x1, y1] }: Tissue): string {
  const sums = new Float64Array(9);
  const counts = new Float64Array(9);
  let total = 0;
  let placed = 0;
  for (let c = 0; c < xy.length / 2; c++) {
    const x = xy[2 * c];
    const y = xy[2 * c + 1];
    const v = values[c];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(v)) continue;
    const column = Math.min(2, Math.floor((3 * (x - x0)) / Math.max(x1 - x0, 1e-9)));
    const row = Math.min(2, Math.floor((3 * (y - y0)) / Math.max(y1 - y0, 1e-9)));
    sums[row * 3 + column] += v;
    counts[row * 3 + column] += 1;
    total += v;
    placed += 1;
  }
  const mean = total / Math.max(placed, 1);
  const regions = [...sums.keys()].filter((r) => counts[r] >= MIN_REGION_SHARE * placed);
  const top = Math.max(...regions.map((r) => sums[r] / counts[r]));
  if (!(mean > 0) || top < STANDS_OUT * mean) return 'in patches all over the section';
  const high = regions.filter((r) => sums[r] / counts[r] >= NEAR_TOP * top);
  const rows = new Set(high.map((r) => Math.floor(r / 3)));
  const columns = new Set(high.map((r) => r % 3));
  if (high.length === 1) return high[0] === 4 ? 'highest in the middle' : `highest toward the ${REGION_NAMES[high[0]]}`;
  if (rows.size === 1) {
    const edge = ROW_EDGES[Math.floor(high[0] / 3)];
    return edge ? `highest along ${edge}` : 'highest across the middle';
  }
  if (columns.size === 1) {
    const edge = COLUMN_EDGES[high[0] % 3];
    return edge ? `highest along ${edge}` : 'highest down the middle';
  }
  if (high.length === 2) return `highest toward the ${REGION_NAMES[high[0]]} and the ${REGION_NAMES[high[1]]}`;
  return 'high in several parts of the section';
}
