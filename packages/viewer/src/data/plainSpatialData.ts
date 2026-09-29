// Reading a plain SpatialData store — one written by spatialdata / spatialdata-io / a
// pipeline such as nf-core/sopa rather than saved by this app — without the backend.
//
// An app-saved checkpoint carries a `viewer/` sidecar the backend baked for the browser
// (docs/CHECKPOINT_FORMAT.md §4): the table to read, each image's manifest, where the
// spots sit. A plain store has none of that, so this module derives the same sidecar
// from the store's consolidated metadata, the way the backend would (`imaging.image_info`,
// `manager.auto_displays`), and the reader then treats it like any other checkpoint.
//
// What it does not derive: the shapes spatial index (plain shapes parquet has no
// `bbox` covering column), so a plain store's cell boundaries are not drawn, and the
// CSC gene mirror, so coloring by a gene reads the table's whole CSR matrix.
import * as zarr from 'zarrita';
import type { AsyncReadable } from '@zarrita/storage';
import type { ImageInfo } from '../types';

type Root = zarr.Location<AsyncReadable>;
export type Contents = { path: string; kind: 'array' | 'group' }[];

/** A 3x3 affine over (x, y), row-major: [[a, b, c], [d, e, f], [0, 0, 1]]. */
export type Affine3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Affine3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function multiply(m: Affine3, n: Affine3): Affine3 {
  const out = new Array<number>(9).fill(0) as Affine3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = m[r * 3] * n[c] + m[r * 3 + 1] * n[3 + c] + m[r * 3 + 2] * n[6 + c];
    }
  }
  return out;
}

export function invert([a, b, c, d, e, f]: Affine3): Affine3 {
  const det = a * e - b * d;
  if (det === 0) throw new Error('singular coordinate transform');
  return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det, 0, 0, 1];
}

export function toAffine6([a, b, c, d, e, f]: Affine3): number[] {
  return [a, b, c, d, e, f];
}

type Box = [number, number, number, number];

/** `box` pushed through `m`, as the axis-aligned box of all four corners (`bbox_aabb`). */
export function boxThrough(m: Affine3, [x0, y0, x1, y1]: Box): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    xs.push(m[0] * x + m[1] * y + m[2]);
    ys.push(m[3] * x + m[4] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function iou(a: Box, b: Box): number {
  const inter = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

interface NgffTransform {
  type: string;
  input?: { name?: string; axes?: { name: string }[] };
  output?: { name?: string };
  scale?: number[];
  translation?: number[];
  affine?: number[][];
  transformations?: NgffTransform[];
}

/** One NGFF/SpatialData coordinate transformation as a 2-D affine, or null for one no
 *  2-D affine can express. `axes` names the input axes when the transform does not. */
export function transformToAffine(t: NgffTransform, axes: readonly string[]): Affine3 | null {
  const names = t.input?.axes?.map((a) => a.name) ?? axes;
  const ix = names.indexOf('x');
  const iy = names.indexOf('y');
  switch (t.type) {
    case 'identity':
      return IDENTITY;
    case 'scale':
      if (!t.scale || ix < 0 || iy < 0) return null;
      return [t.scale[ix], 0, 0, 0, t.scale[iy], 0, 0, 0, 1];
    case 'translation':
      if (!t.translation || ix < 0 || iy < 0) return null;
      return [1, 0, t.translation[ix], 0, 1, t.translation[iy], 0, 0, 1];
    case 'affine': {
      // Rows are output axes, columns input axes plus the translation column. SpatialData
      // writes outputs in the same axis names as inputs.
      const m = t.affine;
      if (!m || ix < 0 || iy < 0 || m.length < Math.max(ix, iy) + 1) return null;
      const last = names.length;
      return [m[ix][ix], m[ix][iy], m[ix][last], m[iy][ix], m[iy][iy], m[iy][last], 0, 0, 1];
    }
    case 'sequence': {
      let out = IDENTITY;
      for (const step of t.transformations ?? []) {
        const next = transformToAffine(step, names);
        if (!next) return null;
        out = multiply(next, out);
      }
      return out;
    }
    default:
      return null;
  }
}

/** An element's intrinsic -> coordinate-system affines, keyed by system name. */
export function elementTransforms(attrs: Record<string, unknown>): Map<string, Affine3> {
  const ome = (attrs.ome ?? attrs) as { multiscales?: { coordinateTransformations?: NgffTransform[]; axes?: { name: string }[] }[] };
  const multiscale = ome.multiscales?.[0];
  const list = multiscale?.coordinateTransformations
    ?? (attrs.coordinateTransformations as NgffTransform[] | undefined) ?? [];
  const axes = multiscale?.axes?.map((a) => a.name) ?? (attrs.axes as string[] | undefined) ?? ['x', 'y'];
  const out = new Map<string, Affine3>();
  for (const t of list) {
    const system = t.output?.name;
    const affine = transformToAffine(t, axes);
    if (system && affine) out.set(system, affine);
  }
  return out;
}

/** Immediate children of a group, from the consolidated listing. */
export function childrenOf(contents: Contents, group: string): string[] {
  const prefix = `${group}/`;
  return contents
    .map((entry) => entry.path.replace(/^\//, ''))
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map((path) => path.slice(prefix.length));
}

async function groupAttrs(root: Root, path: string): Promise<Record<string, unknown>> {
  return (await (await zarr.open.v3(root.resolve(path), { kind: 'group' })).attrs) as Record<string, unknown>;
}

// Upper contrast bound from the coarsest level, as `imaging._channel_norm` computes it:
// 255 for uint8, else the 99.9th percentile. Sampled past this many values; the
// percentile of a strided sample of a smooth image is the same to display precision.
const MAX_PERCENTILE_SAMPLES = 1_000_000;

function channelStats(values: ArrayLike<number>, start: number, count: number, isUint8: boolean): {
  limit: number; min: number; max: number;
} {
  let min = Infinity;
  let max = -Infinity;
  const stride = Math.max(1, Math.floor(count / MAX_PERCENTILE_SAMPLES));
  const sample: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = Number(values[start + i]);
    if (v < min) min = v;
    if (v > max) max = v;
    if (i % stride === 0) sample.push(v);
  }
  if (isUint8) return { limit: 255, min, max };
  if (sample.length === 0) return { limit: 1, min, max };
  sample.sort((a, b) => a - b);
  // numpy's default (linear) percentile, as the backend computes it.
  const rank = 0.999 * (sample.length - 1);
  const below = Math.floor(rank);
  const p = sample[below] + (sample[Math.min(below + 1, sample.length - 1)] - sample[below]) * (rank - below);
  return { limit: Math.max(p, 1), min, max };
}

interface ImageLayout {
  info: Omit<ImageInfo, 'pixel_to_world' | 'bounds'>;
  transforms: Map<string, Affine3>;
}

async function readImageLayout(root: Root, element: string): Promise<ImageLayout> {
  const base = `images/${element}`;
  const attrs = await groupAttrs(root, base);
  const ome = (attrs.ome ?? attrs) as {
    multiscales?: { datasets?: { path: string }[] }[];
    // spatialdata writes a label per channel; for an image read without channel names
    // they are the channel indices, as numbers.
    omero?: { channels?: { label?: string | number }[] };
  };
  const datasets = ome.multiscales?.[0]?.datasets ?? [];
  if (datasets.length === 0) throw new Error(`image "${element}" has no multiscale levels`);
  const arrays = await Promise.all(
    datasets.map((d) => zarr.open.v3(root.resolve(`${base}/${d.path}`), { kind: 'array' })));
  const level0 = arrays[0];
  // (c, y, x), or (y, x) for a single-channel image written without a channel axis.
  const hasChannelAxis = level0.shape.length === 3;
  const [nChannels, height, width] = hasChannelAxis ? level0.shape : [1, ...level0.shape];
  const labels = ome.omero?.channels?.map((c) => (c.label === undefined ? '' : String(c.label))) ?? [];
  const channelNames = Array.from({ length: nChannels }, (_, i) => labels[i] || String(i));
  const isUint8 = level0.dtype === 'uint8';

  const coarsest = arrays[arrays.length - 1];
  const pixels = await zarr.get(coarsest);
  const perChannel = pixels.data.length / nChannels;
  const stats = channelNames.map((_, c) => channelStats(pixels.data as ArrayLike<number>, c * perChannel, perChannel, isUint8));
  const lower = channelNames.map((n) => n.toLowerCase());
  return {
    info: {
      element,
      width,
      height,
      channels: nChannels,
      channel_names: channelNames,
      levels: arrays.map((a, level) => ({ level, width: a.shape[a.shape.length - 1], height: a.shape[a.shape.length - 2] })),
      tile_size: level0.chunks[level0.chunks.length - 1],
      contrast_limits: stats.map((s) => [0, s.limit]),
      contrast_range: stats.map((s) => [s.min, s.max]),
      is_rgb: nChannels === 3 && isUint8
        && (lower.join() === 'r,g,b' || lower.join() === '0,1,2'),
    },
    transforms: elementTransforms(attrs),
  };
}

// Systems to try, 'global' first — SpatialData's conventional shared system.
function systemOrder(systems: Iterable<string>): string[] {
  return [...systems].sort((a, b) => (a === 'global' ? -1 : b === 'global' ? 1 : 0));
}

/**
 * Level-0 pixel -> spot-space affine for one image, reconciled the way
 * `imaging.pixel_to_world` does it: the spots live in some element's intrinsic space,
 * and which one is not reliably declared (a Xenium table names pixel-space labels as
 * its region while its spots are in microns). For each system the image maps into,
 * try identity and every shapes/labels element's transform as the spots -> system map,
 * keep the one whose spot extent best overlaps the image, and compose image -> system
 * with its inverse.
 */
export function reconcileImage(
  image: Map<string, Affine3>, candidates: Map<string, Map<string, Affine3>>,
  spotBox: Box | null, width: number, height: number,
): Affine3 {
  const systems = systemOrder(image.keys());
  const fallback = systems.length ? image.get(systems[0]) ?? IDENTITY : IDENTITY;
  if (!spotBox) return fallback;
  let best: { spots: Affine3; image: Affine3; score: number } = { spots: IDENTITY, image: fallback, score: -1 };
  for (const system of systems) {
    const toSystem = image.get(system) ?? IDENTITY;
    const extent = boxThrough(toSystem, [0, 0, width, height]);
    const options = [IDENTITY, ...[...candidates.values()].flatMap((byElement) => {
      const a = byElement.get(system);
      return a ? [a] : [];
    })];
    for (const spots of options) {
      const score = iou(boxThrough(spots, spotBox), extent);
      if (score > best.score) best = { spots, image: toSystem, score };
    }
  }
  return best.score > 0 ? multiply(invert(best.spots), best.image) : fallback;
}

async function spotBoxOf(root: Root, table: string, worldKey: string): Promise<Box | null> {
  const arr = await zarr.open.v3(root.resolve(`tables/${table}/obsm/${worldKey}`), { kind: 'array' });
  if (arr.shape.length < 2 || arr.shape[1] < 2) return null;
  const { data, shape } = await zarr.get(arr);
  const [n, d] = shape;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const x = Number((data as ArrayLike<number>)[i * d]);
    const y = Number((data as ArrayLike<number>)[i * d + 1]);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return n > 0 ? [x0, y0, x1, y1] : null;
}

/** The sidecar fields `openCheckpoint` reads, derived for a plain store. */
export interface DerivedSidecar {
  sidecar_version: number;
  table_keys: string[];
  images: Record<string, Record<string, ImageInfo>>;
  coords_transform: Record<string, number[]>;
  world_key: Record<string, string>;
}

/** Why a store cannot be shown, phrased for the person who opened it. */
export class UnrenderableStoreError extends Error {}

/**
 * Derive the viewer sidecar for a plain SpatialData store, or explain why there is
 * nothing to show. The table is the first under `tables/` that has spatial coordinates
 * (`obsm/spatial`); images are every element under `images/`.
 */
export async function deriveSidecar(root: Root, contents: Contents, rootAttrs: Record<string, unknown>): Promise<DerivedSidecar> {
  if (contents.length === 0) {
    throw new UnrenderableStoreError(
      'This store has no consolidated metadata, so the viewer cannot see what it contains. '
      + 'Write it with spatialdata (which consolidates by default), or run '
      + '`spatialdata.SpatialData.write_consolidated_metadata()` on it.');
  }
  const tables = childrenOf(contents, 'tables');
  const table = tables.find((t) => childrenOf(contents, `tables/${t}/obsm`).includes('spatial'));
  if (!table) {
    const what = rootAttrs.spatialdata_attrs ? 'This SpatialData store' : 'This zarr store is not a SpatialData store and';
    throw new UnrenderableStoreError(tables.length === 0
      ? `${what} has no table, so there are no cells for the viewer to draw.`
      : `${what} has no table with spatial coordinates (obsm "spatial"), so the viewer cannot place its cells. `
        + `Tables found: ${tables.join(', ')}.`);
  }
  const worldKey = 'spatial';
  const spotBox = await spotBoxOf(root, table, worldKey);

  const candidates = new Map<string, Map<string, Affine3>>();
  for (const group of ['shapes', 'labels', 'points']) {
    for (const element of childrenOf(contents, group)) {
      candidates.set(`${group}/${element}`, elementTransforms(await groupAttrs(root, `${group}/${element}`)));
    }
  }

  const images: DerivedSidecar['images'] = {};
  for (const element of childrenOf(contents, 'images')) {
    let layout: ImageLayout;
    try {
      layout = await readImageLayout(root, element);
    } catch (err) {
      // One unreadable image should not hide the cells; the rest of the store still opens.
      console.warn('[plain store] skipping image "%s": %s', element, err instanceof Error ? err.message : err);
      continue;
    }
    const pixelToWorld = reconcileImage(layout.transforms, candidates, spotBox, layout.info.width, layout.info.height);
    images[element] = {
      [table]: {
        ...layout.info,
        pixel_to_world: toAffine6(pixelToWorld) as ImageInfo['pixel_to_world'],
        bounds: boxThrough(pixelToWorld, [0, 0, layout.info.width, layout.info.height]),
      },
    };
  }

  return {
    sidecar_version: 2,
    table_keys: [table],
    images,
    coords_transform: { [table]: toAffine6(IDENTITY) },
    world_key: { [table]: worldKey },
  };
}

// obsm keys the default embedding display prefers, best first (`_PREFERRED_EMBEDDINGS`).
const PREFERRED_EMBEDDINGS = ['X_umap', 'X_tsne', 'X_diffmap'];

/**
 * Default displays for a store saved without any, as `manager.auto_displays` makes them:
 * a spatial canvas colored by the first of `categoricals` (the table's pandas Categorical
 * obs columns, in column order) over the first image, and an embedding canvas when the
 * table has an embedding.
 */
export function autoDisplays(fields: {
  obsm: { name: string }[];
  images: string[];
}, categoricals: readonly string[]): Record<string, unknown>[] {
  const color = categoricals[0] ? `obs:${categoricals[0]}` : null;
  const obsmNames = fields.obsm.map((f) => f.name);
  const point = { point_size: 4, opacity: 0.85, colormap: 'viridis', legend_visible: true, legend_title: '' };
  // Stable ids, not per-open UUIDs: the store is re-derived on every open, and a saved
  // view or shared link names its display by id.
  const displays: Record<string, unknown>[] = [{
    id: 'auto-spatial',
    type: 'spatial_canvas',
    encoding: {
      coords: obsmNames.includes('spatial') ? 'obsm:spatial' : (obsmNames[0] ? `obsm:${obsmNames[0]}` : null),
      color_by: color,
      image_layer: fields.images[0] ?? null,
      shapes_layer: null,
      render_mode: 'points',
      point_marker: 'circle',
      ...point,
    },
    viewport: null,
  }];
  const embedding = PREFERRED_EMBEDDINGS.find((k) => obsmNames.includes(k)) ?? obsmNames.find((k) => k !== 'spatial');
  if (embedding) {
    displays.push({
      id: 'auto-embedding',
      type: 'embedding_canvas',
      encoding: {
        obsm_key: embedding, x_component: 0, y_component: 1, z_component: 2, is_3d: false,
        color_by: color, ...point,
      },
      viewport: null,
    });
  }
  return displays;
}
