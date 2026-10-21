import { describe, expect, it } from 'vitest';
import type { ExpressionMatrix } from '@cirrobio/spatial-viewer';
import { logNormalize } from './matrix';
import { mulberry32 } from './random';
import { compareGroups, markersForAll, type GeneTest } from './rankGenes';
import { cscFromDense, randomCounts } from './testData';

// Poisson counts with gene g2 raised in group 0; the expected rows are scanpy 1.11
// `normalize_total(1e4)`, `log1p`, `rank_genes_groups(method='wilcoxon', tie_correct=True, pts=True)`.
const COUNTS = [[1, 2, 10, 5, 1], [0, 4, 6, 2, 1], [1, 2, 10, 3, 0], [1, 0, 7, 4, 0], [0, 0, 3, 3, 2], [1, 1, 5, 3, 1], [1, 0, 5, 3, 2], [1, 2, 3, 2, 1], [1, 1, 6, 7, 0], [0, 2, 10, 5, 2], [1, 1, 0, 4, 3], [0, 5, 1, 7, 1], [0, 1, 0, 5, 1], [1, 2, 0, 6, 3], [0, 0, 0, 3, 1], [1, 3, 0, 3, 3], [0, 1, 0, 5, 1], [0, 2, 0, 7, 0], [1, 3, 0, 3, 2], [0, 1, 0, 2, 2], [0, 1, 0, 1, 1], [0, 2, 0, 4, 3], [0, 2, 0, 4, 4], [2, 1, 0, 5, 2], [0, 4, 0, 6, 0], [1, 1, 0, 5, 1], [0, 2, 0, 5, 0], [0, 1, 0, 4, 1], [0, 2, 0, 3, 2], [1, 3, 0, 2, 2]];
const GROUPS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2];
type Expected = Omit<GeneTest, 'meanA' | 'meanB'>;
const SCANPY: Expected[][] = [
  [
    { gene: 'g2', score: 5.09381103515625, logfc: 13.547609329223633, pval: 3.509361311046161e-07, padj: 1.7546806555230805e-06, fracA: 1.0, fracB: 0.05 },
    { gene: 'g0', score: 0.7647705078125, logfc: 3.260075569152832, pval: 0.4444082046176564, padj: 0.4444082046176564, fracA: 0.7, fracB: 0.35 },
    { gene: 'g4', score: -2.5220139026641846, logfc: -2.4078688621520996, pval: 0.011668513393618195, padj: 0.014585641742022743, fracA: 0.7, fracB: 0.85 },
    { gene: 'g1', score: -2.778127670288086, logfc: -3.303459882736206, pval: 0.005467314700820271, padj: 0.009112191168033785, fracA: 0.7, fracB: 0.95 },
    { gene: 'g3', score: -3.5258114337921143, logfc: -0.8812339901924133, pval: 0.00042218745325354356, padj: 0.0010554686331338589, fracA: 1.0, fracB: 1.0 },
  ],
  [
    { gene: 'g4', score: 2.21393084526062, logfc: 2.601470708847046, pval: 0.026833530872942865, padj: 0.059659353174358117, fracA: 0.9166666666666666, fracB: 0.7222222222222222 },
    { gene: 'g3', score: 2.0992414951324463, logfc: 0.47441503405570984, pval: 0.03579561190461487, padj: 0.059659353174358117, fracA: 1.0, fracB: 1.0 },
    { gene: 'g1', score: 1.3366272449493408, logfc: 1.20200514793396, pval: 0.1813443379617904, padj: 0.226680422452238, fracA: 0.9166666666666666, fracB: 0.8333333333333334 },
    { gene: 'g0', score: -0.9888666868209839, logfc: -2.2789125442504883, pval: 0.3227283801830726, padj: 0.3227283801830726, fracA: 0.3333333333333333, fracB: 0.5555555555555556 },
    { gene: 'g2', score: -2.744852304458618, logfc: -7.212122917175293, pval: 0.006053811531474815, padj: 0.030269057657374074, fracA: 0.08333333333333333, fracB: 0.5555555555555556 },
  ],
  [
    { gene: 'g1', score: 1.4807469844818115, logfc: 2.27345871925354, pval: 0.1386740111223734, padj: 0.2531256153912342, fracA: 1.0, fracB: 0.8181818181818182 },
    { gene: 'g3', score: 1.4329386949539185, logfc: 0.4191242456436157, pval: 0.1518753692347405, padj: 0.2531256153912342, fracA: 1.0, fracB: 1.0 },
    { gene: 'g0', score: 0.28024154901504517, logfc: -0.9722871780395508, pval: 0.7792921991263382, padj: 0.813563653175337, fracA: 0.375, fracB: 0.5 },
    { gene: 'g4', score: 0.23583120107650757, logfc: -0.4601694643497467, pval: 0.813563653175337, padj: 0.813563653175337, fracA: 0.75, fracB: 0.8181818181818182 },
    { gene: 'g2', score: -2.389209270477295, logfc: -35.844268798828125, pval: 0.016884681881310076, padj: 0.08442340940655037, fracA: 0.0, fracB: 0.5 },
  ],
];

const relativeError = (actual: number, expected: number) => Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-12);

/** Textbook tie-corrected rank-sum z on dense values: average ranks over every cell. */
function denseRankSumZ(values: number[], inA: boolean[]): number {
  const n = values.length;
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const rank = new Array<number>(n);
  let tie = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j < n && values[order[j]] === values[order[i]]) j++;
    for (let t = i; t < j; t++) rank[order[t]] = (i + j + 1) / 2;
    tie += (j - i) ** 3 - (j - i);
    i = j;
  }
  const nA = inA.filter(Boolean).length;
  const sum = rank.reduce((acc, r, i) => acc + (inA[i] ? r : 0), 0);
  const sd = Math.sqrt(((1 - tie / (n ** 3 - n)) * nA * (n - nA) * (n + 1)) / 12);
  return (sum - (nA * (n + 1)) / 2) / sd;
}

describe('markersForAll', () => {
  it('matches scanpy rank_genes_groups on log-normalized counts', () => {
    const results = markersForAll(logNormalize(cscFromDense(COUNTS)), Int32Array.from(GROUPS), 3);
    results.forEach((rows, group) => {
      expect(rows.map((r) => r.gene)).toEqual(SCANPY[group].map((r) => r.gene));
      rows.forEach((row, i) => {
        const expected = SCANPY[group][i];
        // scanpy stores scores and fold changes as float32.
        for (const key of ['score', 'logfc', 'pval', 'padj'] as const) {
          expect(relativeError(row[key], expected[key]), `${group} ${row.gene} ${key}`).toBeLessThan(2e-5);
        }
        expect(row.fracA).toBeCloseTo(expected.fracA, 12);
        expect(row.fracB).toBeCloseTo(expected.fracB, 12);
      });
    });
  });

  it('ranks a gene expressed only in one group first, with a significant adjusted p', () => {
    const base = randomCounts(600, 40, 0.3, 11);
    const codes = Int32Array.from({ length: 600 }, (_, c) => c % 4);
    const random = mulberry32(3);
    const marker = Array.from({ length: 600 }, (_, c) => (codes[c] === 2 && random() < 0.6 ? 1 + Math.floor(random() * 5) : 0));
    const dense = Array.from({ length: 600 }, (_, c) => [...Array.from({ length: 40 }, (_, g) => valueAt(base, c, g)), marker[c]]);
    const results = markersForAll(logNormalize(cscFromDense(dense)), codes, 4);
    const top = results[2][0];
    expect(top.gene).toBe('g40');
    expect(top.padj).toBeLessThan(0.05);
    expect(top.fracB).toBe(0);
    expect(top.logfc).toBeGreaterThan(10);
    for (const group of [0, 1, 3]) expect(results[group].at(-1)?.gene).toBe('g40');
  });

  it('places stored zeros and negative values correctly among the implicit zeros', () => {
    const random = mulberry32(5);
    const n = 50;
    const dense = Array.from({ length: n }, () => [0, 1, 2].map(() => {
      const u = random();
      return u < 0.4 ? 0 : u < 0.5 ? -Math.round(random() * 3) : Math.round(random() * 4) / 2;
    }));
    const codes = Int32Array.from({ length: n }, (_, c) => (c % 7 === 0 ? -1 : c % 3));
    const kept = [...codes.keys()].filter((c) => codes[c] >= 0);
    for (const matrix of [cscFromDense(dense), storingEveryValue(dense)]) {
      const results = markersForAll(matrix, codes, 3);
      for (let group = 0; group < 3; group++) {
        for (const row of results[group]) {
          const g = Number(row.gene.slice(1));
          const expected = denseRankSumZ(kept.map((c) => dense[c][g]), kept.map((c) => codes[c] === group));
          expect(row.score).toBeCloseTo(expected, 10);
        }
      }
    }
  });

  it('gives an empty group no rows', () => {
    const results = markersForAll(cscFromDense(COUNTS), Int32Array.from(GROUPS), 4);
    expect(results[3]).toEqual([]);
  });
});

describe('compareGroups', () => {
  it('matches scipy mannwhitneyu (asymptotic, tie-corrected, no continuity correction)', () => {
    // scipy.stats.mannwhitneyu(A, B, use_continuity=False, method='asymptotic').pvalue
    const A = [0, 0, 1.5, 2, 2, 3];
    const B = [0, 0, 0, 0, 1.5, 0.5, 1];
    const matrix = cscFromDense([...A, ...B].map((v) => [v]));
    const membership = Uint8Array.from([...A.map(() => 1), ...B.map(() => 2)]);
    const [row] = compareGroups(matrix, membership);
    expect(relativeError(row.pval, 0.11351522901054319)).toBeLessThan(1e-12);
    expect(row.score).toBeGreaterThan(0);
    expect(row.fracA).toBeCloseTo(4 / 6, 12);
    expect(row.fracB).toBeCloseTo(3 / 7, 12);
  });

  it('ignores cells left out of both groups', () => {
    const matrix = logNormalize(cscFromDense(COUNTS));
    const membership = Uint8Array.from(GROUPS, (g) => (g === 0 ? 1 : g === 2 ? 2 : 0));
    const subset = COUNTS.filter((_, c) => GROUPS[c] !== 1);
    const expected = markersForAll(logNormalize(cscFromDense(subset)), Int32Array.from(GROUPS.filter((g) => g !== 1), (g) => (g === 0 ? 0 : 1)), 2)[0];
    expect(compareGroups(matrix, membership)).toEqual(expected);
  });
});

function valueAt(m: ExpressionMatrix, cell: number, gene: number): number {
  for (let p = m.indptr[gene]; p < m.indptr[gene + 1]; p++) if (m.indices[p] === cell) return m.data[p];
  return 0;
}

/** A CSC matrix that stores every entry, zeros included. */
function storingEveryValue(dense: number[][]): ExpressionMatrix {
  const nCells = dense.length;
  const nGenes = dense[0].length;
  return {
    nCells,
    genes: Array.from({ length: nGenes }, (_, g) => `g${g}`),
    indptr: Float64Array.from({ length: nGenes + 1 }, (_, g) => g * nCells),
    indices: Int32Array.from({ length: nGenes * nCells }, (_, i) => i % nCells),
    data: Float32Array.from({ length: nGenes * nCells }, (_, i) => dense[i % nCells][Math.floor(i / nCells)]),
  };
}
