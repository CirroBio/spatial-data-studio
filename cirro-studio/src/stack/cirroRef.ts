// Cirro references: `cirro:<tenantId>:<projectId>:dataset:<datasetId>/<path>`, the URI
// grammar Cirro's sheets and portal use (Cirro-portal `data/models/sheets/cirro-reference.ts`).
// The path is relative to the dataset's `data/` directory and is never percent-encoded.
//
// Versions point at their parents with the empty-scope form, `cirro:::dataset:<id>/<path>`:
// no tenant, no project. Cirro resolves such a reference through the project it is read
// from, and a dataset shared into a project keeps its ID there, so a stack of versions
// still resolves after any of its datasets reaches another project through a share.

export interface CirroRef {
  tenantId: string;
  projectId: string;
  datasetId: string;
  // Relative to the dataset's data directory; '' for the directory itself.
  path: string;
}

const SCHEME = 'cirro:';
const DATASET_TYPE = 'dataset';

export function parseCirroRef(value: string): CirroRef | null {
  if (!value.startsWith(SCHEME)) return null;
  const rest = value.slice(SCHEME.length);
  const slash = rest.indexOf('/');
  const head = slash === -1 ? rest : rest.slice(0, slash);
  const parts = head.split(':');
  if (parts.length !== 4) return null;
  const [tenantId, projectId, type, datasetId] = parts;
  if (type !== DATASET_TYPE || !datasetId) return null;
  return { tenantId, projectId, datasetId, path: slash === -1 ? '' : rest.slice(slash + 1) };
}

/** The empty-scope reference this app writes: resolvable from any project the dataset is in. */
export function datasetRef(datasetId: string, path: string): string {
  return `${SCHEME}::${DATASET_TYPE}:${datasetId}/${path}`;
}

export function requireCirroRef(value: string): CirroRef {
  const ref = parseCirroRef(value);
  if (!ref) throw new Error(`"${value}" is not a Cirro dataset reference (cirro:<tenant>:<project>:dataset:<id>/<path>).`);
  return ref;
}
