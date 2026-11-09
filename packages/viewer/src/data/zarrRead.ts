// Reads shared by the page's reader (checkpointSource.ts) and the expression-matrix
// worker (expressionMatrix.ts), which must not load the rest of the reader.
import type { AsyncReadable } from '@zarrita/storage';
import * as zarr from 'zarrita';

export type Root = zarr.Location<AsyncReadable>;

// null means the group is genuinely not in the store — the callers read that as
// "this checkpoint predates the feature". Anything else (a 403 on an expired URL, a
// dropped connection, corrupt metadata) propagates: swallowing it would turn a
// transient failure into a confident wrong diagnosis about a healthy file.
export async function readGroupAttrs(root: Root, path: string): Promise<Record<string, unknown> | null> {
  try {
    const group = await zarr.open.v3(root.resolve(path), { kind: 'group' });
    return (await group.attrs) as Record<string, unknown>;
  } catch (err) {
    if (zarr.isZarritaError(err, 'NotFoundError')) return null;
    throw err;
  }
}

export type NumericArray = Float64Array | Float32Array | Int32Array;

export interface NumericArrayType<T extends NumericArray> {
  new (length: number): T;
  from(values: ArrayLike<number>, map: (v: number) => number): T;
}

/** Numbers as an `ArrayType`, uniform regardless of the on-disk dtype. */
export function asTyped<T extends NumericArray>(data: unknown, ArrayType: NumericArrayType<T>): T {
  return data instanceof ArrayType ? data : ArrayType.from(data as ArrayLike<number>, Number);
}

// zarrita requests every chunk of a whole-array read at once. A zip's reads coalesce
// into a few large GETs (RangeGetReader); a folder store caps its own request count
// (`openZarrStore`).
export async function readTyped<T extends NumericArray>(root: Root, path: string, ArrayType: NumericArrayType<T>): Promise<T> {
  const arr = await zarr.open.v3(root.resolve(path), { kind: 'array' });
  return asTyped((await zarr.get(arr, null)).data, ArrayType);
}
