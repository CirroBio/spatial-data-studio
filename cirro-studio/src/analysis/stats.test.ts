import { describe, expect, it } from 'vitest';
import { benjaminiHochberg, erfc, normalSf, roundHalfEven } from './stats';

// Reference values from scipy.special.erfc / scipy.stats.norm.sf / statsmodels fdr_bh.
describe('stats', () => {
  it('matches scipy erfc to near machine precision, deep into the tail', () => {
    const xs = [-3, -0.5, 0, 0.3, 1, 2.5, 5, 10, 20, 26];
    const expected = [
      1.9999779095030015, 1.5204998778130465, 1.0, 0.6713732405408726, 0.15729920705028516,
      0.0004069520174449589, 1.5374597944280353e-12, 2.0884875837625446e-45, 5.395865611607902e-176,
      5.663192408856145e-296,
    ];
    xs.forEach((x, i) => expect(Math.abs(erfc(x) / expected[i] - 1)).toBeLessThan(1e-12));
  });

  it('matches scipy norm.sf', () => {
    const zs = [0, 1.96, -2.5, 8, 30];
    const expected = [0.5, 0.024997895148220435, 0.9937903346742238, 6.22096057427174e-16, 4.906713927147908e-198];
    zs.forEach((z, i) => expect(Math.abs(normalSf(z) / expected[i] - 1)).toBeLessThan(1e-12));
  });

  it('matches statsmodels Benjamini-Hochberg', () => {
    const adjusted = benjaminiHochberg([0.01, 0.04, 0.03, 0.5, 0.001, 0.04, 1.0, 0.2]);
    const expected = [0.04, 0.064, 0.064, 0.5714285714285714, 0.008, 0.064, 1.0, 0.26666666666666666];
    expected.forEach((p, i) => expect(adjusted[i]).toBeCloseTo(p, 12));
  });

  it('rounds halves to even like numpy', () => {
    expect([0.5, 1.5, 2.5, 12.5, 2.4, 2.6].map(roundHalfEven)).toEqual([0, 2, 2, 12, 2, 3]);
  });
});
