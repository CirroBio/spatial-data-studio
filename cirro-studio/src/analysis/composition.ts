// How one grouping of the cells is made up across another: the cells of each group in each
// group of the other, and, for each pair, whether there are more or fewer than the tissue's
// overall mix would put there.
import { benjaminiHochberg, twoSidedP } from './stats';

// Below this many expected cells the normal approximation to the chi-square test is poor
// (the usual rule for a contingency table), so the pair is not tested.
export const MIN_EXPECTED = 5;

/** Cells counted by the groups of two columns: a row per group of one (`across`), a
 * column per group of the other, row-major. Groups with no cells counted are left out. */
export interface CrossTable {
  rows: string[];
  columns: string[];
  counts: Float64Array;
}

/** Count every cell that has a group in both columns; a cell missing either is left out. */
export function crossTabulate(
  rowCodes: ArrayLike<number>, rowLabels: string[], colCodes: ArrayLike<number>, colLabels: string[],
): CrossTable & { leftOut: number } {
  const full = new Float64Array(rowLabels.length * colLabels.length);
  let leftOut = 0;
  for (let c = 0; c < rowCodes.length; c++) {
    const r = rowCodes[c];
    const k = colCodes[c];
    if (r < 0 || k < 0) leftOut++;
    else full[r * colLabels.length + k] += 1;
  }
  const rowSum = (r: number) => full.subarray(r * colLabels.length, (r + 1) * colLabels.length).reduce((a, b) => a + b, 0);
  const colSum = (k: number) => rowLabels.reduce((s, _, r) => s + full[r * colLabels.length + k], 0);
  const rows = rowLabels.map((_, r) => r).filter((r) => rowSum(r) > 0);
  const cols = colLabels.map((_, k) => k).filter((k) => colSum(k) > 0);
  const counts = new Float64Array(rows.length * cols.length);
  rows.forEach((r, i) => cols.forEach((k, j) => { counts[i * cols.length + j] = full[r * colLabels.length + k]; }));
  return { rows: rows.map((r) => rowLabels[r]), columns: cols.map((k) => colLabels[k]), counts, leftOut };
}

/** Per pair, row-major like the counts. Where fewer than MIN_EXPECTED cells are expected
 * the pair is not tested, and its enrichment, z and p-values are NaN. */
export interface CompositionTests {
  expected: Float64Array;
  // log2 of observed over expected: -Infinity where none are observed.
  enrichment: Float64Array;
  z: Float64Array;
  p: Float64Array;
  padj: Float64Array;
}

/** Each pair against the table's margins: expected = row total × column total / all
 * cells, and the chi-square test (no continuity correction) of the 2 × 2 table "in this
 * row or not × in this column or not", as a signed z (Agresti's adjusted standardized
 * residual, whose square is that chi-square) with its two-sided p-value. The p-values of
 * the pairs tested are Benjamini–Hochberg adjusted together. */
export function testComposition({ rows, columns, counts }: CrossTable): CompositionTests {
  const nR = rows.length;
  const nC = columns.length;
  const rowTotal = Array.from({ length: nR }, (_, i) => counts.subarray(i * nC, (i + 1) * nC).reduce((a, b) => a + b, 0));
  const colTotal = Array.from({ length: nC }, (_, j) => rowTotal.reduce((s, _, i) => s + counts[i * nC + j], 0));
  const n = rowTotal.reduce((a, b) => a + b, 0);
  const size = nR * nC;
  const out: CompositionTests = {
    expected: new Float64Array(size), enrichment: new Float64Array(size).fill(NaN),
    z: new Float64Array(size).fill(NaN), p: new Float64Array(size).fill(NaN), padj: new Float64Array(size).fill(NaN),
  };
  const tested: number[] = [];
  for (let i = 0; i < nR; i++) {
    for (let j = 0; j < nC; j++) {
      const at = i * nC + j;
      const e = (rowTotal[i] * colTotal[j]) / n;
      out.expected[at] = e;
      // With one group on either side, every cell is in it and there is nothing to compare.
      const variance = e * (1 - rowTotal[i] / n) * (1 - colTotal[j] / n);
      if (e < MIN_EXPECTED || variance <= 0) continue;
      out.enrichment[at] = Math.log2(counts[at] / e);
      out.z[at] = (counts[at] - e) / Math.sqrt(variance);
      out.p[at] = twoSidedP(out.z[at]);
      tested.push(at);
    }
  }
  const adjusted = benjaminiHochberg(tested.map((at) => out.p[at]));
  tested.forEach((at, t) => { out.padj[at] = adjusted[t]; });
  return out;
}
