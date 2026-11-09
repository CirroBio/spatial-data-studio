// The whole-matrix read, from each layout a store may hold X in, and through the
// page/worker split it runs under.
import type { AbsolutePath, RangeQuery } from '@zarrita/storage';
import { describe, expect, it } from 'vitest';
import * as zarr from 'zarrita';
import { answerMatrixReads, readExpressionMatrix, readMatrixThrough } from './expressionMatrix';

// 4 cells x 3 genes:  [1 0 2]
//                     [0 3 0]
//                     [0 0 0]
//                     [4 5 6]
const DENSE = [1, 0, 2, 0, 3, 0, 0, 0, 0, 4, 5, 6];
const CSR = { indptr: [0, 2, 3, 3, 6], indices: [0, 2, 1, 0, 1, 2], data: [1, 2, 3, 4, 5, 6] };
const CSC = { indptr: [0, 2, 4, 6], indices: [0, 3, 1, 3, 0, 3], data: [1, 4, 3, 5, 2, 6] };
const GENES = ['a', 'b', 'c'];
// Small enough that each array spans several chunks.
const CHUNK = 2;

type Layout = 'mirror' | 'csr' | 'csc' | 'dense';

async function sparseGroup(root: zarr.Location<Map<string, Uint8Array>>, path: string, attrs: object, m: typeof CSR) {
  await zarr.create(root.resolve(path), { attributes: { shape: [4, 3], ...attrs } });
  for (const [name, values, dtype] of [['indptr', m.indptr, 'int32'], ['indices', m.indices, 'int32'], ['data', m.data, 'float32']] as const) {
    const arr = await zarr.create(root.resolve(`${path}/${name}`), { shape: [values.length], chunkShape: [CHUNK], dtype });
    const data = dtype === 'int32' ? Int32Array.from(values) : Float32Array.from(values);
    await zarr.set(arr, null, { data, shape: [values.length], stride: [1] });
  }
}

/** A table whose X is held as `layout` — `mirror` adds the viewer's CSC copy to a CSR X. */
async function storeWith(layout: Layout): Promise<Map<string, Uint8Array>> {
  const store = new Map<string, Uint8Array>();
  const root = zarr.root(store);
  if (layout === 'dense') {
    const x = await zarr.create(root.resolve('tables/table/X'), { shape: [4, 3], chunkShape: [CHUNK, CHUNK], dtype: 'float32' });
    await zarr.set(x, null, { data: Float32Array.from(DENSE), shape: [4, 3], stride: [3, 1] });
  } else if (layout === 'csc') {
    await sparseGroup(root, 'tables/table/X', { 'encoding-type': 'csc_matrix' }, CSC);
  } else {
    await sparseGroup(root, 'tables/table/X', { 'encoding-type': 'csr_matrix' }, CSR);
  }
  if (layout === 'mirror') await sparseGroup(root, 'viewer/tables/table/X_csc', {}, CSC);
  return store;
}

const plain = (m: { indptr: Float64Array; indices: Int32Array; data: Float32Array }) => ({
  indptr: [...m.indptr], indices: [...m.indices], data: [...m.data],
});

const last = (values: number[]) => values[values.length - 1];

/** The page's side of a store over `map`, which zarrita's Map store isn't (no getRange). */
const pageStore = (map: Map<string, Uint8Array>) => ({
  get: async (key: AbsolutePath) => map.get(key),
  getRange: async (key: AbsolutePath, range: RangeQuery) => {
    const bytes = map.get(key);
    return 'suffixLength' in range ? bytes?.slice(-range.suffixLength) : bytes?.slice(range.offset, range.offset + range.length);
  },
});

describe('readExpressionMatrix', () => {
  it.each(['mirror', 'csr', 'csc', 'dense'] as const)('reads %s X as the same gene-major matrix', async (layout) => {
    const fractions: number[] = [];
    const m = await readExpressionMatrix(zarr.root(pageStore(await storeWith(layout))), 'table', GENES.length, (f) => fractions.push(f));
    expect(m.nCells).toBe(4);
    expect(plain(m)).toEqual(CSC);
    expect(last(fractions)).toBe(1);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
  });
});

describe('readMatrixThrough', () => {
  it('reads through the page in one batch per array set, and reports progress', async () => {
    const { port1: page, port2: worker } = new MessageChannel();
    answerMatrixReads(worker);
    const fractions: number[] = [];
    const read = readMatrixThrough(page, pageStore(await storeWith('mirror')), 'table', GENES, (f) => fractions.push(f));
    const batches: number[] = [];
    page.addEventListener('message', ({ data }) => {
      if (data.kind === 'get') batches.push(data.requests.length);
    });
    const m = await read;
    page.close();
    expect(m.genes).toEqual(GENES);
    expect(plain(m)).toEqual(CSC);
    expect(last(fractions)).toBe(1);
    // Every chunk of the mirror's three arrays (3 + 3 + 2) in a single request batch.
    expect(Math.max(...batches)).toBe(8);
  });

  it('fails with the page store\'s error', async () => {
    const { port1: page, port2: worker } = new MessageChannel();
    answerMatrixReads(worker);
    const store = pageStore(await storeWith('csr'));
    const failing = {
      ...store,
      get: async (key: AbsolutePath) => {
        if (key.includes('/c/')) throw new Error('range GET failed: 403 Forbidden');
        return store.get(key);
      },
    };
    await expect(readMatrixThrough(page, failing, 'table', GENES)).rejects.toThrow('403 Forbidden');
    page.close();
  });
});
