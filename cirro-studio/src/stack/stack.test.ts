import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ZipFileStore from '@zarrita/storage/zip';
import * as zarr from 'zarrita';
import { describe, expect, it } from 'vitest';
import { openCheckpointStore } from '@cirrobio/spatial-viewer';
import { datasetRef, parseCirroRef } from './cirroRef';
import { StackEditor } from './editor';
import { CACHE_BUDGET_BYTES, CACHE_MAX_OBJECT_BYTES, CachedStore, LayeredStore, MemoryLayer, SavedLayer } from './layeredStore';
import { decodeJson, encodeVlenUtf8 } from './zarrWrite';

// The docs site's committed demo checkpoint: a real SDS-written store (Zarr v3, zipped,
// consolidated, with the viewer sidecar), small enough to read whole in a test.
const DEMO = resolve(__dirname, '../../../docs-site/viewer-data/visium-human-colon.sdata.zarr.zip');

function demoStore() {
  return new CachedStore(ZipFileStore.fromBlob(new Blob([readFileSync(DEMO)])));
}

async function openArray(store: Required<zarr.AsyncReadable>, path: string) {
  const root = zarr.root(await zarr.withMaybeConsolidatedMetadata(store, { format: 'v3' }));
  return zarr.open.v3(root.resolve(path), { kind: 'array' });
}

async function readArray(store: Required<zarr.AsyncReadable>, path: string) {
  return zarr.get(await openArray(store, path)) as Promise<zarr.Chunk<zarr.DataType>>;
}

describe('cirro references', () => {
  it('writes the empty-scope form and reads any scope back', () => {
    const ref = datasetRef('d1', 'overlay/layer.json');
    expect(ref).toBe('cirro:::dataset:d1/overlay/layer.json');
    expect(parseCirroRef(ref)).toEqual({ tenantId: '', projectId: '', datasetId: 'd1', path: 'overlay/layer.json' });
    expect(parseCirroRef('cirro::p1:dataset:d1/a b #2.zarr.zip')?.path).toBe('a b #2.zarr.zip');
    expect(parseCirroRef('cirro:t:p:sheet:s1')).toBeNull();
    expect(parseCirroRef('s3://bucket/key')).toBeNull();
  });
});

describe('vlen-utf8', () => {
  it('lays out a count, then each string as length and bytes', () => {
    const bytes = encodeVlenUtf8(['a', 'µm']);
    expect([...bytes]).toEqual([2, 0, 0, 0, 1, 0, 0, 0, 97, 3, 0, 0, 0, 0xc2, 0xb5, 0x6d]);
  });
});

describe('layered store', () => {
  it('answers from the topmost layer and lets a deletion hide lower objects', async () => {
    const base = new CachedStore({
      get: async (key) => (key === '/a' || key === '/n/x' ? new TextEncoder().encode(`base${key}`) : undefined),
      getRange: async () => undefined,
    });
    const saved = new SavedLayer(['b'], ['n/'], async (key) => new TextEncoder().encode(`saved/${key}`));
    const draft = new MemoryLayer();
    draft.put([['a', new TextEncoder().encode('draft/a')]]);
    const store = new LayeredStore(base, [saved, draft]);
    const text = async (key: `/${string}`) => {
      const b = await store.get(key);
      return b && new TextDecoder().decode(b);
    };
    expect(await text('/a')).toBe('draft/a');
    expect(await text('/b')).toBe('saved/b');
    expect(await text('/n/x')).toBeUndefined();
    expect([...(await store.getRange('/a', { offset: 1, length: 3 }))!]).toEqual([...new TextEncoder().encode('raf')]);
  });
});

describe('cached store', () => {
  it('keeps a load that is still pending when the cache fills up', async () => {
    const object = new Uint8Array(CACHE_MAX_OBJECT_BYTES);
    const reads: string[] = [];
    let finish = () => {};
    const slow = new Promise<void>((resolve) => {
      finish = () => resolve();
    });
    const cache = new CachedStore({
      get: async (key) => {
        reads.push(key);
        if (key === '/slow') await slow;
        return object;
      },
      getRange: async () => undefined,
    });
    const first = cache.get('/slow');
    // More than the budget holds, all loaded while the first is still loading.
    for (let i = 0; i <= CACHE_BUDGET_BYTES / CACHE_MAX_OBJECT_BYTES; i++) await cache.get(`/o${i}`);
    const second = cache.get('/slow');
    finish();
    await Promise.all([first, second]);
    expect(reads.filter((k) => k === '/slow')).toHaveLength(1);
  });
});

describe('stack editor on a real checkpoint', () => {
  it('adds, replaces and deletes obs columns that the viewer and zarrita both read', async () => {
    const draft = new MemoryLayer();
    const store = new LayeredStore(demoStore(), [draft]);
    const editor = new StackEditor(store, draft);
    const n = (await editor.node('tables/table/obs/_index'))!.shape as number[];

    const codes = Int32Array.from({ length: n[0] }, (_, i) => i % 3);
    await editor.setObs('table', 'sds_region', { kind: 'categorical', categories: ['a', 'b', 'c'], codes });
    const score = Float32Array.from({ length: n[0] }, (_, i) => i / 10);
    await editor.setObs('table', 'score', { kind: 'numeric', values: score });

    const read = await readArray(store, 'tables/table/obs/sds_region/codes');
    expect(read.data).toBeInstanceOf(Int8Array);
    expect([...(read.data as Int8Array).slice(0, 4)]).toEqual([0, 1, 2, 0]);
    const cats = await readArray(store, 'tables/table/obs/sds_region/categories');
    expect(Array.from(cats.data as ArrayLike<string>)).toEqual(['a', 'b', 'c']);
    const obs = decodeJson((await store.get('/tables/table/obs/zarr.json'))!);
    expect((obs.attributes as { 'column-order': string[] })['column-order'].slice(-2)).toEqual(['sds_region', 'score']);

    const handle = await openCheckpointStore(store, 'test');
    const field = handle.fields.obs.find((f) => f.name === 'sds_region');
    expect(field?.kind).toBe('categorical');
    const table = await handle.source.getFieldData('obs:sds_region');
    expect(JSON.parse(table.schema.metadata.get('categories')!)).toEqual(['a', 'b', 'c']);

    // Replacing a categorical column with a numeric one leaves none of the old nodes.
    await editor.setObs('table', 'sds_region', { kind: 'numeric', values: score });
    expect(await store.get('/tables/table/obs/sds_region/codes/zarr.json')).toBeUndefined();
    const replaced = await readArray(store, 'tables/table/obs/sds_region');
    expect((replaced.data as Float32Array)[10]).toBeCloseTo(1);

    await editor.deleteObs('table', 'leiden');
    expect(await store.get('/tables/table/obs/leiden/zarr.json')).toBeUndefined();
    const after = await openCheckpointStore(store, 'test-2');
    expect(after.fields.obs.map((f) => f.name)).not.toContain('leiden');
    expect(draft.deleted.has('tables/table/obs/leiden/')).toBe(true);
  });

  it('writes uns strings and dataframes, creating the dicts on the way', async () => {
    const draft = new MemoryLayer();
    const store = new LayeredStore(demoStore(), [draft]);
    const editor = new StackEditor(store, draft);
    await editor.setUns('table', ['spatial_data_studio', 'figures', 'f1'], { kind: 'string', value: '{"title":"x"}' });
    await editor.setUns('table', ['spatial_data_studio', 'results', 'r1'], {
      kind: 'dataframe', index: ['g1', 'g2'], columns: { score: Float64Array.of(1.5, -2), label: ['up', 'down'] },
    });
    const figure = await openArray(store, 'tables/table/uns/spatial_data_studio/figures/f1');
    expect(figure.shape).toEqual([]);
    // zarrita answers a 0-d array with its one value.
    expect(await zarr.get(figure)).toBe('{"title":"x"}');
    const score = await readArray(store, 'tables/table/uns/spatial_data_studio/results/r1/score');
    expect([...(score.data as Float64Array)]).toEqual([1.5, -2]);
    const root = decodeJson<{ consolidated_metadata: { metadata: Record<string, unknown> } }>((await store.get('/zarr.json'))!);
    expect(Object.keys(root.consolidated_metadata.metadata)).toEqual(expect.arrayContaining([
      'tables/table/uns/spatial_data_studio', 'tables/table/uns/spatial_data_studio/figures',
      'tables/table/uns/spatial_data_studio/results/r1/_index',
    ]));
  });

  it('refuses a column whose length is not the number of cells', async () => {
    const draft = new MemoryLayer();
    const editor = new StackEditor(new LayeredStore(demoStore(), [draft]), draft);
    await expect(editor.setObs('table', 'x', { kind: 'numeric', values: new Float32Array(3) })).rejects.toThrow(/has 3 values/);
    expect(draft.isEmpty).toBe(true);
  });

  it('refuses a name that a reader would take for a path', async () => {
    const draft = new MemoryLayer();
    const editor = new StackEditor(new LayeredStore(demoStore(), [draft]), draft);
    for (const name of ['', '.', '..', 'a/b', 'a\\b']) {
      await expect(editor.setObs('table', name, { kind: 'numeric', values: new Float32Array(3) })).rejects.toThrow(/can't be used as a name/);
    }
    // A neighborhood result names its columns by the groups compared.
    await expect(editor.setUns('table', ['spatial_data_studio', 'results', 'r1', 'table'], {
      kind: 'dataframe', index: ['g1'], columns: { 'in\\out': Float64Array.of(1) },
    })).rejects.toThrow(/can't be used as a name/);
    expect(draft.isEmpty).toBe(true);
  });
});
