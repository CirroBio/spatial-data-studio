import { describe, expect, it } from 'vitest';
import { crossTabulate, testComposition } from './composition';

// Three regions × four groups. Reference values from scipy.stats.chi2_contingency
// (correction=False) on each pair's 2 × 2 table, signed by observed − expected, and
// statsmodels' fdr_bh over all twelve.
const COUNTS = [30, 10, 5, 0, 20, 25, 15, 40, 10, 15, 20, 10];
const TABLE = { rows: ['r0', 'r1', 'r2'], columns: ['g0', 'g1', 'g2', 'g3'], counts: Float64Array.from(COUNTS) };

describe('crossTabulate', () => {
  it('counts each cell under its two groups, leaving out cells missing either', () => {
    const rows = Int32Array.from([0, 0, 1, 1, 1, -1, 0]);
    const cols = Int32Array.from([0, 1, 1, 1, 0, 0, -1]);
    const t = crossTabulate(rows, ['a', 'b'], cols, ['x', 'y']);
    expect(t.rows).toEqual(['a', 'b']);
    expect(t.columns).toEqual(['x', 'y']);
    expect(Array.from(t.counts)).toEqual([1, 1, 1, 2]);
    expect(t.leftOut).toBe(2);
  });

  it('drops groups with no cells counted, keeping the others in order', () => {
    const rows = Int32Array.from([2, 0, 2]);
    const cols = Int32Array.from([1, 1, 3]);
    const t = crossTabulate(rows, ['a', 'b', 'c'], cols, ['w', 'x', 'y', 'z']);
    expect(t.rows).toEqual(['a', 'c']);
    expect(t.columns).toEqual(['x', 'z']);
    expect(Array.from(t.counts)).toEqual([1, 0, 1, 1]);
  });
});

describe('testComposition', () => {
  const t = testComposition(TABLE);

  it('expects each pair at the margins', () => {
    expect(Array.from(t.expected)).toEqual([13.5, 11.25, 9, 11.25, 30, 25, 20, 25, 16.5, 13.75, 11, 13.75]);
  });

  it('matches scipy chi2_contingency on each pair, signed', () => {
    const z = [6.097013950210625, -0.48882371673784425, -1.6933350266692067, -4.399413450640599, -3.0860669992418384, 0,
      -1.7677669529663689, 4.898979485566356, -2.2462255415385646, 0.4571503208824944, 3.563134121092031, -1.3714509626474833];
    const p = [1.080680920282934e-9, 0.6249665057069482, 0.09039171456246065, 1.0854385584674385e-5, 0.00202823114845208, 1,
      0.07709987174354178, 9.633570086430946e-7, 0.024689565023908476, 0.6475630032890333, 0.00036645332848543203, 0.1702344200608995];
    z.forEach((v, i) => expect(t.z[i]).toBeCloseTo(v, 10));
    p.forEach((v, i) => expect(Math.abs(t.p[i] / v - 1)).toBeLessThan(1e-9));
  });

  it('adjusts the p-values together as statsmodels fdr_bh', () => {
    const padj = [1.2968171043395209e-8, 0.7064323672244, 0.13558757184369097, 4.341754233869754e-5, 0.004867754756284992, 1,
      0.13217120870321447, 5.780142051858568e-6, 0.04937913004781695, 0.7064323672244, 0.0010993599854562963, 0.226979226747866];
    padj.forEach((v, i) => expect(Math.abs(t.padj[i] / v - 1)).toBeLessThan(1e-9));
  });

  it('gives log2 observed over expected, minus infinity where none are observed', () => {
    expect(t.enrichment[0]).toBeCloseTo(1.15200309344505, 12);
    expect(t.enrichment[3]).toBe(-Infinity);
    expect(t.enrichment[5]).toBe(0);
  });

  it('leaves pairs expected to hold fewer than five cells untested, and adjusts only the rest', () => {
    // 40 cells, 4 of them in the small region, which expects about 2 of each group.
    const small = testComposition({ rows: ['big', 'small'], columns: ['x', 'y'], counts: Float64Array.from([18, 18, 4, 0]) });
    [19.8, 16.2, 2.2, 1.8].forEach((e, i) => expect(small.expected[i]).toBeCloseTo(e, 12));
    expect([small.z[2], small.p[2], small.padj[2], small.enrichment[2]].every(Number.isNaN)).toBe(true);
    expect([small.z[3], small.p[3], small.padj[3], small.enrichment[3]].every(Number.isNaN)).toBe(true);
    expect(Number.isFinite(small.padj[0])).toBe(true);
  });

  it('tests nothing when one side has a single group', () => {
    const one = testComposition({ rows: ['only'], columns: ['x', 'y'], counts: Float64Array.from([30, 40]) });
    expect(Array.from(one.z).every(Number.isNaN)).toBe(true);
  });
});
