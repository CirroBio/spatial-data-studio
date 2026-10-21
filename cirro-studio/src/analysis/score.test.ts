import { describe, expect, it } from 'vitest';
import { logNormalize } from './matrix';
import { scoreGenes } from './score';
import { cscFromDense, referenceCounts } from './testData';

describe('scoreGenes', () => {
  it('matches scanpy score_genes when every bin is smaller than ctrl_size', () => {
    // 80 genes in bins of 3, so the control set is every other gene sharing a bin with a
    // signature gene and the random draw cannot matter. Expected values: scanpy 1.11
    // `score_genes(['g3', 'g20', 'g45'])` after normalize_total + log1p.
    const m = logNormalize(cscFromDense(referenceCounts(false)));
    const scores = scoreGenes(m, [3, 20, 45], 0);
    const expected = [1.0610733032226562, -0.1629015604654951, -0.8406476974487305, 2.6798730691274004, 0.13465134302775073, 1.681291580200195];
    expected.forEach((v, c) => expect(scores[c]).toBeCloseTo(v, 5));
    expect(scores.reduce((a, b) => a + b, 0) / scores.length).toBeCloseTo(0.04326818254258897, 5);
  });

  it('scores cells that express the signature above those that do not', () => {
    const rows = Array.from({ length: 200 }, (_, c) => Array.from({ length: 100 }, (_, g) => (g < 5 ? (c < 100 ? 4 : 0) : 1 + ((c * g) % 3))));
    const scores = scoreGenes(cscFromDense(rows), [0, 1, 2, 3, 4], 1);
    const high = scores.subarray(0, 100).reduce((a, b) => a + b, 0) / 100;
    const low = scores.subarray(100).reduce((a, b) => a + b, 0) / 100;
    expect(high).toBeGreaterThan(low + 3);
  });

  it('draws the same controls for the same seed', () => {
    const m = logNormalize(cscFromDense(referenceCounts(false)));
    expect(scoreGenes(m, [3, 20], 4, { ctrlSize: 1 })).toEqual(scoreGenes(m, [3, 20], 4, { ctrlSize: 1 }));
  });
});
