import { describe, expect, it } from 'vitest';
import { highlyVariableGenes, pca } from './embedding';
import { logNormalize } from './matrix';
import { gaussian, mulberry32 } from './random';
import { cscFromDense, referenceCounts } from './testData';

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] / n;
    mb += b[i] / n;
  }
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  }
  return ab / Math.sqrt(aa * bb);
}

const column = (scores: Float32Array, nComps: number, t: number) => scores.filter((_, i) => i % nComps === t);

describe('highlyVariableGenes', () => {
  // scanpy `highly_variable_genes(flavor='seurat', n_top_genes=...)` after normalize_total + log1p.
  it('selects the same genes as scanpy', () => {
    const m = logNormalize(cscFromDense(referenceCounts(false)));
    expect(highlyVariableGenes(m, 13)).toEqual([12, 13, 14, 15, 20, 24, 26, 28, 40, 41, 55, 62, 76]);
    expect(highlyVariableGenes(m, 18)).toEqual([12, 13, 14, 15, 20, 24, 26, 27, 28, 34, 40, 41, 46, 47, 48, 55, 62, 76]);
  });

  it('returns every gene when asked for at least as many as there are', () => {
    const m = cscFromDense([[1, 0, 2], [0, 3, 1]]);
    expect(highlyVariableGenes(m, 3)).toEqual([0, 1, 2]);
  });
});

describe('pca', () => {
  it('matches scanpy scale(max_value=10) + pca(svd_solver="arpack")', () => {
    const m = logNormalize(cscFromDense(referenceCounts(true)));
    const genes = Array.from({ length: 81 }, (_, g) => g);
    const { scores, variance, varianceRatio } = pca(m, genes, 5, 0);
    const scanpyVariance = [8.472146773245393, 2.1299323590219035, 2.043732207577473, 1.96129362527008, 1.8692630426798054];
    const scanpyRatio = [0.10545734063459787, 0.026512406869927525, 0.0254394274968203, 0.024413270385935666, 0.023267716519037144];
    for (let t = 0; t < 5; t++) {
      expect(Math.abs(variance[t] / scanpyVariance[t] - 1)).toBeLessThan(1e-6);
      expect(Math.abs(varianceRatio[t] / scanpyRatio[t] - 1)).toBeLessThan(1e-6);
    }
    const pc1 = column(scores, 5, 0);
    const scanpyPc1 = [4.112652778625488, -2.0399086475372314, -2.1722843647003174, 3.7368404865264893];
    const sign = Math.sign(pc1[0]) * Math.sign(scanpyPc1[0]);
    scanpyPc1.forEach((v, c) => expect(sign * pc1[c]).toBeCloseTo(v, 3));
  });

  // Regression: a randomized solver (subspace iteration) left the trailing components of
  // a flat spectrum unconverged, which changed the kNN graph and over-split clusters on
  // real Xenium data. Reference: scanpy pca(n_comps=30, svd_solver='arpack').
  it('matches scanpy on every component of a flat spectrum', () => {
    const m = logNormalize(cscFromDense(referenceCounts(true)));
    const { scores, varianceRatio } = pca(m, Array.from({ length: 81 }, (_, g) => g), 30, 0);
    const scanpyRatio = [
      0.10545734063459788, 0.026512406869927545, 0.02543942749682023, 0.024413270385935666, 0.023267716519037127,
      0.02315188749956002, 0.022480683228165047, 0.022355337697085653, 0.02130358076647625, 0.02082585854733156,
      0.020349389039721846, 0.0199203878324604, 0.01952078786672222, 0.019003691155816186, 0.018161405185294438,
      0.01804749326732044, 0.017972369416299972, 0.017144214599221115, 0.016930274723084015, 0.01666136538381852,
      0.016339766311749986, 0.0158222345953334, 0.01573758186034192, 0.015090854651555097, 0.014906444861717385,
      0.014804008903540902, 0.014188078769085028, 0.01388983736198019, 0.013618117357512062, 0.013487933943034233,
    ];
    scanpyRatio.forEach((r, t) => expect(Math.abs(varianceRatio[t] / r - 1), `PC${t + 1}`).toBeLessThan(1e-6));
    const scanpyScores: [number, number[]][] = [
      [19, [-2.038578987121582, -2.1094722747802734, -0.41808944940567017]],
      [29, [-0.9263241291046143, -0.6417968273162842, -1.193846344947815]],
    ];
    for (const [t, expected] of scanpyScores) {
      const pc = column(scores, 30, t);
      const sign = Math.sign(pc[0]) * Math.sign(expected[0]);
      expected.forEach((v, c) => expect(sign * pc[c]).toBeCloseTo(v, 3));
    }
  });

  it('recovers a planted direction and gives uncorrelated components with the reported variance', () => {
    const random = mulberry32(4);
    const n = 1000;
    const nGenes = 60;
    const factor = Array.from({ length: n }, () => gaussian(random));
    const loading = Array.from({ length: nGenes }, () => gaussian(random));
    const rows = factor.map((f) => loading.map((l) => Math.max(0, 3 + 2 * f * l + 0.5 * gaussian(random))));
    const nComps = 8;
    const { scores, variance } = pca(cscFromDense(rows), Array.from({ length: nGenes }, (_, g) => g), nComps, 1);
    expect(Math.abs(pearson(column(scores, nComps, 0), factor))).toBeGreaterThan(0.99);
    for (let t = 0; t < nComps; t++) {
      const pc = column(scores, nComps, t);
      const mean = pc.reduce((a, b) => a + b, 0) / n;
      const v = pc.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
      expect(Math.abs(mean)).toBeLessThan(1e-4);
      expect(v / variance[t]).toBeCloseTo(1, 4);
      if (t > 0) expect(Math.abs(pearson(pc, column(scores, nComps, 0)))).toBeLessThan(1e-3);
    }
  });

  it('copes with more components requested than the data has rank', () => {
    const rows = Array.from({ length: 50 }, (_, c) => [c % 2, c % 2, 0, 1, (c * 7) % 5]);
    const { scores, variance } = pca(cscFromDense(rows), [0, 1, 2, 3, 4], 4, 0);
    expect(Array.from(scores).every(Number.isFinite)).toBe(true);
    expect(variance[2]).toBeLessThan(1e-9);
  });
});
