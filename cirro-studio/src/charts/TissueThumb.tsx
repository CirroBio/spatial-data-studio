// A small picture of the section: every cell binned at the thumbnail's own resolution, so
// a hundred thousand cells cost one pass. It shows where a group's cells are (the
// section in grey, the group in its color) or how strongly a gene is expressed (the
// canvas's viridis, over the bins that hold cells).
import { useEffect, useRef } from 'react';
import { VIRIDIS_CSS_STOPS } from '@cirrobio/spatial-viewer';

export interface Tissue {
  // Interleaved x, y, as the tissue canvas draws them (y down).
  xy: Float32Array;
  bounds: [number, number, number, number];
}

export type Paint =
  | { kind: 'group'; member: (cell: number) => boolean; color: string }
  | { kind: 'values'; values: ArrayLike<number> };

const VIRIDIS_RGB = VIRIDIS_CSS_STOPS.map((s) => s.match(/\d+/g)!.map(Number));
const SECTION_RGB = [148, 158, 174];
// A group with fewer than this share of the cells is drawn with enlarged dots.
const SMALL_GROUP = 0.05;
// A bin should hold about this many cells, so a sparse section reads as areas, not dots;
// bins are square, a few pixels across at most.
const CELLS_PER_BIN = 2.5;
const MAX_BIN_PX = 6;
// The tile size, in pixels, for estimating how much of the box the section covers.
const AREA_TILE = 8;

/** The section's extent, for laying thumbnails out before they draw. */
export function tissueOf(xy: Float32Array): Tissue {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < xy.length; i += 2) {
    const x = xy[i];
    const y = xy[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { xy, bounds: [x0, y0, x1, y1] };
}

const hexRgb = (hex: string) => {
  const v = parseInt(hex.replace('#', ''), 16);
  return [v >> 16, (v >> 8) & 255, v & 255];
};

function paintThumb(canvas: HTMLCanvasElement, tissue: Tissue, paint: Paint, width: number, height: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  canvas.width = w;
  canvas.height = h;
  const [x0, y0, x1, y1] = tissue.bounds;
  // One scale both ways, the section centred in the box.
  const s = Math.min((w - 1) / Math.max(x1 - x0, 1e-9), (h - 1) / Math.max(y1 - y0, 1e-9));
  const ox = (w - 1 - (x1 - x0) * s) / 2;
  const oy = (h - 1 - (y1 - y0) * s) / 2;
  const { xy } = tissue;
  const cells = xy.length / 2;

  // The bin size: the section's area (tiles holding any cell) over its cells.
  const tilesW = Math.ceil(w / AREA_TILE);
  const tiles = new Uint8Array(tilesW * Math.ceil(h / AREA_TILE));
  for (let c = 0; c < cells; c++) {
    const x = xy[2 * c];
    const y = xy[2 * c + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) tiles[Math.floor((oy + (y - y0) * s) / AREA_TILE) * tilesW + Math.floor((ox + (x - x0) * s) / AREA_TILE)] = 1;
  }
  let area = 0;
  for (const t of tiles) area += t;
  const bin = Math.min(MAX_BIN_PX, Math.max(1, Math.round(Math.sqrt((CELLS_PER_BIN * area * AREA_TILE * AREA_TILE) / Math.max(cells, 1)))));
  const gw = Math.ceil(w / bin);
  const gh = Math.ceil(h / bin);

  const total = new Float32Array(gw * gh);
  const shown = new Float32Array(gw * gh);
  for (let c = 0; c < cells; c++) {
    const x = xy[2 * c];
    const y = xy[2 * c + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const b = Math.floor((oy + (y - y0) * s) / bin) * gw + Math.floor((ox + (x - x0) * s) / bin);
    total[b] += 1;
    if (paint.kind === 'group') {
      if (paint.member(c)) shown[b] += 1;
    } else {
      const v = paint.values[c];
      if (Number.isFinite(v)) shown[b] += v;
    }
  }
  // A bin's density against a typical bin's, so the section reads at any cell count.
  const filled = total.filter((t) => t > 0).sort();
  const typical = filled[Math.floor(filled.length / 2)] || 1;
  let top = 0;
  if (paint.kind === 'values') {
    const means = Array.from(shown, (v, b) => (total[b] ? v / total[b] : 0)).filter((m) => m > 0).sort((a, b) => a - b);
    top = means[Math.floor(means.length * 0.99)] || 1;
  }
  const color = paint.kind === 'group' ? hexRgb(paint.color) : null;
  // A small group's cells, in single-pixel bins among thousands, are each drawn as a dot a
  // pixel or two across instead, so they can be seen at all.
  const halo = new Uint8Array(gw * gh);
  if (color && bin === 1) {
    let members = 0;
    for (const v of shown) members += v;
    const r = members < SMALL_GROUP * cells ? Math.max(1, Math.round(dpr)) : 0;
    for (let b = 0; r && b < gw * gh; b++) {
      if (!shown[b]) continue;
      const bx = b % gw;
      const by = (b - bx) / gw;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = bx + dx;
        const y = by + dy;
        if (x >= 0 && x < gw && y >= 0 && y < gh) halo[y * gw + x] = 1;
      }
    }
  }
  const img = new ImageData(w, h);
  for (let b = 0; b < gw * gh; b++) {
    if (!total[b] && !halo[b]) continue;
    const presence = Math.min(1, total[b] / typical);
    let rgb = SECTION_RGB;
    let a = 0.35 * presence;
    if (color && shown[b] > 0) {
      rgb = color;
      a = Math.min(1, 0.45 + 1.4 * (shown[b] / total[b])) * Math.max(presence, 0.6);
    } else if (color && halo[b]) {
      rgb = color;
      a = 0.85;
    } else if (paint.kind === 'values') {
      rgb = VIRIDIS_RGB[Math.min(255, Math.round((255 * shown[b]) / total[b] / top))];
      a = 0.25 + 0.75 * presence;
    }
    const pixel = [rgb[0], rgb[1], rgb[2], Math.round(255 * a)];
    const bx = (b % gw) * bin;
    const by = Math.floor(b / gw) * bin;
    for (let y = by; y < Math.min(h, by + bin); y++) for (let x = bx; x < Math.min(w, bx + bin); x++) img.data.set(pixel, 4 * (y * w + x));
  }
  canvas.getContext('2d')!.putImageData(img, 0, 0);
}

export function TissueThumb({ tissue, paint, width, label }: { tissue: Tissue; paint: Paint; width: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [x0, y0, x1, y1] = tissue.bounds;
  // Taller sections are drawn no taller than they are wide.
  const height = Math.round(width * Math.min(1, (y1 - y0) / Math.max(x1 - x0, 1e-9)));
  useEffect(() => {
    if (ref.current) paintThumb(ref.current, tissue, paint, width, height);
  }, [tissue, paint, width, height]);
  return <canvas ref={ref} className="tissue-thumb" style={{ width, height }} role="img" aria-label={label} />;
}
