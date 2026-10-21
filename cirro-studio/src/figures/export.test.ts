import { describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import { withPhys } from './export';
import { figureLayout, figureSvg, PAGE_HEIGHT_MAX, type FigureLayoutSpec, type SizePreset } from './layout';

// A PNG's signature and IHDR chunk (contents irrelevant here), then IEND.
function fakePng(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8 + 25 + 12);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(33, 0);
  bytes.set([0x49, 0x45, 0x4e, 0x44], 37); // IEND
  return bytes;
}

describe('withPhys', () => {
  it('inserts a pHYs chunk declaring the resolution right after IHDR', () => {
    const out = withPhys(fakePng(), 300);
    const view = new DataView(out.buffer);
    expect(out.length).toBe(fakePng().length + 21);
    expect(view.getUint32(33)).toBe(9);
    expect(new TextDecoder().decode(out.subarray(37, 41))).toBe('pHYs');
    expect(view.getUint32(41)).toBe(11811); // 300 dpi in pixels per metre
    expect(view.getUint32(45)).toBe(11811);
    expect(out[49]).toBe(1);
    expect(view.getUint32(50)).toBe(crc32(out.subarray(37, 50)));
    expect(new TextDecoder().decode(out.subarray(58, 62))).toBe('IEND');
  });
});

// A 0.6-aspect capture with a categorical legend of `count` entries.
function spec(count: number, preset: SizePreset, label = (i: number) => `a long cell type name ${i}`): FigureLayoutSpec {
  return {
    title: 'Sample A: cell type',
    preset,
    legend: {
      kind: 'categorical',
      title: 'cell type',
      items: Array.from({ length: count }, (_, i) => ({ label: label(i), color: '#336699' })),
    },
    scaleBar: null,
    capture: { dataUrl: 'data:image/png;base64,', width: 1000, height: 600, cssWidth: 1000 },
    font: 'Arial',
    fontPt: 7,
  };
}

// The lowest edge any drawn element reaches, and the page height, in the SVG's points.
function extents(svg: string): { bottom: number; height: number } {
  const height = Number(/viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(svg)![1]);
  let bottom = 0;
  for (const [element] of svg.matchAll(/<(?:rect|text|image) [^>]*>/g)) {
    const y = / y="([\d.]+)"/.exec(element);
    if (!y) continue;
    const h = / height="([\d.]+)"/.exec(element);
    bottom = Math.max(bottom, Number(y[1]) + (h ? Number(h[1]) : 0));
  }
  return { bottom, height };
}

describe('figureLayout', () => {
  it('makes the page tall enough for a legend longer than the image', () => {
    const { bottom, height } = extents(figureSvg(spec(22, 'single')));
    expect(bottom).toBeGreaterThan(0);
    expect(bottom).toBeLessThanOrEqual(height);
  });

  it('keeps the image on the page when the legend has many columns', () => {
    for (const preset of ['single', 'double', 'slide'] as const) {
      const layout = figureLayout(spec(100, preset));
      expect(layout.image.w).toBeGreaterThan(layout.widthMm / 3);
      const { bottom, height } = extents(figureSvg(spec(100, preset)));
      expect(bottom).toBeLessThanOrEqual(height);
    }
  });

  it('widens the legend past half the page before running past the page', () => {
    const layout = figureLayout(spec(100, 'single', (i) => `cell group ${String(i).padStart(3, '0')}`));
    expect(layout.legend!.omitted).toBe(0);
    expect(layout.legend!.w).toBeGreaterThan(layout.widthMm / 2);
    expect(layout.image.w).toBeGreaterThan(layout.widthMm / 3);
    expect(layout.heightMm).toBeLessThanOrEqual(PAGE_HEIGHT_MAX);
  });

  it('keeps the page to an A4 text block, leaving out the legend rows that do not fit', () => {
    const layout = figureLayout(spec(100, 'single'));
    expect(layout.heightMm).toBeLessThanOrEqual(PAGE_HEIGHT_MAX);
    expect(layout.legend!.omitted).toBeGreaterThan(0);
    const svg = figureSvg(spec(100, 'single'));
    expect(svg.match(/a long cell type name \d+/g)).toHaveLength(100 - layout.legend!.omitted);
    const { bottom, height } = extents(svg);
    expect(bottom).toBeLessThanOrEqual(height);
  });

  it('keeps a tall image to the page', () => {
    const tall = { ...spec(5, 'double'), capture: { dataUrl: 'data:image/png;base64,', width: 400, height: 2000, cssWidth: 400 } };
    const layout = figureLayout(tall);
    expect(layout.heightMm).toBeLessThanOrEqual(PAGE_HEIGHT_MAX);
    expect(layout.image.h / layout.image.w).toBeCloseTo(5);
  });
});
