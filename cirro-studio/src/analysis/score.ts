// Gene-signature scores, as scanpy `tl.score_genes` (the Seurat AddModuleScore approach).
import type { ExpressionMatrix } from '@cirrobio/spatial-viewer';
import { mulberry32, shuffle } from './random';
import { roundHalfEven } from './stats';

export interface ScoreOptions {
  ctrlSize?: number;
  nBins?: number;
}

/** Per cell: the mean of the signature genes minus the mean of a control set. Genes are
 * ranked by mean expression and cut into `nBins` groups of about equal size; from every
 * group holding a signature gene, `ctrlSize` genes are drawn at random (signature genes
 * may be drawn, then dropped), and the union of the draws is the control set. */
export function scoreGenes(m: ExpressionMatrix, geneIdx: number[], seed: number, options: ScoreOptions = {}): Float32Array {
  const { ctrlSize = 50, nBins = 25 } = options;
  const nGenes = m.genes.length;
  const signature = [...new Set(geneIdx)];
  if (signature.length === 0) throw new Error('No genes were given to score.');
  for (const g of signature) if (!(g >= 0 && g < nGenes)) throw new RangeError(`gene index ${g} is outside 0..${nGenes - 1}`);
  const { nCells, indptr, data } = m;

  const mean = new Float64Array(nGenes);
  for (let g = 0; g < nGenes; g++) {
    let sum = 0;
    for (let p = indptr[g]; p < indptr[g + 1]; p++) sum += data[p];
    mean[g] = sum / nCells;
  }
  // pandas rank(method='min'): 1 + the number of genes with a strictly smaller mean.
  const byMean = Array.from({ length: nGenes }, (_, g) => g).sort((a, b) => mean[a] - mean[b]);
  const rank = new Int32Array(nGenes);
  for (let i = 0; i < nGenes; i++) {
    const g = byMean[i];
    rank[g] = i > 0 && mean[g] === mean[byMean[i - 1]] ? rank[byMean[i - 1]] : i + 1;
  }
  const nItems = roundHalfEven(nGenes / (nBins - 1));
  // With fewer genes than half the bins, pandas divides by zero and every gene shares one cut.
  const cut = Int32Array.from(rank, (r) => (nItems > 0 ? Math.floor(r / nItems) : 0));

  const isSignature = new Uint8Array(nGenes);
  for (const g of signature) isSignature[g] = 1;
  const random = mulberry32(seed);
  const control = new Set<number>();
  for (const c of new Set(signature.map((g) => cut[g]))) {
    const pool = Int32Array.from(byMean.filter((g) => cut[g] === c));
    shuffle(pool, random);
    for (const g of pool.subarray(0, Math.min(ctrlSize, pool.length))) if (!isSignature[g]) control.add(g);
  }
  if (control.size === 0) throw new Error('No control genes share an expression bin with the signature; the panel is too small to score against.');

  const signatureMean = cellMeans(m, signature);
  const controlMean = cellMeans(m, [...control]);
  return Float32Array.from(signatureMean, (s, c) => s - controlMean[c]);
}

function cellMeans(m: ExpressionMatrix, genes: number[]): Float64Array {
  const sums = new Float64Array(m.nCells);
  for (const g of genes) for (let p = m.indptr[g]; p < m.indptr[g + 1]; p++) sums[m.indices[p]] += m.data[p];
  return sums.map((s) => s / genes.length);
}
