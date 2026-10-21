import { describe, expect, it } from 'vitest';
import { spatialPatterns, whereHigh } from './patterns';
import { mulberry32, randomInt } from './random';
import { cscFromDense } from './testData';

const SIDE = 80;

// Cells on a SIDE × SIDE lattice, y down.
function lattice() {
  const xy = new Float32Array(SIDE * SIDE * 2);
  for (let i = 0; i < SIDE * SIDE; i++) {
    xy[2 * i] = i % SIDE;
    xy[2 * i + 1] = Math.floor(i / SIDE);
  }
  return { xy, bounds: [0, 0, SIDE - 1, SIDE - 1] as [number, number, number, number] };
}

describe('spatialPatterns', () => {
  it('puts genes with opposite maps in two patterns and leaves scattered genes out', () => {
    const tissue = lattice();
    const random = mulberry32(7);
    // Three genes high on the right, a scattered one, five high on the left, another scattered.
    const kinds = ['right', 'right', 'right', 'noise', 'left', 'left', 'left', 'left', 'left', 'noise'];
    const dense = Array.from({ length: SIDE * SIDE }, (_, c) => {
      const left = c % SIDE < SIDE / 2;
      return kinds.map((k) => (k === 'noise' ? 0 : (k === 'left') === left ? 4 : 0) + randomInt(random, 3));
    });
    const genes = kinds.map((_, g) => g);
    const labels = spatialPatterns(cscFromDense(dense), genes, tissue);
    // The larger pattern is numbered first.
    expect(Array.from(labels)).toEqual([1, 1, 1, -1, 0, 0, 0, 0, 0, -1]);
    expect(spatialPatterns(cscFromDense(dense), genes, tissue)).toEqual(labels);
  });
});

describe('whereHigh', () => {
  const tissue = lattice();
  const at = (f: (x: number, y: number) => number) => Float32Array.from({ length: SIDE * SIDE }, (_, c) => f(c % SIDE, Math.floor(c / SIDE)));

  it('names an edge, a corner and the middle', () => {
    expect(whereHigh(at((x) => (x < SIDE / 3 ? 1 : 0)), tissue)).toBe('highest along the left edge');
    expect(whereHigh(at((x, y) => (x > (2 * SIDE) / 3 && y < SIDE / 3 ? 1 : 0)), tissue)).toBe('highest toward the top right');
    expect(whereHigh(at((x, y) => (Math.hypot(x - SIDE / 2, y - SIDE / 2) < 10 ? 1 : 0)), tissue)).toBe('highest in the middle');
  });

  it('says when no part stands out', () => {
    const random = mulberry32(3);
    expect(whereHigh(at(() => random()), tissue)).toBe('in patches all over the section');
  });
});
