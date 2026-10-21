// Wilcoxon rank-sum marker tests, as scanpy `rank_genes_groups(method='wilcoxon',
// tie_correct=True, pts=True)` with Benjamini–Hochberg correction.
import type { ExpressionMatrix } from '@cirrobio/spatial-viewer';
import { silent, type Progress } from './progress';
import { benjaminiHochberg, twoSidedP } from './stats';

export interface GeneTest {
  gene: string;
  // Tie-corrected z of the rank-sum statistic (normal approximation, no continuity correction).
  score: number;
  // log2((expm1(meanA) + 1e-9) / (expm1(meanB) + 1e-9)), meaningful on log-normalized data.
  logfc: number;
  pval: number;
  padj: number;
  meanA: number;
  meanB: number;
  // Fraction of the group's cells with a value above zero.
  fracA: number;
  fracB: number;
}

const FOLD_EPSILON = 1e-9;

/** Group A (membership 1) against group B (membership 2); cells marked 0 are left out. */
export function compareGroups(m: ExpressionMatrix, membership: Uint8Array, progress: Progress = silent): GeneTest[] {
  const codes = new Int32Array(membership.length);
  for (let i = 0; i < membership.length; i++) codes[i] = membership[i] === 1 ? 0 : membership[i] === 2 ? 1 : -1;
  return markersForAll(m, codes, 2, progress)[0];
}

/** Each group (codes 0..nGroups-1) against all other labelled cells; code -1 cells are
 * left out of every comparison. A group with no cells gets no rows. Every list is sorted
 * by score, highest first. */
export function markersForAll(m: ExpressionMatrix, codes: Int32Array, nGroups: number, progress: Progress = silent): GeneTest[][] {
  const { nCells, genes, indptr, indices, data } = m;
  if (codes.length !== nCells) throw new RangeError(`expected ${nCells} group codes, got ${codes.length}`);
  const groupSize = new Float64Array(nGroups);
  for (const code of codes) {
    if (code >= nGroups) throw new RangeError(`group code ${code} is outside 0..${nGroups - 1}`);
    if (code >= 0) groupSize[code]++;
  }
  let n = 0;
  for (const size of groupSize) n += size;
  const nGenes = genes.length;

  const score = Array.from({ length: nGroups }, () => new Float64Array(nGenes));
  const sumIn = Array.from({ length: nGroups }, () => new Float64Array(nGenes));
  const positiveIn = Array.from({ length: nGroups }, () => new Float64Array(nGenes));
  const geneSum = new Float64Array(nGenes);
  const genePositive = new Float64Array(nGenes);

  let maxNnz = 0;
  for (let g = 0; g < nGenes; g++) maxNnz = Math.max(maxNnz, indptr[g + 1] - indptr[g]);
  const values = new Float32Array(maxNnz);
  const groupOf = new Int32Array(maxNnz);
  const sortedBuffer = new Float32Array(maxNnz);
  const runRank = new Float64Array(maxNnz);
  const rankSum = new Float64Array(nGroups);
  const storedIn = new Float64Array(nGroups);
  const tieDenominator = n * n * n - n;

  for (let g = 0; g < nGenes; g++) {
    let stored = 0;
    for (let p = indptr[g]; p < indptr[g + 1]; p++) {
      const code = codes[indices[p]];
      if (code < 0) continue;
      values[stored] = data[p];
      groupOf[stored] = code;
      stored++;
    }
    const sorted = sortedBuffer.subarray(0, stored);
    sorted.set(values.subarray(0, stored));
    sorted.sort();

    // Average ranks over the full set of n labelled cells: the implicit zeros join any
    // stored zeros in one tie block, placed between the negative and positive values.
    const implicitZeros = n - stored;
    let zeroRank = 0;
    let zeroPlaced = false;
    let below = 0;
    let tieSum = 0;
    let i = 0;
    while (i < stored || !zeroPlaced) {
      if (!zeroPlaced && (i === stored || sorted[i] >= 0)) {
        let j = i;
        while (j < stored && sorted[j] === 0) j++;
        const t = j - i + implicitZeros;
        zeroRank = below + (t + 1) / 2;
        runRank.fill(zeroRank, i, j);
        tieSum += t * t * t - t;
        below += t;
        i = j;
        zeroPlaced = true;
        continue;
      }
      const v = sorted[i];
      let j = i + 1;
      while (j < stored && sorted[j] === v) j++;
      const t = j - i;
      runRank.fill(below + (t + 1) / 2, i, j);
      tieSum += t * t * t - t;
      below += t;
      i = j;
    }

    rankSum.fill(0);
    storedIn.fill(0);
    let total = 0;
    let positive = 0;
    for (let s = 0; s < stored; s++) {
      const v = values[s];
      const group = groupOf[s];
      rankSum[group] += runRank[lowerBound(sorted, v)];
      storedIn[group]++;
      sumIn[group][g] += v;
      total += v;
      if (v > 0) {
        positiveIn[group][g]++;
        positive++;
      }
    }
    geneSum[g] = total;
    genePositive[g] = positive;

    const tieCorrection = tieDenominator > 0 ? 1 - tieSum / tieDenominator : 1;
    for (let group = 0; group < nGroups; group++) {
      const nA = groupSize[group];
      const ranks = rankSum[group] + (nA - storedIn[group]) * zeroRank;
      const sd = Math.sqrt((tieCorrection * nA * (n - nA) * (n + 1)) / 12);
      // A zero spread (one group empty, or every value tied) is scanpy's NaN score, set to 0.
      score[group][g] = sd > 0 ? (ranks - (nA * (n + 1)) / 2) / sd : 0;
    }
    progress((g + 1) / nGenes, 'Ranking genes');
  }

  return score.map((groupScore, group) => {
    const nA = groupSize[group];
    if (nA === 0) return [];
    const nB = n - nA;
    const pval = Float64Array.from(groupScore, twoSidedP);
    const padj = benjaminiHochberg(pval);
    const rows = genes.map((gene, g): GeneTest => {
      const meanA = sumIn[group][g] / nA;
      const meanB = (geneSum[g] - sumIn[group][g]) / nB;
      return {
        gene,
        score: groupScore[g],
        logfc: Math.log2((Math.expm1(meanA) + FOLD_EPSILON) / (Math.expm1(meanB) + FOLD_EPSILON)),
        pval: pval[g],
        padj: padj[g],
        meanA,
        meanB,
        fracA: positiveIn[group][g] / nA,
        fracB: (genePositive[g] - positiveIn[group][g]) / nB,
      };
    });
    return rows.sort((a, b) => b.score - a.score);
  });
}

function lowerBound(sorted: Float32Array, v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
