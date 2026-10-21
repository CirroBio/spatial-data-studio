// Just enough of a Zarr v3 writer to add AnnData elements to a store from the browser:
// single-chunk arrays (the whole array is one object), the `bytes` and `vlen-utf8`
// codecs, and gzip on top. That is what zarr-python and zarrita both read, and it keeps a
// saved version to a handful of objects per column.
//
// Documents mirror what zarr-python 3 writes (see a store's `zarr.json`), including the
// empty `consolidated_metadata` stub it gives every group entry in the root's index.

export type NumericDType = 'int8' | 'int16' | 'int32' | 'uint8' | 'uint32' | 'float32' | 'float64';
export type NumericArray = Int8Array | Int16Array | Int32Array | Uint8Array | Uint32Array | Float32Array | Float64Array;

export type NodeDoc = Record<string, unknown> & { node_type: 'array' | 'group'; zarr_format: 3 };

/** Object key (relative to the store root, no leading slash) -> bytes. */
export type Objects = Map<string, Uint8Array>;

const GZIP = { name: 'gzip', configuration: { level: 5 } };

export function groupDoc(attributes: Record<string, unknown>): NodeDoc {
  return { attributes, zarr_format: 3, node_type: 'group' };
}

/** A group as its entry in the root's consolidated index. */
export function consolidatedGroupEntry(attributes: Record<string, unknown>): NodeDoc {
  return {
    attributes, zarr_format: 3,
    consolidated_metadata: { kind: 'inline', must_understand: false, metadata: {} },
    node_type: 'group',
  };
}

function dtypeOf(data: NumericArray): NumericDType {
  if (data instanceof Int8Array) return 'int8';
  if (data instanceof Int16Array) return 'int16';
  if (data instanceof Int32Array) return 'int32';
  if (data instanceof Uint8Array) return 'uint8';
  if (data instanceof Uint32Array) return 'uint32';
  if (data instanceof Float32Array) return 'float32';
  return 'float64';
}

function arrayDoc(
  shape: number[], dataType: string, fillValue: number | string, codecs: object[],
  attributes: Record<string, unknown>,
): NodeDoc {
  return {
    shape,
    data_type: dataType,
    chunk_grid: { name: 'regular', configuration: { chunk_shape: shape } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: fillValue,
    codecs,
    attributes,
    zarr_format: 3,
    node_type: 'array',
    storage_transformers: [],
  };
}

// The one chunk of a single-chunk array: `c/0/0…` with one index per dimension, `c` for
// a 0-d array.
const chunkKey = (shape: number[]) => ['c', ...shape.map(() => '0')].join('/');

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface WrittenArray {
  doc: NodeDoc;
  objects: Objects;
}

/** A numeric array of `shape` (row-major), written as one gzip-compressed chunk. */
export async function numericArray(
  path: string, data: NumericArray, shape: number[], attributes: Record<string, unknown>,
): Promise<WrittenArray> {
  const n = shape.reduce((a, b) => a * b, 1);
  if (data.length !== n) throw new Error(`${path}: ${data.length} values for shape [${shape}]`);
  const dataType = dtypeOf(data);
  // Single-byte types carry no byte order; zarr-python leaves the configuration off.
  const bytesCodec = data.BYTES_PER_ELEMENT === 1 ? { name: 'bytes' } : { name: 'bytes', configuration: { endian: 'little' } };
  const doc = arrayDoc(shape, dataType, 0, [bytesCodec, GZIP], attributes);
  // Typed arrays are little-endian on every platform a browser runs on.
  const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return {
    doc,
    objects: new Map([
      [`${path}/zarr.json`, encodeJson(doc)],
      [`${path}/${chunkKey(shape)}`, await gzip(raw)],
    ]),
  };
}

/** numcodecs' VLenUTF8 layout: item count, then each item as length + UTF-8 bytes. */
export function encodeVlenUtf8(values: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts = values.map((v) => encoder.encode(v));
  const out = new Uint8Array(4 + parts.reduce((s, p) => s + 4 + p.length, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, values.length, true);
  let at = 4;
  for (const p of parts) {
    view.setUint32(at, p.length, true);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}

/** A string array; `shape` is `[n]`, or `[]` for one string (AnnData's scalar). */
export async function stringArray(
  path: string, values: readonly string[], shape: number[], attributes: Record<string, unknown>,
): Promise<WrittenArray> {
  const n = shape.reduce((a, b) => a * b, 1);
  if (values.length !== n) throw new Error(`${path}: ${values.length} strings for shape [${shape}]`);
  const doc = arrayDoc(shape, 'string', '', [{ name: 'vlen-utf8', configuration: {} }, GZIP], attributes);
  return {
    doc,
    objects: new Map([
      [`${path}/zarr.json`, encodeJson(doc)],
      [`${path}/${chunkKey(shape)}`, await gzip(encodeVlenUtf8(values))],
    ]),
  };
}

export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2));
}

export function decodeJson<T = Record<string, unknown>>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
