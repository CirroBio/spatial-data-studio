// Deriving the viewer sidecar for a plain SpatialData store. The fixture copies the
// geometry of a spatialdata-io Xenium store: the spots are in microns, the image in
// pixels (identity to `global`), and only a shapes element's transform says how the two
// relate — the case the image reconciliation exists for.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as zarr from 'zarrita';
import type { AbsolutePath, RangeQuery } from '@zarrita/storage';
import {
  IDENTITY, autoDisplays, boxThrough, cellIndexOf, deriveSidecar, elementTransforms, invert,
  multiply, reconcileImage, transformToAffine, UnrenderableStoreError, type Affine3, type Contents,
} from './plainSpatialData';
import { openCheckpoint } from './checkpointSource';

const PX_PER_UM = 4.7;
const xy = (name: string) => ({ name, axes: [{ name: 'x' }, { name: 'y' }] });

// GeoParquet as geopandas writes it for spatialdata, generated with:
//   GeoDataFrame(geometry=[box(-2, -2, 2, 2), box(98, 98, 102, 102)],
//                index=["cell-a", "cell-b"]).to_parquet("cells.parquet")
//   GeoDataFrame(geometry=[box(-4.7, -4.7, 4.7, 4.7),
//                          box(465.3, 465.3, 474.7, 474.7)]).to_parquet("nuclei.parquet")
// `cells` is the table's region, in microns and keyed by the obs index; `nuclei` is in
// pixels with a RangeIndex, matched through the `cell_id` instance column.
const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, '__fixtures__', name)));

// A Zarr v3 string array, chunk and all: zarrita reads `vlen-utf8` but cannot encode it.
function setStrings(store: Map<string, Uint8Array>, path: string, values: string[]): void {
  const encoded = values.map((v) => new TextEncoder().encode(v));
  const chunk = new Uint8Array(4 + encoded.reduce((n, b) => n + 4 + b.length, 0));
  const view = new DataView(chunk.buffer);
  view.setUint32(0, values.length, true);
  let at = 4;
  for (const bytes of encoded) {
    view.setUint32(at, bytes.length, true);
    chunk.set(bytes, at + 4);
    at += 4 + bytes.length;
  }
  store.set(`/${path}/zarr.json`, new TextEncoder().encode(JSON.stringify({
    zarr_format: 3, node_type: 'array', shape: [values.length], data_type: 'string',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [values.length] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: '', codecs: [{ name: 'vlen-utf8', configuration: {} }], attributes: {},
  })));
  store.set(`/${path}/c/0`, chunk);
}

/** A minimal consolidated Zarr v3 SpatialData store, in memory. Without a table it is an
 *  image that has not been segmented yet: no tables group at all. */
async function plainStore({ withTable = true } = {}) {
  const store = new Map<string, Uint8Array>();
  const root = zarr.root(store);
  await zarr.create(root, { attributes: { spatialdata_attrs: { version: '0.2' } } });
  for (const g of ['images', 'shapes']) await zarr.create(root.resolve(g));
  if (withTable) {
    await zarr.create(root.resolve('tables'));
    await zarr.create(root.resolve('tables/table'), { attributes: { region: 'cells', region_key: 'region', instance_key: 'cell_id' } });
    await zarr.create(root.resolve('tables/table/obsm'));
    await zarr.create(root.resolve('tables/table/obs'), { attributes: { 'column-order': [], _index: '_index' } });
    setStrings(store, 'tables/table/obs/_index', ['cell-a', 'cell-b']);
    const ids = await zarr.create(root.resolve('tables/table/obs/cell_id'), { shape: [2], chunkShape: [2], dtype: 'int64' });
    await zarr.set(ids, null, { data: new BigInt64Array([0n, 1n]), shape: [2], stride: [1] });
    const spots = await zarr.create(root.resolve('tables/table/obsm/spatial'), { shape: [2, 2], chunkShape: [2, 2], dtype: 'float64' });
    await zarr.set(spots, null, { data: new Float64Array([0, 0, 100, 100]), shape: [2, 2], stride: [2, 1] });
  }
  await zarr.create(root.resolve('shapes/cells'), {
    attributes: { axes: ['x', 'y'], coordinateTransformations: [{ type: 'scale', scale: [PX_PER_UM, PX_PER_UM], input: xy('xy'), output: xy('global') }] },
  });
  await zarr.create(root.resolve('shapes/nuclei'), {
    attributes: { axes: ['x', 'y'], coordinateTransformations: [{ type: 'identity', input: xy('xy'), output: xy('global') }] },
  });
  store.set('/shapes/cells/shapes.parquet', fixture('cells.parquet'));
  store.set('/shapes/nuclei/shapes.parquet', fixture('nuclei.parquet'));
  const cyx = { axes: [{ name: 'c' }, { name: 'y' }, { name: 'x' }] };
  await zarr.create(root.resolve('images/dapi'), {
    attributes: {
      ome: {
        omero: { channels: [{ label: 'DAPI' }] },
        multiscales: [{ datasets: [{ path: 's0' }], coordinateTransformations: [{ type: 'identity', input: { name: 'cyx', ...cyx }, output: { name: 'global', ...cyx } }] }],
      },
    },
  });
  const size = 470;
  const pixels = await zarr.create(root.resolve('images/dapi/s0'), { shape: [1, size, size], chunkShape: [1, size, size], dtype: 'uint16' });
  const ramp = Uint16Array.from({ length: size * size }, (_, i) => i % 1000);
  await zarr.set(pixels, null, { data: ramp, shape: [1, size, size], stride: [size * size, size, 1] });

  // Consolidate the way spatialdata does: every node's metadata inline in the root.
  const decoder = new TextDecoder();
  const metadata: Record<string, unknown> = {};
  for (const [key, bytes] of store) {
    if (key.endsWith('/zarr.json') && key !== '/zarr.json') metadata[key.slice(1, -'/zarr.json'.length)] = JSON.parse(decoder.decode(bytes));
  }
  const rootMeta = JSON.parse(decoder.decode(store.get('/zarr.json')));
  rootMeta.consolidated_metadata = { kind: 'inline', must_understand: false, metadata };
  store.set('/zarr.json', new TextEncoder().encode(JSON.stringify(rootMeta)));

  const raw = {
    get: async (key: AbsolutePath) => store.get(key),
    getRange: async (key: AbsolutePath, range: RangeQuery) => {
      const bytes = store.get(key);
      if (!bytes) return undefined;
      return 'suffixLength' in range
        ? bytes.slice(-range.suffixLength)
        : bytes.slice(range.offset, range.offset + range.length);
    },
  };
  const consolidated = await zarr.withMaybeConsolidatedMetadata(raw, { format: 'v3' });
  const contents = ('contents' in consolidated ? consolidated.contents() : []) as Contents;
  const opened = zarr.root(consolidated);
  const rootAttrs = (await (await zarr.open.v3(opened, { kind: 'group' })).attrs) as Record<string, unknown>;
  return { store, raw, root: opened, contents, rootAttrs };
}

const toAffine6Identity = [1, 0, 0, 0, 1, 0];

function close(actual: readonly number[], expected: readonly number[], digits = 6): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], digits));
}

describe('transformToAffine', () => {
  it('reads scale and translation by axis name, whatever the axis order', () => {
    close(transformToAffine({ type: 'scale', scale: [1, 2, 3], input: { axes: [{ name: 'c' }, { name: 'y' }, { name: 'x' }] } }, [])!,
      [3, 0, 0, 0, 2, 0, 0, 0, 1]);
    close(transformToAffine({ type: 'translation', translation: [5, 7] }, ['x', 'y'])!, [1, 0, 5, 0, 1, 7, 0, 0, 1]);
  });

  it('composes a sequence in order', () => {
    const t = transformToAffine({
      type: 'sequence',
      transformations: [{ type: 'scale', scale: [2, 2] }, { type: 'translation', translation: [10, 0] }],
    }, ['x', 'y'])!;
    // scale first, then translate: (1, 1) -> (2, 2) -> (12, 2)
    close(boxThrough(t, [1, 1, 1, 1]), [12, 2, 12, 2]);
  });

  it('returns null for a transform no 2-D affine expresses', () => {
    expect(transformToAffine({ type: 'byDimension' }, ['x', 'y'])).toBeNull();
  });
});

describe('reconcileImage', () => {
  const scale = (s: number): Affine3 => [s, 0, 0, 0, s, 0, 0, 0, 1];

  it('places a pixel-space image against micron spots through the element that maps them', () => {
    // Spots span 0..1000 µm; the image is 4700 px wide at 4.7 px/µm, identity to global;
    // a shapes element maps µm -> px.
    const image = new Map([['global', IDENTITY]]);
    const candidates = new Map([['shapes/cells', new Map([['global', scale(4.7)]])]]);
    const m = reconcileImage(image, candidates, [0, 0, 1000, 1000], 4700, 4700);
    close(m, multiply(invert(scale(4.7)), IDENTITY));
  });

  it('keeps the image in its own system when there are no spots to reconcile against', () => {
    const image = new Map([['global', scale(2)]]);
    close(reconcileImage(image, new Map(), null, 10, 10), scale(2));
  });
});

describe('deriveSidecar on a plain store', () => {
  it('names the table and places the pixel-space image against the micron spots', async () => {
    const { root, raw, contents, rootAttrs } = await plainStore();
    const sidecar = await deriveSidecar(root, raw, contents, rootAttrs);
    expect(sidecar.table_keys).toEqual(['table']);
    expect(sidecar.world_key).toEqual({ table: 'spatial' });
    const info = sidecar.images.dapi.table;
    expect(info.channel_names).toEqual(['DAPI']);
    expect([info.width, info.height, info.channels]).toEqual([470, 470, 1]);
    expect(info.is_rgb).toBe(false);
    close(info.pixel_to_world, [1 / PX_PER_UM, 0, 0, 0, 1 / PX_PER_UM, 0]);
    close(info.bounds, [0, 0, 100, 100]);
    // A uint16 image's default upper contrast is the 99.9th percentile, inside its range.
    // numpy.percentile(ramp, 99.9) for this ramp of 0..999.
    close(info.contrast_limits![0], [0, 998]);
    close(info.contrast_range![0], [0, 999]);
  });

  it('opens a store with images and no tables image-only, in the image\'s own space', async () => {
    const { root, raw, contents, rootAttrs } = await plainStore({ withTable: false });
    const sidecar = await deriveSidecar(root, raw, contents, rootAttrs);
    expect(sidecar.table_keys).toEqual([]);
    expect(sidecar.coords_transform).toEqual({});
    // Keyed by "" — the no-table key the app's own writer uses, and the one
    // `getImageInfo` falls back to when the session has no table.
    const info = sidecar.images.dapi[''];
    expect(info.channel_names).toEqual(['DAPI']);
    close(info.pixel_to_world, toAffine6Identity);
    close(info.bounds, [0, 0, 470, 470]);
  });

  it('explains a store with neither a table nor an image', async () => {
    const { root, raw, contents, rootAttrs } = await plainStore({ withTable: false });
    const empty = contents.filter((e) => !e.path.startsWith('/images'));
    await expect(deriveSidecar(root, raw, empty, rootAttrs)).rejects.toThrow(UnrenderableStoreError);
    await expect(deriveSidecar(root, raw, empty, rootAttrs)).rejects.toThrow(/no table and no image/);
  });

  it('still refuses tables without spatial coordinates rather than dropping their cells', async () => {
    const { root, raw, contents, rootAttrs } = await plainStore();
    const unplaced = contents.filter((e) => e.path !== '/tables/table/obsm/spatial');
    await expect(deriveSidecar(root, raw, unplaced, rootAttrs)).rejects.toThrow(/Tables found: table/);
  });

  it('explains a store without consolidated metadata', async () => {
    const { root, raw, rootAttrs } = await plainStore();
    await expect(deriveSidecar(root, raw, [], rootAttrs)).rejects.toThrow(/consolidated metadata/);
  });

  it('indexes polygonal shapes and places each by its own transform', async () => {
    const { root, raw, contents, rootAttrs } = await plainStore();
    const sidecar = await deriveSidecar(root, raw, contents, rootAttrs);
    expect(Object.keys(sidecar.shapes).sort()).toEqual(['cells', 'nuclei']);
    expect(sidecar.shapes.cells).toMatchObject({ geometry_types: ['Polygon'], num_rows: 2, row_groups: 1 });
    close(sidecar.shapes.cells.bounds, [-2, -2, 102, 102]);
    // The table's region shares its cells' space; the pixel-space element is brought
    // back to microns through the spots, as `element_to_world` does.
    close(sidecar.shapes_transform.cells.table, toAffine6Identity);
    close(sidecar.shapes_transform.nuclei.table, [1 / PX_PER_UM, 0, 0, 0, 1 / PX_PER_UM, 0]);
    expect(sidecar.shape_footers.cells.num_rows).toBe(2n);
  });

  it('skips a shapes element whose parquet cannot be read, keeping the rest', async () => {
    const { store, raw, root, contents, rootAttrs } = await plainStore();
    store.delete('/shapes/nuclei/shapes.parquet');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sidecar = await deriveSidecar(root, raw, contents, rootAttrs);
    expect(Object.keys(sidecar.shapes)).toEqual(['cells']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping shapes'), 'nuclei', expect.any(String));
    warn.mockRestore();
  });

  it('reads element transforms keyed by coordinate system', async () => {
    const { root } = await plainStore();
    const attrs = (await (await zarr.open.v3(root.resolve('shapes/cells'), { kind: 'group' })).attrs) as Record<string, unknown>;
    close(elementTransforms(attrs).get('global')!, [PX_PER_UM, 0, 0, 0, PX_PER_UM, 0, 0, 0, 1]);
  });
});

describe('cellIndexOf', () => {
  it('matches by obs name first, then by instance id, else -1', () => {
    expect(Array.from(cellIndexOf(['b', 7, 'z', 'a'], ['a', 'b'], [5, 7]))).toEqual([1, 1, -1, 0]);
  });

  it('never equates a numeric label with its string spelling', () => {
    // `geometry.cell_index` is a dict lookup: 1 and "1" are different keys there too.
    expect(Array.from(cellIndexOf([1], ['0', '1'], null))).toEqual([-1]);
  });

  it('resolves duplicates as the backend does: last obs name, first instance', () => {
    expect(Array.from(cellIndexOf(['a', 3], ['a', 'x', 'a'], [3, 3, 9]))).toEqual([2, 0]);
  });
});

describe('autoDisplays', () => {
  it('makes a spatial display over the first image and an embedding display for UMAP', () => {
    const displays = autoDisplays({
      obsm: [{ name: 'spatial' }, { name: 'X_pca' }, { name: 'X_umap' }],
      images: ['he', 'dapi'],
    }, ['leiden', 'region']);
    expect(displays.map((d) => d.type)).toEqual(['spatial_canvas', 'embedding_canvas']);
    // Re-derived on every open, so ids must not change between opens.
    expect(displays.map((d) => d.id)).toEqual(['auto-spatial', 'auto-embedding']);
    expect(displays[0].encoding).toMatchObject({ coords: 'obsm:spatial', color_by: 'obs:leiden', image_layer: 'he' });
    expect(displays[1].encoding).toMatchObject({ obsm_key: 'X_umap', color_by: 'obs:leiden' });
  });

  it('makes no embedding display when the only obsm is spatial', () => {
    const [spatial, ...rest] = autoDisplays({ obsm: [{ name: 'spatial' }], images: [] }, []);
    expect(rest).toHaveLength(0);
    expect(spatial.encoding).toMatchObject({ color_by: null, image_layer: null });
  });
});

describe('openCheckpoint on a host-signed .zarr folder', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens a plain store through signed per-object URLs and starts on generated displays', async () => {
    const { store } = await plainStore();
    const BASE = 'https://bucket.example/sample.zarr/';
    vi.stubGlobal('fetch', async (url: string) => {
      const bytes = store.get(`/${url.slice('https://signed/'.length)}`);
      return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
    });
    const access = {
      listKeys: async () => [...store.keys()].map((k) => k.slice(1)),
      signKeys: async (keys: readonly string[]) => keys.map((k) => `https://signed/${k}`),
    };
    const handle = await openCheckpoint(BASE, undefined, access);
    expect(handle.fields.obsm).toEqual([{ name: 'spatial', n_components: 2 }]);
    expect(handle.fields.images).toEqual(['dapi']);
    const displays = handle.appState.displays as { type: string; encoding: Record<string, unknown> }[];
    expect(displays.map((d) => d.type)).toEqual(['spatial_canvas']);
    expect(displays[0].encoding).toMatchObject({ coords: 'obsm:spatial', image_layer: 'dapi', color_by: null });
    const info = await handle.source.getImageInfo('dapi');
    close(info.pixel_to_world, [1 / PX_PER_UM, 0, 0, 0, 1 / PX_PER_UM, 0]);
  });

  it('draws a plain store\'s boundaries with their cells\' colors, from both kinds of label', async () => {
    const { store } = await plainStore();
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const bytes = store.get(`/${url.slice('https://signed/'.length)}`);
      if (!bytes) return new Response(null, { status: 404 });
      const range = new Headers(init?.headers).get('Range')?.match(/^bytes=(\d*)-(\d*)$/);
      if (!range) return new Response(new Uint8Array(bytes));
      const [start, end] = range[1] === ''
        ? [Math.max(0, bytes.length - Number(range[2])), bytes.length]
        : [Number(range[1]), Number(range[2]) + 1];
      return new Response(new Uint8Array(bytes.slice(start, end)), { status: 206 });
    });
    const access = {
      listKeys: async () => [...store.keys()].map((k) => k.slice(1)),
      signKeys: async (keys: readonly string[]) => keys.map((k) => `https://signed/${k}`),
    };
    const { source } = await openCheckpoint('https://bucket.example/sample.zarr/', undefined, access);
    const elements = await source.getElements!();
    expect(elements.shapes.map((s) => s.name).sort()).toEqual(['cells', 'nuclei']);

    // The second cell only: `cells` matches it by obs name.
    const cells = await source.getShapesGeoArrow!('cells', [90, 90, 110, 110]);
    expect(Array.from(cells.getChild('cell_index')!.toArray())).toEqual([1]);
    // The first cell's nucleus, matched through `cell_id`, landing in microns: its
    // pixel-space box of +-4.7 is +-1 here, so a window that misses it in pixels hits.
    const nuclei = await source.getShapesGeoArrow!('nuclei', [-1.5, -1.5, 1.5, 1.5]);
    expect(Array.from(nuclei.getChild('cell_index')!.toArray())).toEqual([0]);
    expect((await source.getShapesGeoArrow!('nuclei', [3, 3, 4, 4])).numRows).toBe(0);
  });

  it('opens an image-only plain store with a display over the image and no cells', async () => {
    const { store } = await plainStore({ withTable: false });
    vi.stubGlobal('fetch', async (url: string) => {
      const bytes = store.get(`/${url.slice('https://signed/'.length)}`);
      return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
    });
    const access = {
      listKeys: async () => [...store.keys()].map((k) => k.slice(1)),
      signKeys: async (keys: readonly string[]) => keys.map((k) => `https://signed/${k}`),
    };
    const handle = await openCheckpoint('https://bucket.example/imaging.zarr/', undefined, access);
    expect(handle.fields.images).toEqual(['dapi']);
    expect(handle.fields.obs).toEqual([]);
    const displays = handle.appState.displays as { type: string; encoding: Record<string, unknown> }[];
    expect(displays.map((d) => d.type)).toEqual(['spatial_canvas']);
    expect(displays[0].encoding).toMatchObject({ coords: null, image_layer: 'dapi', color_by: null });
    close((await handle.source.getImageInfo('dapi')).pixel_to_world, toAffine6Identity);
  });

  it('explains a folder that is not a zarr store', async () => {
    const access = { listKeys: async () => ['notes.txt'], signKeys: async () => [] };
    await expect(openCheckpoint('https://bucket.example/x.zarr/', undefined, access))
      .rejects.toThrow(/not a zarr store/);
  });
});
