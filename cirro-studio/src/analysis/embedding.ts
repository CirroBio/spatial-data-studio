// Expression space for clustering, as scanpy's `highly_variable_genes` (Seurat flavour)
// and `scale(max_value=10)` + `pca`.
import type { ExpressionMatrix } from '@cirrobio/spatial-viewer';
import { leadingEigenpairs } from './eigen';
import { geneMoments } from './matrix';
import { silent, type Progress } from './progress';
import { mulberry32 } from './random';

const HVG_BINS = 20;

/** The `nTop` genes with the highest normalized dispersion, scanpy's
 * `highly_variable_genes(flavor='seurat')` on log-normalized data: dispersion is
 * var/mean of expm1(x), logged and z-scored within 20 equal-width bins of log1p(mean).
 * Returns gene indices in ascending order; every gene when nTop >= the gene count. */
export function highlyVariableGenes(m: ExpressionMatrix, nTop: number): number[] {
  const nGenes = m.genes.length;
  if (nTop >= nGenes) return Array.from({ length: nGenes }, (_, g) => g);
  const { mean, variance } = geneMoments(m, Math.expm1);
  const logMean = new Float64Array(nGenes);
  const dispersion = new Float64Array(nGenes);
  let lo = Infinity;
  let hi = -Infinity;
  for (let g = 0; g < nGenes; g++) {
    const mu = mean[g] === 0 ? 1e-12 : mean[g];
    const d = variance[g] / mu;
    dispersion[g] = d === 0 ? NaN : Math.log(d);
    logMean[g] = Math.log1p(mu);
    lo = Math.min(lo, logMean[g]);
    hi = Math.max(hi, logMean[g]);
  }
  // pd.cut's right-closed intervals: a mean on an inner edge belongs to the lower bin.
  const bin = Int32Array.from(logMean, (v) =>
    hi > lo ? Math.min(HVG_BINS - 1, Math.max(0, Math.ceil(((v - lo) / (hi - lo)) * HVG_BINS) - 1)) : 0);
  const count = new Float64Array(HVG_BINS);
  const sum = new Float64Array(HVG_BINS);
  for (let g = 0; g < nGenes; g++) {
    if (Number.isNaN(dispersion[g])) continue;
    count[bin[g]]++;
    sum[bin[g]] += dispersion[g];
  }
  const avg = Float64Array.from(sum, (s, b) => s / count[b]);
  const squares = new Float64Array(HVG_BINS);
  for (let g = 0; g < nGenes; g++) {
    if (!Number.isNaN(dispersion[g])) squares[bin[g]] += (dispersion[g] - avg[bin[g]]) ** 2;
  }
  const normalized = Float64Array.from(dispersion, (d, g) => {
    const b = bin[g];
    if (Number.isNaN(d)) return NaN;
    // scanpy gives a gene alone in its bin a normalized dispersion of 1.
    if (count[b] === 1) return 1;
    return (d - avg[b]) / Math.sqrt(squares[b] / (count[b] - 1));
  });
  return Array.from({ length: nGenes }, (_, g) => g)
    .filter((g) => !Number.isNaN(normalized[g]))
    .sort((a, b) => normalized[b] - normalized[a])
    .slice(0, nTop)
    .sort((a, b) => a - b);
}

export interface Pca {
  // Row-major n × nComps.
  scores: Float32Array;
  // Variance of each component's scores (ddof = 1).
  variance: Float64Array;
  varianceRatio: Float64Array;
}

const MAX_SCALED = 10;
// The gene × gene covariance is held densely: 5000 genes is 200 MB.
const MAX_PCA_GENES = 5000;
// Cells gathered at a time when summing per-cell outer products.
const CELL_BLOCK = 4096;

/** PCA of the selected genes after scanpy's `scale(max_value=10)`: each gene centred,
 * divided by its standard deviation and clipped to ±10, then centred again (as the PCA
 * itself does). The scaled matrix is never formed: it is a sparse matrix of offsets from
 * each gene's scaled zero, minus a per-gene constant, so the gene × gene covariance is
 * summed from each cell's stored entries alone. Its leading eigenvectors come from
 * Lanczos with full reorthogonalization, which converges on the trailing components of a
 * flat spectrum where randomized subspace iteration does not (scanpy uses ARPACK, an
 * exact solver). Each component's sign makes its largest gene loading positive. */
export function pca(m: ExpressionMatrix, genes: number[], nComps: number, seed: number, progress: Progress = silent): Pca {
  const n = m.nCells;
  const p = genes.length;
  if (!(nComps >= 1 && nComps <= Math.min(n - 1, p))) {
    throw new RangeError(`nComps must be between 1 and ${Math.min(n - 1, p)}, got ${nComps}`);
  }
  if (p > MAX_PCA_GENES) throw new RangeError(`PCA takes at most ${MAX_PCA_GENES} genes, got ${p}`);
  const { indptr, indices, data } = m;
  const moments = geneMoments(m);
  const centre = Float64Array.from(genes, (g) => moments.mean[g]);
  const scale = Float64Array.from(genes, (g) => Math.sqrt(moments.variance[g]) || 1);
  const zeroValue = Float64Array.from({ length: p }, (_, j) => clip(-centre[j] / scale[j]));
  // A stored entry's scaled value relative to its gene's scaled zero.
  const offset = (j: number, q: number) => clip((data[q] - centre[j]) / scale[j]) - zeroValue[j];
  // Mean offset per gene: the centred matrix is (offsets at stored entries) − meanOffset.
  const meanOffset = new Float64Array(p);
  genes.forEach((g, j) => {
    for (let q = indptr[g]; q < indptr[g + 1]; q++) meanOffset[j] += offset(j, q) / n;
  });

  // covariance × (n − 1) = Σ over cells of (offset outer products) − n · meanOffset meanOffsetᵀ.
  // Cells are gathered a block at a time (each gene keeps a cursor; cells ascend within a
  // gene), so every cell's entries come out in gene order and fill the upper triangle.
  const cov = new Float64Array(p * p);
  const cursor = Float64Array.from(genes, (g) => indptr[g]);
  const rowStart = new Int32Array(CELL_BLOCK + 1);
  const fill = new Int32Array(CELL_BLOCK);
  let geneOf = new Int32Array(1024);
  let valueOf = new Float64Array(1024);
  for (let lo = 0; lo < n; lo += CELL_BLOCK) {
    const hi = Math.min(n, lo + CELL_BLOCK);
    rowStart.fill(0);
    for (let j = 0; j < p; j++) {
      const end = indptr[genes[j] + 1];
      for (let q = cursor[j]; q < end && indices[q] < hi; q++) rowStart[indices[q] - lo + 1]++;
    }
    for (let c = 0; c < hi - lo; c++) rowStart[c + 1] += rowStart[c];
    const count = rowStart[hi - lo];
    if (count > geneOf.length) {
      geneOf = new Int32Array(count);
      valueOf = new Float64Array(count);
    }
    fill.set(rowStart.subarray(0, CELL_BLOCK));
    for (let j = 0; j < p; j++) {
      const end = indptr[genes[j] + 1];
      let q = cursor[j];
      for (; q < end && indices[q] < hi; q++) {
        const at = fill[indices[q] - lo]++;
        geneOf[at] = j;
        valueOf[at] = offset(j, q);
      }
      cursor[j] = q;
    }
    for (let c = 0; c < hi - lo; c++) {
      for (let a = rowStart[c]; a < rowStart[c + 1]; a++) {
        const row = geneOf[a] * p;
        const ea = valueOf[a];
        for (let b = a; b < rowStart[c + 1]; b++) cov[row + geneOf[b]] += ea * valueOf[b];
      }
    }
    progress((0.8 * hi) / n, 'Computing principal components');
  }
  let trace = 0;
  for (let a = 0; a < p; a++) {
    for (let b = a; b < p; b++) {
      const v = cov[a * p + b] - n * meanOffset[a] * meanOffset[b];
      cov[a * p + b] = v;
      cov[b * p + a] = v;
    }
    trace += cov[a * p + a];
  }

  const { values, vectors } = leadingEigenpairs(cov, p, nComps, mulberry32(seed));
  progress(0.9, 'Computing principal components');
  for (let t = 0; t < nComps; t++) {
    let largest = 0;
    for (let j = 0; j < p; j++) if (Math.abs(vectors[j * nComps + t]) > Math.abs(largest)) largest = vectors[j * nComps + t];
    if (largest < 0) for (let j = 0; j < p; j++) vectors[j * nComps + t] = -vectors[j * nComps + t];
  }

  // scores = offsets × loadings − meanOffsetᵀ × loadings (the same for every cell).
  const rowShift = new Float64Array(nComps);
  for (let j = 0; j < p; j++) for (let t = 0; t < nComps; t++) rowShift[t] -= meanOffset[j] * vectors[j * nComps + t];
  const scores = new Float32Array(n * nComps);
  for (let c = 0; c < n; c++) scores.set(rowShift, c * nComps);
  genes.forEach((g, j) => {
    for (let q = indptr[g]; q < indptr[g + 1]; q++) {
      const e = offset(j, q);
      const o = indices[q] * nComps;
      for (let t = 0; t < nComps; t++) scores[o + t] += e * vectors[j * nComps + t];
    }
  });
  const variance = Float64Array.from({ length: nComps }, (_, t) => Math.max(0, values[t]) / (n - 1));
  progress(1, 'Computing principal components');
  return { scores, variance, varianceRatio: variance.map((v) => (v * (n - 1)) / trace) };
}

function clip(v: number): number {
  return v > MAX_SCALED ? MAX_SCALED : v < -MAX_SCALED ? -MAX_SCALED : v;
}
