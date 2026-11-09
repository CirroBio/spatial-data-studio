import { describe, expect, it } from 'vitest';
import { buildNumericColormap, defaultColorLimits, VIRIDIS_CSS_STOPS } from './colorUtils';
import { buildColorLegend } from './useSpotColors';

// Five unexpressing cells, counts 1 to 99, and one cell at 1000: the shape of a raw-count
// gene with an outlier. backend/test_e2e.py `run_color_limits_parity` checks the figure
// renderer gets the same range from the same values.
const COUNTS = Float32Array.from([0, 0, 0, 0, 0, ...Array.from({ length: 99 }, (_, i) => i + 1), 1000]);

const colorAt = (rgba: Uint8Array, i: number) => `rgb(${rgba[i * 4]},${rgba[i * 4 + 1]},${rgba[i * 4 + 2]})`;

describe('defaultColorLimits', () => {
  it('spans zero to the 99th percentile of the non-zero values', () => {
    const [low, high] = defaultColorLimits(COUNTS)!;
    expect(low).toBe(0);
    expect(high).toBeCloseTo(108.01, 6);
  });

  it('starts at the 1st percentile when no cell is zero', () => {
    const [low, high] = defaultColorLimits(COUNTS.filter((v) => v !== 0))!;
    expect(low).toBeCloseTo(1.99, 6);
    expect(high).toBeCloseTo(108.01, 6);
  });

  it('keeps both ends of a field that runs below zero', () => {
    const [low, high] = defaultColorLimits(Float32Array.from([-10, -1, 0, 1, 10]))!;
    expect(low).toBeCloseTo(-9.73, 5);
    expect(high).toBeCloseTo(9.73, 5);
  });

  it('ignores missing values, and has no range without values', () => {
    expect(defaultColorLimits(Float32Array.from([NaN, 0, 4, NaN]))).toEqual([0, 4]);
    expect(defaultColorLimits(Float32Array.from([0, 0]))).toEqual([0, 0]);
    expect(defaultColorLimits(Float32Array.from([NaN]))).toBeNull();
  });
});

describe('numeric coloring', () => {
  it('colors past the range with its end colors', () => {
    const rgba = buildNumericColormap(COUNTS, [0, 50]);
    expect(colorAt(rgba, 0)).toBe(VIRIDIS_CSS_STOPS[0]);
    expect(colorAt(rgba, COUNTS.length - 1)).toBe(VIRIDIS_CSS_STOPS[255]);
    expect(colorAt(rgba, COUNTS.indexOf(60))).toBe(VIRIDIS_CSS_STOPS[255]);
    expect(colorAt(rgba, COUNTS.indexOf(25))).toBe(VIRIDIS_CSS_STOPS[127]);
  });

  it('keys the default range and the values beyond it in the legend', () => {
    const legend = buildColorLegend({ kind: 'numeric', values: COUNTS }, undefined);
    expect(legend).toMatchObject({ kind: 'numeric', min: 0, dataMin: 0, dataMax: 1000 });
    expect(legend?.kind === 'numeric' && legend.max).toBeCloseTo(108.01, 6);
  });

  it('keys a range the display sets in place of the default', () => {
    const legend = buildColorLegend({ kind: 'numeric', values: COUNTS }, undefined, [5, 20]);
    expect(legend).toEqual({ kind: 'numeric', min: 5, max: 20, dataMin: 0, dataMax: 1000 });
  });
});
