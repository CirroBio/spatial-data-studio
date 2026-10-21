// Edits to a stack's AnnData tables, written into the draft layer as the objects a saved
// version will hold. Each edit keeps the two indexes readers use in step with the
// objects: the parent group's own metadata (an `obs` dataframe's `column-order`) and the
// root `zarr.json`'s consolidated index, which zarrita and zarr-python read instead of
// walking the store. Readers that open the stack see the edit exactly as Python will.
import type { AbsolutePath, AsyncReadable } from '@zarrita/storage';
import type { MemoryLayer } from './layeredStore';
import type { Change } from './manifest';
import {
  consolidatedGroupEntry, decodeJson, encodeJson, groupDoc, numericArray, stringArray,
  type NodeDoc, type NumericArray, type Objects, type WrittenArray,
} from './zarrWrite';

const ARRAY_ATTRS = { 'encoding-type': 'array', 'encoding-version': '0.2.0' };
const STRING_ARRAY_ATTRS = { 'encoding-type': 'string-array', 'encoding-version': '0.2.0' };
const DICT_ATTRS = { 'encoding-type': 'dict', 'encoding-version': '0.1.0' };

export type ObsColumn =
  | { kind: 'categorical'; categories: string[]; codes: Int32Array }
  | { kind: 'numeric'; values: Float32Array | Float64Array };

export type DataFrameColumn = NumericArray | string[];

export type UnsValue =
  | { kind: 'string'; value: string }
  | { kind: 'dataframe'; index: string[]; columns: Record<string, DataFrameColumn> };

interface RootDoc extends NodeDoc {
  consolidated_metadata: { kind: string; must_understand: boolean; metadata: Record<string, NodeDoc> };
}

// zarr-python rebuilds the tree from the flat index with `itertools.groupby` over keys
// sorted by depth, which only gathers a group's children when they sit next to each
// other; an entry appended at the end splits them and the read fails. Within one depth,
// keys sharing a parent share a prefix, so a plain sort keeps them together.
function sortedIndex(index: Record<string, NodeDoc>): Record<string, NodeDoc> {
  const depth = (k: string) => k.split('/').length;
  const keys = Object.keys(index).sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(keys.map((k) => [k, index[k]]));
}

function encodeRoot(root: RootDoc): Uint8Array {
  return encodeJson({ ...root, consolidated_metadata: { ...root.consolidated_metadata, metadata: sortedIndex(root.consolidated_metadata.metadata) } });
}

/** The smallest integer type that holds every code, as pandas stores categorical codes. */
function narrowCodes(codes: Int32Array, nCategories: number): Int8Array | Int16Array | Int32Array {
  if (nCategories < 127) return Int8Array.from(codes);
  if (nCategories < 32767) return Int16Array.from(codes);
  return codes;
}

// A key segment must not introduce a path of its own; AnnData names are free text, but a
// `/` would make a group of it, and sds_layers.py refuses a `\`, which Windows reads as one.
function checkName(name: string): string {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`"${name}" can't be used as a name in the store.`);
  }
  return name;
}

export class StackEditor {
  // Edits read and rewrite the same root document, so they run one at a time.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: Required<AsyncReadable>, private readonly draft: MemoryLayer) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async root(): Promise<RootDoc> {
    const bytes = await this.store.get('/zarr.json');
    if (!bytes) throw new Error('This store has no zarr.json at its root.');
    const doc = decodeJson<RootDoc>(bytes);
    if (!doc.consolidated_metadata?.metadata) {
      throw new Error('This store has no consolidated metadata, so edits to it could not be indexed.');
    }
    return doc;
  }

  /** The node's metadata as the stack currently answers it, or null when absent. */
  async node(path: string): Promise<NodeDoc | null> {
    const bytes = await this.store.get(`/${path}/zarr.json` as AbsolutePath);
    return bytes ? decodeJson<NodeDoc>(bytes) : null;
  }

  private async nObs(table: string): Promise<number> {
    const obs = await this.node(`tables/${table}/obs`);
    if (!obs) throw new Error(`The store has no table "${table}".`);
    const indexName = (obs.attributes as Record<string, unknown>)?._index ?? '_index';
    const index = await this.node(`tables/${table}/obs/${indexName}`);
    const shape = (index?.shape ?? (index && (await this.node(`tables/${table}/obs/${indexName}/values`))?.shape)) as number[] | undefined;
    if (!shape) throw new Error(`Couldn't tell how many cells table "${table}" has.`);
    return shape[0];
  }

  // Replace the node at `path` (if any) with `entries`, update the parent group, and
  // rewrite the root index. `entries` maps each new node path to its document; `objects`
  // are every object to write.
  private async replaceNode(
    path: string, entries: Map<string, NodeDoc>, objects: Objects, parent?: { path: string; attributes: Record<string, unknown> },
  ): Promise<void> {
    const root = await this.root();
    const index = root.consolidated_metadata.metadata;
    const existed = path in index;
    for (const key of Object.keys(index)) if (key === path || key.startsWith(`${path}/`)) delete index[key];
    if (existed || this.draft.objects.has(`${path}/zarr.json`)) this.draft.deleteNode(path);
    for (const [p, doc] of entries) index[p] = doc.node_type === 'group' ? consolidatedGroupEntry(doc.attributes as Record<string, unknown>) : doc;
    this.draft.put(objects);
    if (parent) {
      const doc = groupDoc(parent.attributes);
      index[parent.path] = consolidatedGroupEntry(parent.attributes);
      this.draft.put([[`${parent.path}/zarr.json`, encodeJson(doc)]]);
    }
    this.draft.put([['zarr.json', encodeRoot(root)]]);
  }

  private async deleteFromIndex(path: string, parent?: { path: string; attributes: Record<string, unknown> }): Promise<void> {
    const root = await this.root();
    const index = root.consolidated_metadata.metadata;
    if (!(path in index)) throw new Error(`The store has nothing at ${path}.`);
    for (const key of Object.keys(index)) if (key === path || key.startsWith(`${path}/`)) delete index[key];
    this.draft.deleteNode(path);
    if (parent) {
      index[parent.path] = consolidatedGroupEntry(parent.attributes);
      this.draft.put([[`${parent.path}/zarr.json`, encodeJson(groupDoc(parent.attributes))]]);
    }
    this.draft.put([['zarr.json', encodeRoot(root)]]);
  }

  private async obsGroup(table: string): Promise<Record<string, unknown>> {
    const obs = await this.node(`tables/${table}/obs`);
    if (!obs) throw new Error(`The store has no table "${table}".`);
    return { ...(obs.attributes as Record<string, unknown>) };
  }

  /** Add an `obs` column, or replace the one of that name. */
  setObs(table: string, name: string, column: ObsColumn): Promise<Change> {
    return this.serial(async () => {
      checkName(name);
      const n = await this.nObs(table);
      const length = column.kind === 'categorical' ? column.codes.length : column.values.length;
      if (length !== n) throw new Error(`Column "${name}" has ${length} values; table "${table}" has ${n} cells.`);
      const path = `tables/${table}/obs/${name}`;
      const entries = new Map<string, NodeDoc>();
      const objects: Objects = new Map();
      const add = (p: string, w: WrittenArray) => {
        entries.set(p, w.doc);
        for (const [k, v] of w.objects) objects.set(k, v);
      };
      if (column.kind === 'categorical') {
        const attrs = { ordered: false, 'encoding-type': 'categorical', 'encoding-version': '0.2.0' };
        entries.set(path, groupDoc(attrs));
        objects.set(`${path}/zarr.json`, encodeJson(groupDoc(attrs)));
        add(`${path}/codes`, await numericArray(`${path}/codes`, narrowCodes(column.codes, column.categories.length), [n], ARRAY_ATTRS));
        add(`${path}/categories`, await stringArray(`${path}/categories`, column.categories, [column.categories.length], STRING_ARRAY_ATTRS));
      } else {
        add(path, await numericArray(path, column.values, [n], ARRAY_ATTRS));
      }
      const obs = await this.obsGroup(table);
      const order = (obs['column-order'] as string[] | undefined) ?? [];
      obs['column-order'] = order.includes(name) ? order : [...order, name];
      await this.replaceNode(path, entries, objects, { path: `tables/${table}/obs`, attributes: obs });
      return { op: 'set-obs', table, column: name, kind: column.kind };
    });
  }

  deleteObs(table: string, name: string): Promise<Change> {
    return this.serial(async () => {
      const obs = await this.obsGroup(table);
      obs['column-order'] = ((obs['column-order'] as string[] | undefined) ?? []).filter((c) => c !== name);
      await this.deleteFromIndex(`tables/${table}/obs/${name}`, { path: `tables/${table}/obs`, attributes: obs });
      return { op: 'delete-obs', table, column: name };
    });
  }

  /** Add an `obsm` entry (cells × `columns`, row-major), or replace the one of that name. */
  setObsm(table: string, key: string, values: Float32Array, columns: number): Promise<Change> {
    return this.serial(async () => {
      checkName(key);
      const n = await this.nObs(table);
      const path = `tables/${table}/obsm/${key}`;
      const written = await numericArray(path, values, [n, columns], ARRAY_ATTRS);
      if (!(await this.node(`tables/${table}/obsm`))) throw new Error(`Table "${table}" has no obsm group.`);
      await this.replaceNode(path, new Map([[path, written.doc]]), written.objects);
      return { op: 'set-obsm', table, key };
    });
  }

  /** Write a value at `uns/<path…>`, creating dict groups along the way. */
  setUns(table: string, path: string[], value: UnsValue): Promise<Change> {
    return this.serial(async () => {
      path.forEach(checkName);
      const entries = new Map<string, NodeDoc>();
      const objects: Objects = new Map();
      // Parent dicts that don't exist yet are part of the edit.
      let parentPath = `tables/${table}/uns`;
      if (!(await this.node(parentPath))) throw new Error(`Table "${table}" has no uns group.`);
      for (const segment of path.slice(0, -1)) {
        parentPath = `${parentPath}/${segment}`;
        if (!(await this.node(parentPath))) {
          entries.set(parentPath, groupDoc(DICT_ATTRS));
          objects.set(`${parentPath}/zarr.json`, encodeJson(groupDoc(DICT_ATTRS)));
        }
      }
      const nodePath = `${parentPath}/${path[path.length - 1]}`;
      const add = (p: string, w: WrittenArray) => {
        entries.set(p, w.doc);
        for (const [k, v] of w.objects) objects.set(k, v);
      };
      if (value.kind === 'string') {
        add(nodePath, await stringArray(nodePath, [value.value], [], { 'encoding-type': 'string', 'encoding-version': '0.2.0' }));
      } else {
        const names = Object.keys(value.columns);
        names.forEach(checkName);
        const attrs = { _index: '_index', 'column-order': names, 'encoding-type': 'dataframe', 'encoding-version': '0.2.0' };
        entries.set(nodePath, groupDoc(attrs));
        objects.set(`${nodePath}/zarr.json`, encodeJson(groupDoc(attrs)));
        add(`${nodePath}/_index`, await stringArray(`${nodePath}/_index`, value.index, [value.index.length], STRING_ARRAY_ATTRS));
        for (const name of names) {
          const col = value.columns[name];
          if (col.length !== value.index.length) throw new Error(`Column "${name}" has ${col.length} rows; the index has ${value.index.length}.`);
          const p = `${nodePath}/${name}`;
          add(p, Array.isArray(col)
            ? await stringArray(p, col, [col.length], STRING_ARRAY_ATTRS)
            : await numericArray(p, col, [col.length], ARRAY_ATTRS));
        }
      }
      // A replaced value is deleted first; only the leaf, so its siblings stay.
      await this.replaceNode(nodePath, entries, objects);
      return { op: 'set-uns', table, path };
    });
  }

  deleteUns(table: string, path: string[]): Promise<Change> {
    return this.serial(async () => {
      await this.deleteFromIndex(`tables/${table}/uns/${path.join('/')}`);
      return { op: 'delete-uns', table, path };
    });
  }
}
