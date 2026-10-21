// Helpers over the viewer's gene-major (CSC) expression matrix.
import type { ExpressionMatrix } from '@cirrobio/spatial-viewer';

const COUNT_SAMPLE_SIZE = 10_000;

/** True when the stored values look like raw counts: a spread sample of the nonzeros is
 * all non-negative integers and reaches above 1 (so 0/1 indicator data does not count). */
export function looksLikeCounts(m: ExpressionMatrix): boolean {
  const { data } = m;
  if (data.length === 0) return false;
  const step = Math.max(1, Math.floor(data.length / COUNT_SAMPLE_SIZE));
  let max = 0;
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (v < 0 || !Number.isInteger(v)) return false;
    if (v > max) max = v;
  }
  return max > 1;
}

function cellTotals(m: ExpressionMatrix): Float64Array {
  const totals = new Float64Array(m.nCells);
  const { indices, data } = m;
  for (let p = 0; p < data.length; p++) totals[indices[p]] += data[p];
  return totals;
}

/** scanpy `normalize_total(target_sum=target)` followed by `log1p`. The sparsity pattern
 * is unchanged, so the result shares `indptr` and `indices` with the input. */
export function logNormalize(m: ExpressionMatrix, target = 1e4): ExpressionMatrix {
  const totals = cellTotals(m);
  const { indices, data } = m;
  const out = new Float32Array(data.length);
  for (let p = 0; p < data.length; p++) out[p] = Math.log1p((data[p] * target) / totals[indices[p]]);
  return { nCells: m.nCells, genes: m.genes, indptr: m.indptr, indices: m.indices, data: out };
}

/** Index of each name in `m.genes`, matched exactly and then case-insensitively (so a
 * human-style symbol finds its mouse-style gene); -1 where neither matches. */
export function geneIndex(m: ExpressionMatrix, names: string[]): number[] {
  const exact = new Map<string, number>();
  const folded = new Map<string, number>();
  m.genes.forEach((gene, i) => {
    if (!exact.has(gene)) exact.set(gene, i);
    const key = gene.toLowerCase();
    if (!folded.has(key)) folded.set(key, i);
  });
  return names.map((name) => exact.get(name) ?? folded.get(name.toLowerCase()) ?? -1);
}

export interface GeneMoments {
  mean: Float64Array;
  // Sample variance (ddof = 1), as scanpy's `_get_mean_var`.
  variance: Float64Array;
}

/** Mean and variance of every gene over all cells, zeros included. `transform` is applied
 * to the stored values first and must map 0 to 0 (e.g. `Math.expm1`). */
export function geneMoments(m: ExpressionMatrix, transform?: (v: number) => number): GeneMoments {
  const nGenes = m.genes.length;
  const n = m.nCells;
  const mean = new Float64Array(nGenes);
  const variance = new Float64Array(nGenes);
  const { indptr, data } = m;
  for (let g = 0; g < nGenes; g++) {
    const start = indptr[g];
    const end = indptr[g + 1];
    let sum = 0;
    for (let p = start; p < end; p++) sum += transform ? transform(data[p]) : data[p];
    const mu = sum / n;
    // Two passes, with the implicit zeros added as one term, to avoid cancellation.
    let squares = (n - (end - start)) * mu * mu;
    for (let p = start; p < end; p++) {
      const d = (transform ? transform(data[p]) : data[p]) - mu;
      squares += d * d;
    }
    mean[g] = mu;
    variance[g] = n > 1 ? squares / (n - 1) : 0;
  }
  return { mean, variance };
}

/** Number of cells with a nonzero value, per gene. */
export function cellsDetected(m: ExpressionMatrix): Int32Array {
  const nGenes = m.genes.length;
  const detected = new Int32Array(nGenes);
  const { indptr, data } = m;
  for (let g = 0; g < nGenes; g++) {
    let count = 0;
    for (let p = indptr[g]; p < indptr[g + 1]; p++) if (data[p] !== 0) count++;
    detected[g] = count;
  }
  return detected;
}
