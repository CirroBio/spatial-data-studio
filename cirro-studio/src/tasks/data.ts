// What tasks read from an opened dataset, through the same reader the canvases use.
import { arrowToColorSource, type CheckpointHandle, type ExpressionMatrix } from '@cirrobio/spatial-viewer';
import { baseOf } from '../workbench/workbench';

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

// No version writes a table's X or the viewer's mirror of it (edits are to obs, obsm and
// uns), so the matrix is the same for every version on a store: it is read once per base
// store, by whichever version asks first, and everyone waiting on that read hears how far
// it has got.
const matrices = new Map<string, { matrix: Promise<ExpressionMatrix>; listeners: Set<(fraction: number) => void> }>();

/** The expression matrix of the opened dataset `key` (its workbench key), read through
 * `handle` unless a version on the same store has read it already. */
export function readMatrix(key: string, handle: CheckpointHandle, onProgress?: (fraction: number) => void): Promise<ExpressionMatrix> {
  const base = baseOf(key);
  let read = matrices.get(base);
  if (!read) {
    if (!handle.source.getExpressionMatrix) return Promise.reject(new Error('This store\'s reader can\'t give the expression matrix.'));
    const listeners = new Set<(fraction: number) => void>();
    const matrix = handle.source.getExpressionMatrix((fraction) => listeners.forEach((l) => l(fraction)));
    read = { matrix, listeners };
    matrices.set(base, read);
    matrix.catch(() => matrices.delete(base));
  }
  if (onProgress) {
    const { listeners } = read;
    listeners.add(onProgress);
    const stop = () => listeners.delete(onProgress);
    read.matrix.then(stop, stop);
  }
  return read.matrix;
}

/** A column name not taken yet: `base`, else `base_2`, `base_3`… */
export function freeName(base: string, taken: string[]): string {
  const clean = base.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'column';
  if (!taken.includes(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.includes(`${clean}_${i}`)) return `${clean}_${i}`;
}
