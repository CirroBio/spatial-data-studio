// Direct, read-only access to an immutable checkpoint `.zarr.zip` over HTTP Range
// via zarrita. Backs the read-only SnapshotViewer: positions, colors and image
// windows are read straight from the checkpoint rather than the live session API.
import * as zarr from 'zarrita';
import ZipFileStore from '@zarrita/storage/zip';
import type { ColorSource } from '../components/canvas/useSpotColors';
import { defaultChannelColor } from '../components/canvas/colorUtils';

async function openRoot(url: string) {
  const store = await ZipFileStore.fromUrl(url);
  const root = await zarr.open(store, { kind: 'group' });
  return { store, root };
}
export type Checkpoint = Awaited<ReturnType<typeof openRoot>>;
export type CheckpointRoot = Checkpoint['root'];

export function openCheckpoint(url: string): Promise<Checkpoint> {
  return openRoot(url);
}

// Whole numeric array -> Float64Array (uniform indexing regardless of on-disk
// int8/int32/float32/... dtype). Number() coerces the element union to a number.
async function readNumericWhole(root: CheckpointRoot, path: string): Promise<{ data: Float64Array; shape: number[] }> {
  const arr = await zarr.open(root.resolve(path), { kind: 'array' });
  const chunk = await zarr.get(arr);
  return { data: Float64Array.from(chunk.data, (v) => Number(v)), shape: chunk.shape };
}

async function readStringWhole(root: CheckpointRoot, path: string): Promise<string[]> {
  const arr = await zarr.open(root.resolve(path), { kind: 'array' });
  const chunk = await zarr.get(arr);
  return globalThis.Array.from(chunk.data, (v) => String(v));
}

export interface ObsmResult {
  data: Float32Array;  // row-major n*d
  n: number;
  d: number;
}

export async function readObsm(root: CheckpointRoot, table: string, key: string): Promise<ObsmResult> {
  const arr = await zarr.open(root.resolve(`tables/${table}/obsm/${key}`), { kind: 'array' });
  const chunk = await zarr.get(arr);
  const [n, d] = chunk.shape;
  return { data: Float32Array.from(chunk.data, (v) => Number(v)), n, d };
}

async function readGeneColumn(
  root: CheckpointRoot, table: string, basePath: string, gene: string,
): Promise<Float32Array> {
  const varNames = await readStringWhole(root, `tables/${table}/var/_index`);
  const g = varNames.indexOf(gene);
  if (g < 0) throw new Error(`gene ${gene} not found in ${table}/var/_index`);

  const node = await zarr.open(root.resolve(basePath));
  if (node.kind === 'group') {
    // AnnData sparse CSR: data / indices (column per nnz) / indptr (row offsets).
    const { data } = await readNumericWhole(root, `${basePath}/data`);
    const { data: indices } = await readNumericWhole(root, `${basePath}/indices`);
    const { data: indptr } = await readNumericWhole(root, `${basePath}/indptr`);
    const n = indptr.length - 1;
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      for (let k = indptr[i]; k < indptr[i + 1]; k++) {
        if (indices[k] === g) { values[i] = data[k]; break; }
      }
    }
    return values;
  }
  // Dense [n, n_var]: read the single gene column.
  const arr = await zarr.open(root.resolve(basePath), { kind: 'array' });
  const col = await zarr.get(arr, [null, g]);
  return Float32Array.from(col.data, (v) => Number(v));
}

// Resolve a color_by descriptor ("obs:<col>" | "X:<gene>" | "layers:<l>/<gene>")
// into the same ColorSource union the live canvas consumes.
export async function readColorSource(
  root: CheckpointRoot, table: string, colorBy: string,
): Promise<ColorSource | null> {
  if (!colorBy) return null;
  const sep = colorBy.indexOf(':');
  if (sep < 0) return null;
  const prefix = colorBy.slice(0, sep);
  const rest = colorBy.slice(sep + 1);

  if (prefix === 'obs') {
    const path = `tables/${table}/obs/${rest}`;
    const node = await zarr.open(root.resolve(path));
    if (node.kind === 'group') {
      const categories = await readStringWhole(root, `${path}/categories`);
      const { data } = await readNumericWhole(root, `${path}/codes`);
      return { kind: 'categorical', codes: Int32Array.from(data), categories };
    }
    const { data } = await readNumericWhole(root, path);
    return { kind: 'numeric', values: Float32Array.from(data) };
  }
  if (prefix === 'X') {
    return { kind: 'numeric', values: await readGeneColumn(root, table, `tables/${table}/X`, rest) };
  }
  if (prefix === 'layers') {
    const slash = rest.indexOf('/');
    const layer = rest.slice(0, slash);
    const gene = rest.slice(slash + 1);
    return { kind: 'numeric', values: await readGeneColumn(root, table, `tables/${table}/layers/${layer}`, gene) };
  }
  return null;
}

export interface ImageWindow {
  data: Uint8Array | Uint16Array | Float32Array;
  shape: [number, number, number];  // [C, h, w]
  dtype: string;
}

function narrowImageArray(
  data: Awaited<ReturnType<typeof zarr.get>>['data'], dtype: string,
): Uint8Array | Uint16Array | Float32Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof Uint16Array) return data;
  if (data instanceof Float32Array) return data;
  throw new Error(`unsupported image dtype ${dtype}`);
}

export async function readImageWindow(
  root: CheckpointRoot, element: string, level: number,
  [y0, y1]: [number, number], [x0, x1]: [number, number],
): Promise<ImageWindow> {
  const arr = await zarr.open(root.resolve(`images/${element}/s${level}`), { kind: 'array' });
  const chunk = await zarr.get(arr, [null, zarr.slice(y0, y1), zarr.slice(x0, x1)]);
  const [c, h, w] = chunk.shape;
  return { data: narrowImageArray(chunk.data, arr.dtype), shape: [c, h, w], dtype: arr.dtype };
}

export async function readImageLevelWhole(
  root: CheckpointRoot, element: string, level: number,
): Promise<ImageWindow> {
  const arr = await zarr.open(root.resolve(`images/${element}/s${level}`), { kind: 'array' });
  const chunk = await zarr.get(arr);
  const [c, h, w] = chunk.shape;
  return { data: narrowImageArray(chunk.data, arr.dtype), shape: [c, h, w], dtype: arr.dtype };
}

export interface CompositeChannel {
  visible: boolean;
  color: string;         // "#rrggbb"
  contrast_limit: number;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace('#', '');
  if (h.length !== 6) return null;
  const n = Number.parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Additively blend visible channels into an RGB ImageData, matching backend
// imaging._composite exactly: out_rgb = sum over visible channels of
// clip(value / contrast_limit, 0, 1) * color_rgb, then clip to [0,255]. Every
// channel (including a 3-channel uint8 H&E) is tinted by its assigned color; there
// is no native-RGB passthrough. contrast_limit is the upper bound (0 floor implicit).
export function compositeChannels(
  img: { data: Uint8Array | Uint16Array | Float32Array; shape: [number, number, number] },
  channels: Record<string, CompositeChannel> | null,
): ImageData {
  const [C, h, w] = img.shape;
  const px = h * w;
  const src = img.data;
  const out = new Uint8ClampedArray(px * 4);

  const overrides = channels ? Object.entries(channels).filter(([, ch]) => ch.visible) : [];

  // [channelIndex, rgb, contrast_limit] for each channel to blend.
  const active: [number, [number, number, number], number][] = [];
  if (overrides.length) {
    for (const [key, ch] of overrides) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= C) continue;
      active.push([idx, hexToRgb(ch.color) ?? [255, 255, 255], ch.contrast_limit || 1]);
    }
  } else {
    // No channel spec: mirror _composite's default (channel_colors=None) — every
    // channel visible with its default palette color; dtype-max contrast stands in
    // for the backend's percentile norm (uint8 -> 255, uint16 -> 65535).
    const limit = src instanceof Uint8Array ? 255 : src instanceof Uint16Array ? 65535 : 1;
    for (let c = 0; c < C; c++) {
      active.push([c, hexToRgb(defaultChannelColor(c)) ?? [255, 255, 255], limit]);
    }
  }

  const acc = new Float32Array(px * 3);
  for (const [c, [r, g, b], limit] of active) {
    const base = c * px;
    const lim = limit || 1;
    for (let i = 0; i < px; i++) {
      const frac = Math.min(1, Math.max(0, src[base + i] / lim));
      acc[i * 3] += frac * r;
      acc[i * 3 + 1] += frac * g;
      acc[i * 3 + 2] += frac * b;
    }
  }
  for (let i = 0; i < px; i++) {
    out[i * 4] = acc[i * 3];
    out[i * 4 + 1] = acc[i * 3 + 1];
    out[i * 4 + 2] = acc[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, w, h);
}
