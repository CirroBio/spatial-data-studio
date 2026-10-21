// What tasks read from an opened dataset, through the same reader the canvases use.
import { arrowToColorSource, type CheckpointHandle, type ExpressionMatrix } from '@cirrobio/spatial-viewer';

export type ObsValues =
  | { kind: 'categorical'; codes: Int32Array; categories: string[] }
  | { kind: 'numeric'; values: Float32Array };

export async function readObs(handle: CheckpointHandle, column: string): Promise<ObsValues> {
  const source = arrowToColorSource(await handle.source.getFieldData(`obs:${column}`));
  if (!source) throw new Error(`Couldn't read “${column}”.`);
  return source.kind === 'categorical'
    ? { kind: 'categorical', codes: source.codes, categories: source.categories }
    : { kind: 'numeric', values: source.values };
}

/** A column that sorts the cells into groups; a column of values can't. */
export async function readGroups(handle: CheckpointHandle, column: string): Promise<Extract<ObsValues, { kind: 'categorical' }>> {
  const obs = await readObs(handle, column);
  if (obs.kind !== 'categorical') throw new Error(`“${column}” holds values, not groups.`);
  return obs;
}

/** Cell positions as interleaved x, y, in the coordinates the tissue canvas draws. */
export async function readCoords(handle: CheckpointHandle, field: string): Promise<Float32Array> {
  const table = await handle.source.getFieldData(field);
  const x = table.getChild('d0');
  const y = table.getChild('d1');
  if (!x || !y) throw new Error(`“${field}” has no x and y.`);
  const n = table.numRows;
  const xy = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    xy[2 * i] = Number(x.get(i));
    xy[2 * i + 1] = Number(y.get(i));
  }
  return xy;
}

// The matrix is the same for every version of a dataset this app writes (it never edits
// X), so it is read once per opened dataset.
const matrices = new Map<string, Promise<ExpressionMatrix>>();

export function readMatrix(key: string, handle: CheckpointHandle): Promise<ExpressionMatrix> {
  let pending = matrices.get(key);
  if (!pending) {
    if (!handle.source.getExpressionMatrix) return Promise.reject(new Error('This store\'s reader can\'t give the expression matrix.'));
    pending = handle.source.getExpressionMatrix();
    matrices.set(key, pending);
    pending.catch(() => matrices.delete(key));
  }
  return pending;
}

/** A column name not taken yet: `base`, else `base_2`, `base_3`… */
export function freeName(base: string, taken: string[]): string {
  const clean = base.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'column';
  if (!taken.includes(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.includes(`${clean}_${i}`)) return `${clean}_${i}`;
}
