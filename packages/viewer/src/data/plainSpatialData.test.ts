// Deriving the viewer sidecar for a plain SpatialData store. The fixture copies the
// geometry of a spatialdata-io Xenium store: the spots are in microns, the image in
// pixels (identity to `global`), and only a shapes element's transform says how the two
// relate — the case the image reconciliation exists for.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as zarr from 'zarrita';
import {
  IDENTITY, autoDisplays, boxThrough, deriveSidecar, elementTransforms, invert, multiply,
  reconcileImage, transformToAffine, UnrenderableStoreError, type Affine3, type Contents,
} from './plainSpatialData';
import { openCheckpoint } from './checkpointSource';

const PX_PER_UM = 4.7;
const xy = (name: string) => ({ name, axes: [{ name: 'x' }, { name: 'y' }] });

/** A minimal consolidated Zarr v3 SpatialData store, in memory. */
async function plainStore() {
  const store = new Map<string, Uint8Array>();
  const root = zarr.root(store);
  await zarr.create(root, { attributes: { spatialdata_attrs: { version: '0.2' } } });
  for (const g of ['tables', 'tables/table', 'tables/table/obsm', 'images', 'shapes']) {
    await zarr.create(root.resolve(g));
  }
  await zarr.create(root.resolve('tables/table/obs'), { attributes: { 'column-order': [], _index: '_index' } });
  const spots = await zarr.create(root.resolve('tables/table/obsm/spatial'), { shape: [2, 2], chunkShape: [2, 2], dtype: 'float64' });
  await zarr.set(spots, null, { data: new Float64Array([0, 0, 100, 100]), shape: [2, 2], stride: [2, 1] });
  await zarr.create(root.resolve('shapes/cells'), {
    attributes: { axes: ['x', 'y'], coordinateTransformations: [{ type: 'scale', scale: [PX_PER_UM, PX_PER_UM], input: xy('xy'), output: xy('global') }] },
  });
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

  const readable = { get: async (key: `/${string}`) => store.get(key) };
  const consolidated = await zarr.withMaybeConsolidatedMetadata(readable, { format: 'v3' });
  const contents = ('contents' in consolidated ? consolidated.contents() : []) as Contents;
  const opened = zarr.root(consolidated);
  const rootAttrs = (await (await zarr.open.v3(opened, { kind: 'group' })).attrs) as Record<string, unknown>;
  return { store, root: opened, contents, rootAttrs };
}

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
    const { root, contents, rootAttrs } = await plainStore();
    const sidecar = await deriveSidecar(root, contents, rootAttrs);
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

  it('explains a store with no table instead of opening an empty session', async () => {
    const { root, contents, rootAttrs } = await plainStore();
    const imagesOnly = contents.filter((e) => !e.path.startsWith('/tables'));
    await expect(deriveSidecar(root, imagesOnly, rootAttrs)).rejects.toThrow(UnrenderableStoreError);
    await expect(deriveSidecar(root, imagesOnly, rootAttrs)).rejects.toThrow(/no table/);
  });

  it('explains a store without consolidated metadata', async () => {
    const { root, rootAttrs } = await plainStore();
    await expect(deriveSidecar(root, [], rootAttrs)).rejects.toThrow(/consolidated metadata/);
  });

  it('reads element transforms keyed by coordinate system', async () => {
    const { root } = await plainStore();
    const attrs = (await (await zarr.open.v3(root.resolve('shapes/cells'), { kind: 'group' })).attrs) as Record<string, unknown>;
    close(elementTransforms(attrs).get('global')!, [PX_PER_UM, 0, 0, 0, PX_PER_UM, 0, 0, 0, 1]);
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

  it('explains a folder that is not a zarr store', async () => {
    const access = { listKeys: async () => ['notes.txt'], signKeys: async () => [] };
    await expect(openCheckpoint('https://bucket.example/x.zarr/', undefined, access))
      .rejects.toThrow(/not a zarr store/);
  });
});
