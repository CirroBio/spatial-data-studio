import type { ScaleBar } from './scaleBar';

// A publication figure as one SVG document, in millimetres: the canvas capture as an
// embedded raster (points and tissue image exactly as drawn), with the title and legend
// as vector text and shapes. The SVG is the master: PNG and PDF are rendered from it.

export type SizePreset = 'single' | 'double' | 'slide';

// Journal sizes: single column 89 mm, double column 183 mm; a slide is 16:9 at 254 × 143 mm.
export const SIZE_PRESETS: Record<SizePreset, { label: string; widthMm: number; heightMm?: number }> = {
  single: { label: 'One column (89 mm)', widthMm: 89 },
  double: { label: 'Two columns (183 mm)', widthMm: 183 },
  slide: { label: 'A slide (16:9)', widthMm: 254, heightMm: 143 },
};

export type FigureLegend =
  | { kind: 'categorical'; title: string; items: { label: string; color: string }[] }
  | { kind: 'numeric'; title: string; min: number; max: number; stops: string[] };

export interface FigureCapture {
  /** PNG data URL of the canvas. */
  dataUrl: string;
  width: number;
  height: number;
  /** The canvas' width in CSS pixels, which is what the camera's scale is in. */
  cssWidth: number;
}

export interface FigureLayoutSpec {
  title: string;
  preset: SizePreset;
  legend: FigureLegend | null;
  /** Drawn in the image's lower left when the coordinates' unit is known. */
  scaleBar: ScaleBar | null;
  capture: FigureCapture;
  /** Font family and size (pt) for every label: the tokens' --sds-figure-font(-size). */
  font: string;
  fontPt: number;
}

export interface LegendBox {
  /** Room the legend takes beside the image, the gap before it included. */
  w: number;
  h: number;
  /** Categories per column, and each column's width. */
  rows: number;
  columnW: number;
  /** The last categories, which don't fit on the page and aren't drawn. */
  omitted: number;
}

export interface FigureLayout {
  widthMm: number;
  heightMm: number;
  image: { x: number; y: number; w: number; h: number };
  legend: LegendBox | null;
  /** Pixels of the capture per inch of printed image: what the raster actually holds. */
  effectiveDpi: number;
}

const MARGIN = 3;
const PT_TO_MM = 25.4 / 72;
// An A4 page's text block: no figure is taller, whatever its legend or image.
export const PAGE_HEIGHT_MAX = 240;
// Categorical legends taller than this many rows wrap into another column, as long as
// the columns stay within this share of the page's width; past that they grow taller.
// One taller than the page takes more columns, leaving the image at least its share of
// the width; one that still doesn't fit leaves its last categories out.
const LEGEND_ROWS_MAX = 24;
const LEGEND_WIDTH_SHARE = 0.5;
const IMAGE_WIDTH_SHARE_MIN = 1 / 3;
// Between the image and the legend, and between legend columns.
const LEGEND_GAP = 3;
const COLUMN_GAP = 2;
const SWATCH_MM = 2.4;
const COLORBAR_MM = 30;

const legendRowH = (fontMm: number) => Math.max(SWATCH_MM, fontMm) * 1.25;
// The title line, above the swatches or colorbar.
const legendHeadH = (fontMm: number) => fontMm * 1.9;

// figureLayout sizes the page from this and legendSvg draws by it, so the legend fits in
// the page's width and in `roomH`, the height below the title.
function legendBox(legend: FigureLegend, fontMm: number, pageW: number, roomH: number): LegendBox {
  if (legend.kind === 'numeric') return { w: 18, h: legendHeadH(fontMm) + COLORBAR_MM, rows: 0, columnW: 0, omitted: 0 };
  const count = legend.items.length;
  // Proportional fonts average about half an em per character.
  const longest = Math.max(legend.title.length * 0.6, ...legend.items.map((i) => i.label.length));
  const columnW = SWATCH_MM + 1.5 + Math.min(longest, 28) * fontMm * 0.52;
  const columnsIn = (w: number) => Math.max(1, Math.floor((w - LEGEND_GAP + COLUMN_GAP) / (columnW + COLUMN_GAP)));
  const rowsFit = Math.max(1, Math.floor((roomH - legendHeadH(fontMm)) / legendRowH(fontMm)));
  let columns = Math.min(Math.max(1, Math.ceil(count / LEGEND_ROWS_MAX)), columnsIn(pageW * LEGEND_WIDTH_SHARE));
  if (Math.ceil(count / columns) > rowsFit) {
    columns = Math.min(Math.ceil(count / rowsFit), columnsIn(pageW * (1 - IMAGE_WIDTH_SHARE_MIN) - 2 * MARGIN));
  }
  const rows = Math.min(Math.ceil(count / columns), rowsFit);
  return {
    w: columns * columnW + (columns - 1) * COLUMN_GAP + LEGEND_GAP,
    h: legendHeadH(fontMm) + rows * legendRowH(fontMm),
    rows,
    columnW,
    omitted: Math.max(0, count - rows * columns),
  };
}

export function figureLayout(spec: FigureLayoutSpec): FigureLayout {
  const preset = SIZE_PRESETS[spec.preset];
  const fontMm = spec.fontPt * PT_TO_MM;
  const titleBand = spec.title.trim() ? fontMm * 1.15 * 1.8 : 0;
  // Below the title on the tallest page the preset allows: a fixed page's own height.
  const room = (preset.heightMm ?? PAGE_HEIGHT_MAX) - 2 * MARGIN - titleBand;
  const legend = spec.legend && legendBox(spec.legend, fontMm, preset.widthMm, room);
  const aspect = spec.capture.height / spec.capture.width;
  let w = preset.widthMm - 2 * MARGIN - (legend?.w ?? 0);
  let h = w * aspect;
  // Too tall for the page: fit the image into what is left, keeping its aspect.
  if (h > room) { h = room; w = room / aspect; }
  return {
    widthMm: preset.widthMm,
    // The legend hangs from the image's top edge and may run longer than the image.
    heightMm: preset.heightMm ?? 2 * MARGIN + titleBand + Math.max(h, 10, legend?.h ?? 0),
    image: { x: MARGIN, y: MARGIN + titleBand, w, h },
    legend,
    effectiveDpi: Math.round(spec.capture.width / (w / 25.4)),
  };
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n: number) => Number(n.toFixed(3)).toString();
// Layout is in mm; the SVG is written in points, so its viewBox is in points and a 7 pt
// label is 7 pt when the file is imported into Illustrator or Inkscape.
const pt = (mm: number) => num(mm / PT_TO_MM);

function formatTick(n: number): string {
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 0.01 || abs >= 1e5)) return n.toExponential(1);
  return Number(n.toPrecision(3)).toString();
}

function legendSvg(legend: FigureLegend, box: LegendBox, x: number, y: number, fontMm: number, font: string): string {
  const text = (tx: number, ty: number, body: string, extra = '') =>
    `<text x="${pt(tx)}" y="${pt(ty)}" font-family="${escapeXml(font)}" font-size="${pt(fontMm)}"${extra} fill="#000000">${escapeXml(body)}</text>`;
  const parts = [text(x, y + fontMm, legend.title, ' font-weight="bold"')];
  const top = y + legendHeadH(fontMm);
  if (legend.kind === 'categorical') {
    const { rows, columnW, omitted } = box;
    legend.items.slice(0, legend.items.length - omitted).forEach((item, i) => {
      const cx = x + Math.floor(i / rows) * (columnW + COLUMN_GAP);
      const cy = top + (i % rows) * legendRowH(fontMm);
      parts.push(`<rect x="${pt(cx)}" y="${pt(cy)}" width="${pt(SWATCH_MM)}" height="${pt(SWATCH_MM)}" fill="${item.color}" stroke="#666666" stroke-width="${pt(0.1)}"/>`);
      const label = item.label.length > 28 ? `${item.label.slice(0, 27)}…` : item.label;
      parts.push(text(cx + SWATCH_MM + 1.2, cy + SWATCH_MM * 0.85, label));
    });
  } else {
    const id = 'legend-gradient';
    const stops = legend.stops.map((c, i) => `<stop offset="${num(i / (legend.stops.length - 1))}" stop-color="${c}"/>`).join('');
    parts.push(`<defs><linearGradient id="${id}" x1="0" y1="1" x2="0" y2="0">${stops}</linearGradient></defs>`);
    parts.push(`<rect x="${pt(x)}" y="${pt(top)}" width="${pt(3)}" height="${pt(COLORBAR_MM)}" fill="url(#${id})" stroke="#666666" stroke-width="${pt(0.1)}"/>`);
    parts.push(text(x + 4.2, top + fontMm * 0.8, formatTick(legend.max)));
    parts.push(text(x + 4.2, top + COLORBAR_MM, formatTick(legend.min)));
  }
  return parts.join('');
}

const SCALE_BAR_INSET = 2;
const SCALE_BAR_HEIGHT = 0.8;

/** A black bar with its length above it, on a white backing so it reads over any tissue. */
function scaleBarSvg(bar: ScaleBar, image: FigureLayout['image'], fontMm: number, font: string): string {
  const width = image.w * bar.fraction;
  const x = image.x + SCALE_BAR_INSET;
  const barY = image.y + image.h - SCALE_BAR_INSET - SCALE_BAR_HEIGHT;
  const textY = barY - 0.6;
  const pad = 0.8;
  return [
    `<rect x="${pt(x - pad)}" y="${pt(textY - fontMm - pad / 2)}" width="${pt(width + 2 * pad)}" height="${pt(fontMm + SCALE_BAR_HEIGHT + 0.6 + 1.5 * pad)}" fill="#ffffff" fill-opacity="0.8"/>`,
    `<rect x="${pt(x)}" y="${pt(barY)}" width="${pt(width)}" height="${pt(SCALE_BAR_HEIGHT)}" fill="#000000"/>`,
    `<text x="${pt(x + width / 2)}" y="${pt(textY)}" text-anchor="middle" font-family="${escapeXml(font)}" font-size="${pt(fontMm)}" fill="#000000">${escapeXml(bar.label)}</text>`,
  ].join('');
}

export function figureSvg(spec: FigureLayoutSpec): string {
  const layout = figureLayout(spec);
  const fontMm = spec.fontPt * PT_TO_MM;
  const { image } = layout;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${num(layout.widthMm)}mm" height="${num(layout.heightMm)}mm" viewBox="0 0 ${pt(layout.widthMm)} ${pt(layout.heightMm)}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
  ];
  if (spec.title.trim()) {
    parts.push(`<text x="${pt(MARGIN)}" y="${pt(MARGIN + fontMm * 1.15)}" font-family="${escapeXml(spec.font)}" font-size="${pt(fontMm * 1.15)}" font-weight="bold" fill="#000000">${escapeXml(spec.title)}</text>`);
  }
  parts.push(`<image x="${pt(image.x)}" y="${pt(image.y)}" width="${pt(image.w)}" height="${pt(image.h)}" preserveAspectRatio="xMidYMid meet" href="${spec.capture.dataUrl}" xlink:href="${spec.capture.dataUrl}"/>`);
  if (spec.legend && layout.legend) parts.push(legendSvg(spec.legend, layout.legend, image.x + image.w + LEGEND_GAP, image.y, fontMm, spec.font));
  if (spec.scaleBar) parts.push(scaleBarSvg(spec.scaleBar, image, fontMm, spec.font));
  parts.push('</svg>');
  return parts.join('\n');
}
