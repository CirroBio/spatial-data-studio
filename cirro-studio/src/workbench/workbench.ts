// An opened spatial dataset: its stack (base store, saved versions, unsaved draft), the
// viewer's handle on the composed store, and the changes staged in the draft. Edits go
// into the draft as the objects a saved version will hold, and the handle is reopened
// over them, so what the page shows is exactly what saving would write.
import { useCallback, useSyncExternalStore } from 'react';
import type { AsyncReadable } from '@zarrita/storage';
import { openCheckpointStore, type CheckpointHandle } from '@cirrobio/spatial-viewer';
import { describeError } from '../cirro/session';
import type { Collection } from '../data/collection';
import { kvDelete, kvDeleteWhere, kvGet, kvPut, kvValues } from '../data/idb';
import { datasetRef } from '../stack/cirroRef';
import { StackEditor } from '../stack/editor';
import { LayeredStore, MemoryLayer } from '../stack/layeredStore';
import { FIGURES, LAYER_MANIFEST, UNS_ROOT, type Change } from '../stack/manifest';
import { baseRef, openBase, resolveChain, savedLayers, topRef, type StackLevel, type StackTop } from '../stack/openStack';
import type { SavedLayer } from '../stack/layeredStore';
import { versionFiles } from '../stack/version';
import { decodeJson } from '../stack/zarrWrite';

export interface Workbench {
  key: string;
  status: 'opening' | 'ready' | 'error';
  error: string | null;
  levels: StackLevel[];
  handle: CheckpointHandle | null;
  // Staged in the draft, oldest first; a later change to the same target replaces an
  // earlier one.
  changes: Change[];
  draftBytes: number;
  // Cache-bust keys for fields an edit replaced (the canvas's `dataVersions`).
  dataVersions: Record<string, number>;
  // Bumped by every reopen, for views that read the store themselves.
  revision: number;
}

interface OpenedStack {
  levels: StackLevel[];
  base: Required<AsyncReadable>;
  saved: SavedLayer[];
  // The nodes the stack beneath the draft holds, by its consolidated index.
  beneath: Set<string>;
}

interface Internal {
  state: Workbench;
  listeners: Set<() => void>;
  collection: Collection;
  opened: OpenedStack | null;
  draft: MemoryLayer;
  store: LayeredStore | null;
  editor: StackEditor | null;
}

const benches = new Map<string, Internal>();
// Base stores are shared by every stack on them, so a zip's directory is read once.
const bases = new Map<string, Promise<Required<AsyncReadable>>>();

function emit(b: Internal, patch: Partial<Workbench>) {
  b.state = { ...b.state, ...patch };
  b.listeners.forEach((l) => l());
}

// The store node a change writes or deletes; two changes to one node are one target.
const changeNode = (c: Change) => `tables/${c.table}/${'column' in c ? `obs/${c.column}` : 'key' in c ? `obsm/${c.key}`
  : 'path' in c ? `uns/${c.path.join('/')}` : `uns/${UNS_ROOT}/${FIGURES}/${c.id}`}`;

// The viewer's fields whose cached data a change makes stale.
const staleFields = (c: Change) => ('column' in c ? [`obs:${c.column}`] : 'key' in c ? [`obsm:${c.key}`] : []);

// The draft outlives the page: it is kept in this browser until it is saved or
// discarded, so a reload or a closed tab loses nothing. A Cirro project's drafts are
// also discarded at log-out, so the next person to sign in here can't open them.
interface StoredDraft { source: Collection['kind']; objects: [string, Uint8Array][]; deleted: string[]; changes: Change[] }

const isCirroDraft = (d: StoredDraft) => d.source === 'cirro';
export const countCirroDrafts = () => kvValues<StoredDraft>('drafts').then((all) => all.filter(isCirroDraft).length);
export const forgetCirroDrafts = () => kvDeleteWhere('drafts', isCirroDraft);

function persist(b: Internal): Promise<void> {
  if (b.draft.isEmpty) return kvDelete('drafts', b.state.key);
  const stored: StoredDraft = {
    source: b.collection.kind, objects: [...b.draft.objects], deleted: [...b.draft.deleted], changes: b.state.changes,
  };
  return kvPut('drafts', b.state.key, stored);
}

async function restore(b: Internal) {
  const stored = await kvGet<StoredDraft>('drafts', b.state.key);
  if (!stored) return;
  b.draft.put(stored.objects);
  for (const d of stored.deleted) b.draft.deleted.add(d);
  emit(b, { changes: stored.changes });
}

async function reopen(b: Internal, changedFields: string[] = []) {
  b.store = new LayeredStore(b.opened!.base, [...b.opened!.saved, b.draft]);
  b.editor = new StackEditor(b.store, b.draft);
  // A stable id keeps the viewer's field cache across reopens; replaced fields are
  // re-read through `dataVersions`.
  const handle = await openCheckpointStore(b.store, b.state.key);
  const dataVersions = { ...b.state.dataVersions };
  for (const f of changedFields) dataVersions[f] = (dataVersions[f] ?? 0) + 1;
  emit(b, { status: 'ready', handle, dataVersions, revision: b.state.revision + 1, draftBytes: b.draft.bytes });
}

async function open(b: Internal, top: StackTop) {
  try {
    const levels = await resolveChain(b.collection, top);
    const bottom = baseRef(levels);
    let base = bases.get(bottom);
    if (!base) {
      base = openBase(b.collection, levels[0]);
      bases.set(bottom, base);
      base.catch(() => bases.delete(bottom));
    }
    const baseStore = await base;
    const saved = savedLayers(b.collection, levels);
    // A store without a consolidated index can't be edited, so nothing beneath it matters.
    const root = await new LayeredStore(baseStore, saved).get('/zarr.json');
    const index = root && decodeJson<{ consolidated_metadata?: { metadata: Record<string, unknown> } }>(root).consolidated_metadata?.metadata;
    b.opened = { levels, base: baseStore, saved, beneath: new Set(Object.keys(index ?? {})) };
    emit(b, { levels });
    await restore(b);
    await reopen(b);
  } catch (e) {
    emit(b, { status: 'error', error: describeError(e) });
  }
}

export const workbenchKey = (top: StackTop) => datasetRef(top.datasetId, top.path);

function benchFor(collection: Collection, top: StackTop): Internal {
  const key = workbenchKey(top);
  let b = benches.get(key);
  if (!b) {
    b = {
      state: { key, status: 'opening', error: null, levels: [], handle: null, changes: [], draftBytes: 0, dataVersions: {}, revision: 0 },
      listeners: new Set(), collection, opened: null, draft: new MemoryLayer(), store: null, editor: null,
    };
    benches.set(key, b);
    void open(b, top);
  }
  return b;
}

export function useWorkbench(collection: Collection, top: StackTop): Workbench {
  const b = benchFor(collection, top);
  const subscribe = useCallback((l: () => void) => {
    b.listeners.add(l);
    return () => b.listeners.delete(l);
  }, [b]);
  return useSyncExternalStore(subscribe, () => b.state);
}

function bench(key: string): Internal {
  const b = benches.get(key);
  if (!b?.editor) throw new Error('This dataset is not open yet.');
  return b;
}

/** The composed store (saved versions and the draft), for readers outside the viewer. */
export function storeOf(key: string): Required<AsyncReadable> {
  return bench(key).store!;
}

/** Run an edit into the draft, record the change it returns, and reopen over it. */
export async function applyEdit(key: string, edit: (editor: StackEditor) => Promise<Change>): Promise<void> {
  const b = bench(key);
  const change = await edit(b.editor!);
  const node = changeNode(change);
  const kept = b.state.changes.filter((c) => changeNode(c) !== node);
  // Deleting what this draft itself added leaves nothing to record. A node the stack
  // beneath holds is deleted from it, so that is recorded even when the draft had
  // replaced the node first.
  const addedHere = change.op.startsWith('delete-') && !b.opened!.beneath.has(node);
  emit(b, { changes: addedHere ? kept : [...kept, change] });
  // Kept before the reopen, so a store that then fails to open loses no work.
  await persist(b);
  await reopen(b, staleFields(change));
}

export async function discardDraft(key: string): Promise<void> {
  const b = bench(key);
  const stale = b.state.changes.flatMap(staleFields);
  b.draft = new MemoryLayer();
  emit(b, { changes: [] });
  await persist(b);
  await reopen(b, stale);
}

export interface SaveRequest {
  title: string;
  message: string;
  createdBy: string;
  // Dataset name for the new version.
  name: string;
}

/** Save the draft as a version on top of the stack; resolves to the new version's
 * dataset ID, its workbench key and any problem with its provenance note. The draft is
 * then empty: the version holds it. */
export async function saveDraft(key: string, req: SaveRequest, onProgress?: (fraction: number) => void) {
  const b = bench(key);
  const levels = b.opened!.levels;
  const { manifest, files } = versionFiles(b.draft, {
    parent: topRef(levels),
    base: baseRef(levels),
    depth: levels.length,
    title: req.title,
    message: req.message,
    createdBy: req.createdBy,
    changes: b.state.changes,
  });
  const top = levels[levels.length - 1];
  const result = await b.collection.saveVersion({
    name: req.name,
    description: req.message || req.title,
    files,
    sourceIds: [top.datasetId],
    note: {
      what: `Version "${req.title}" of a SpatialData store, saved by Spatial Data Studio: only what changed, on top of ${manifest.parent}.`,
      parameters: { parent: manifest.parent, base: manifest.base, depth: manifest.depth, changes: manifest.changes, objects: manifest.files.length },
    },
  }, onProgress);
  // The version holds the draft now; keeping it here too would offer to save it twice.
  await discardDraft(key);
  return { ...result, key: workbenchKey({ datasetId: result.datasetId, path: LAYER_MANIFEST, kind: 'version' }) };
}

/** Forget an opened stack, so opening it again reads it afresh. */
export function closeWorkbench(key: string) {
  benches.delete(key);
}
