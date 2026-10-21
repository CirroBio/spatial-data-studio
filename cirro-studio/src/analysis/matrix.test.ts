import { describe, expect, it } from 'vitest';
import { cellsDetected, geneIndex, geneMoments, logNormalize, looksLikeCounts } from './matrix';
import { cscFromDense } from './testData';

describe('matrix helpers', () => {
  it('recognises raw counts', () => {
    expect(looksLikeCounts(cscFromDense([[1, 0, 3], [0, 2, 0]]))).toBe(true);
    expect(looksLikeCounts(cscFromDense([[1, 0, 1], [0, 1, 0]]))).toBe(false);
    expect(looksLikeCounts(cscFromDense([[1.5, 0, 3], [0, 2, 0]]))).toBe(false);
    expect(looksLikeCounts(cscFromDense([[-2, 0, 3], [0, 2, 0]]))).toBe(false);
    expect(looksLikeCounts(cscFromDense([[0, 0], [0, 0]]))).toBe(false);
  });

  it('log-normalizes like scanpy normalize_total(1e4) + log1p', () => {
    const m = logNormalize(cscFromDense([[1, 2, 10, 5, 1], [1, 1, 5, 3, 1]]));
    const dense = [0, 1].map((c) => m.genes.map((_, g) => {
      for (let p = m.indptr[g]; p < m.indptr[g + 1]; p++) if (m.indices[p] === c) return m.data[p];
      return 0;
    }));
    const scanpy = [
      [6.267799377441406, 6.95999813079834, 8.568675994873047, 7.87571907043457, 6.267799377441406],
      [6.813544750213623, 6.813544750213623, 8.422102928161621, 7.911424160003662, 6.813544750213623],
    ];
    scanpy.forEach((row, c) => row.forEach((v, g) => expect(dense[c][g]).toBeCloseTo(v, 5)));
  });

  it('finds genes exactly first, then ignoring case', () => {
    const m = cscFromDense([[1, 2, 3]], ['Cd3e', 'CD3E', 'Actb']);
    expect(geneIndex(m, ['CD3E', 'cd3e', 'ACTB', 'Nope'])).toEqual([1, 0, 2, -1]);
  });

  it('computes per-gene mean, sample variance and detection over all cells', () => {
    const m = cscFromDense([[1, 0], [3, 0], [0, 0], [0, 4]]);
    const { mean, variance } = geneMoments(m);
    expect(Array.from(mean)).toEqual([1, 1]);
    expect(variance[0]).toBeCloseTo(((0 ** 2 + 2 ** 2 + 1 + 1) / 3), 12);
    expect(variance[1]).toBeCloseTo((1 + 1 + 1 + 9) / 3, 12);
    expect(geneMoments(m, (v) => 2 * v).mean[1]).toBe(2);
    expect(Array.from(cellsDetected(m))).toEqual([2, 1]);
  });
});
