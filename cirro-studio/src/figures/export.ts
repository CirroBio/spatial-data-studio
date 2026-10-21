import type { FigureLayout } from './layout';

/** The print resolution raster figures are written at. */
export const FIGURE_DPI = 300;

const INCHES_PER_METRE = 1 / 0.0254;

// CRC-32 as PNG chunks use it (ISO 3309), for the one chunk this module writes.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** `png` with a pHYs chunk declaring `dpi`, inserted after IHDR, so the file reports its
 * print resolution. The browser's encoder writes none. */
export function withPhys(png: Uint8Array<ArrayBuffer>, dpi: number): Uint8Array<ArrayBuffer> {
  const IHDR_END = 8 + 4 + 4 + 13 + 4; // signature, IHDR length, type, data, CRC
  const ppm = Math.round(dpi * INCHES_PER_METRE);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, ppm);
  view.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, IHDR_END), 0);
  out.set(chunk, IHDR_END);
  out.set(png.subarray(IHDR_END), IHDR_END + chunk.length);
  return out;
}

export function svgBlob(svg: string): Blob {
  return new Blob([svg], { type: 'image/svg+xml' });
}

/** Rasterise the figure at `dpi`, white background, through the browser's own SVG
 * renderer (the same one that shows the preview). */
export async function pngBlob(svg: string, layout: FigureLayout, dpi = FIGURE_DPI): Promise<Blob> {
  const width = Math.round((layout.widthMm / 25.4) * dpi);
  const height = Math.round((layout.heightMm / 25.4) * dpi);
  const url = URL.createObjectURL(svgBlob(svg));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('The browser could not create a drawing surface for the PNG.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error(`The browser could not encode a ${width} × ${height} PNG.`);
    return new Blob([withPhys(new Uint8Array(await blob.arrayBuffer()), dpi)], { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A one-page, compressed PDF the size of the figure, with the title and legend as
 * vector text and the canvas capture as an embedded image. */
export async function pdfBlob(svg: string, layout: FigureLayout): Promise<Blob> {
  // Loaded on first export: the PDF writer is most of the export code's weight.
  const [{ jsPDF }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const doc = new jsPDF({
    unit: 'mm',
    format: [layout.widthMm, layout.heightMm],
    orientation: layout.widthMm > layout.heightMm ? 'landscape' : 'portrait',
    compress: true,
  });
  const element = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  await doc.svg(element, { x: 0, y: 0, width: layout.widthMm, height: layout.heightMm });
  return doc.output('blob');
}
