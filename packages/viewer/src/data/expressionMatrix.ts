// The whole expression matrix, gene-major, for statistics over every gene. It is read in
// a worker (matrixWorker.ts): decoding a few hundred megabytes of chunks — and, for a
// store without the CSC mirror, transposing the matrix — would hold the page still for
// tens of seconds. The store stays on the page (a zip read by range, a signed folder, the
// web app's stack of saved versions), so the worker asks the page for each chunk's bytes.
import type { AbsolutePath, AsyncReadable, RangeQuery } from '@zarrita/storage';
import * as zarr from 'zarrita';
import { afterThisTask } from '../lib/afterThisTask';
import type { ExpressionMatrix } from './types';
import { asTyped, readGroupAttrs, type NumericArray, type NumericArrayType, type Root } from './zarrRead';

export type MatrixArrays = Omit<ExpressionMatrix, 'genes'>;

/** How far a read has got, from 0 to 1. */
export type Progress = (fraction: number) => void;

/** What the page and the worker post to each other: a `Worker`, the worker's own scope,
 * or either end of a `MessageChannel`. */
export interface Port {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

interface ByteRequest { id: number; key: AbsolutePath; range?: RangeQuery }
type ByteReply = { id: number; bytes: Uint8Array | undefined } | { id: number; error: string };

type PageMessage =
  | { kind: 'read'; table: string; nGenes: number }
  | { kind: 'bytes'; replies: ByteReply[] };

type WorkerMessage =
  | { kind: 'get'; requests: ByteRequest[] }
  | { kind: 'progress'; fraction: number }
  | { kind: 'done'; matrix: MatrixArrays }
  | { kind: 'error'; message: string };

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The page's half: answers the worker's byte requests from `store` (requests arrive in
 * batches, so a zip's reads of one array coalesce) and resolves with the matrix. */
export function readMatrixThrough(
  port: Port, store: Required<AsyncReadable>, table: string, genes: string[], onProgress?: Progress,
): Promise<ExpressionMatrix> {
  return new Promise((resolve, reject) => {
    let replies: ByteReply[] = [];
    const reply = (r: ByteReply) => {
      if (replies.push(r) === 1) afterThisTask(() => port.postMessage({ kind: 'bytes', replies: replies.splice(0) }));
    };
    port.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      switch (data.kind) {
        case 'get':
          for (const { id, key, range } of data.requests) {
            (range ? store.getRange(key, range) : store.get(key)).then(
              (bytes) => reply({ id, bytes }),
              (err: unknown) => reply({ id, error: describe(err) }),
            );
          }
          return;
        case 'progress':
          onProgress?.(data.fraction);
          return;
        case 'done':
          resolve({ ...data.matrix, genes });
          return;
        case 'error':
          reject(new Error(data.message));
      }
    };
    const start: PageMessage = { kind: 'read', table, nGenes: genes.length };
    port.postMessage(start);
  });
}

/** The worker's half: reads the matrix through the page's store and posts it back, its
 * arrays transferred. */
export function answerMatrixReads(port: Port): void {
  const waiting = new Map<number, { resolve: (bytes: Uint8Array | undefined) => void; reject: (err: Error) => void }>();
  let requests: ByteRequest[] = [];
  let nextId = 0;
  const ask = (key: AbsolutePath, range?: RangeQuery) => new Promise<Uint8Array | undefined>((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    if (requests.push(range ? { id, key, range } : { id, key }) === 1) {
      afterThisTask(() => port.postMessage({ kind: 'get', requests: requests.splice(0) }));
    }
  });
  const store: Required<AsyncReadable> = { get: (key) => ask(key), getRange: (key, range) => ask(key, range) };
  const post = (message: WorkerMessage, transfer: Transferable[] = []) => port.postMessage(message, transfer);

  port.onmessage = ({ data }: MessageEvent<PageMessage>) => {
    if (data.kind === 'bytes') {
      for (const r of data.replies) {
        const waiter = waiting.get(r.id)!;
        waiting.delete(r.id);
        if ('error' in r) waiter.reject(new Error(r.error));
        else waiter.resolve(r.bytes);
      }
      return;
    }
    // Whole percents: a read of thousands of chunks would otherwise post thousands of messages.
    let reported = 0;
    const progress: Progress = (fraction) => {
      if (fraction - reported < 0.01 && fraction < 1) return;
      reported = fraction;
      post({ kind: 'progress', fraction });
    };
    readExpressionMatrix(zarr.root(store), data.table, data.nGenes, progress).then(
      (matrix) => post({ kind: 'done', matrix }, [matrix.indptr.buffer, matrix.indices.buffer, matrix.data.buffer]),
      (err: unknown) => post({ kind: 'error', message: describe(err) }),
    );
  };
}

export async function readExpressionMatrix(root: Root, table: string, nGenes: number, onProgress: Progress): Promise<MatrixArrays> {
  const mirrorBase = `viewer/tables/${table}/X_csc`;
  const mirrorAttrs = await readGroupAttrs(root, mirrorBase);
  if (mirrorAttrs) return readCsc(root, mirrorBase, (mirrorAttrs.shape as [number, number])[0], onProgress);

  const path = `tables/${table}/X`;
  const node = await zarr.open.v3(root.resolve(path));
  if (node.kind === 'array') {
    const [data] = await readWhole([node], onProgress);
    const [nCells, nCols] = node.shape as [number, number];
    const dense = data as ArrayLike<number>;
    // Row-major dense: walk it as CSR with every row nnz-filtered.
    const rowPtr = new Float64Array(nCells + 1);
    const cols: number[] = [];
    const vals: number[] = [];
    for (let cell = 0; cell < nCells; cell++) {
      for (let g = 0; g < nCols; g++) {
        const v = Number(dense[cell * nCols + g]);
        if (v !== 0) { cols.push(g); vals.push(v); }
      }
      rowPtr[cell + 1] = cols.length;
    }
    return cscFromCsr(nCells, nGenes, rowPtr, Int32Array.from(cols), Float32Array.from(vals));
  }
  const attrs = (await node.attrs) as Record<string, unknown>;
  const [nCells] = attrs.shape as [number, number];
  if (attrs['encoding-type'] === 'csc_matrix') return readCsc(root, path, nCells, onProgress);
  if (attrs['encoding-type'] !== 'csr_matrix') {
    throw new Error(`cannot read "${path}" as a matrix: encoding-type ${JSON.stringify(attrs['encoding-type'] ?? null)}.`);
  }
  const [rowPtr, cols, values] = await readSparse(root, path, onProgress);
  return cscFromCsr(nCells, nGenes, rowPtr, cols, values);
}

async function readCsc(root: Root, base: string, nCells: number, onProgress: Progress): Promise<MatrixArrays> {
  const [indptr, indices, data] = await readSparse(root, base, onProgress);
  return { nCells, indptr, indices, data };
}

// A sparse group's offsets, indices and values, read together.
async function readSparse(root: Root, base: string, onProgress: Progress): Promise<[Float64Array, Int32Array, Float32Array]> {
  const parts: [string, NumericArrayType<NumericArray>][] = [['indptr', Float64Array], ['indices', Int32Array], ['data', Float32Array]];
  const arrays = await Promise.all(parts.map(([name]) => zarr.open.v3(root.resolve(`${base}/${name}`), { kind: 'array' })));
  const data = await readWhole(arrays, onProgress);
  return parts.map(([, ArrayType], i) => asTyped(data[i], ArrayType)) as [Float64Array, Int32Array, Float32Array];
}

// Whole arrays read at once — every chunk requested together, so a zip's reads coalesce
// into a few large GETs — with progress over all their chunks.
async function readWhole(arrays: zarr.Array<zarr.DataType, AsyncReadable>[], onProgress: Progress): Promise<unknown[]> {
  const total = arrays.reduce((n, a) => n + a.shape.reduce((c, length, i) => c * Math.ceil(length / a.chunks[i]), 1), 0);
  let landed = 0;
  const counted: zarr.GetOptions = {
    createQueue: () => {
      const chunks: Promise<void>[] = [];
      return {
        add: (fn) => { chunks.push(fn().then(() => onProgress(++landed / total))); },
        onIdle: () => Promise.all(chunks),
      };
    },
  };
  return Promise.all(arrays.map(async (a) => (await zarr.get(a, null, counted)).data));
}

/** Gene-major copy of a row-major matrix given as per-cell spans (CSR) — a counting
 * sort by gene, so cells stay in order within each gene. */
function cscFromCsr(
  nCells: number, nGenes: number, rowPtr: Float64Array, cols: Int32Array, values: Float32Array,
): MatrixArrays {
  const indptr = new Float64Array(nGenes + 1);
  for (const g of cols) indptr[g + 1] += 1;
  for (let g = 0; g < nGenes; g++) indptr[g + 1] += indptr[g];
  const next = Float64Array.from(indptr.subarray(0, nGenes));
  const indices = new Int32Array(cols.length);
  const data = new Float32Array(cols.length);
  for (let cell = 0; cell < nCells; cell++) {
    for (let k = rowPtr[cell]; k < rowPtr[cell + 1]; k++) {
      const at = next[cols[k]]++;
      indices[at] = cell;
      data[at] = values[k];
    }
  }
  return { nCells, indptr, indices, data };
}
