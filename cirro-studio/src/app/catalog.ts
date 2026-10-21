// The open project's catalog: its datasets, then the items found in them as scans land.
// One module-level store per collection, read through useSyncExternalStore, so every
// view shares one load.
import { useCallback, useSyncExternalStore } from 'react';
import { describeError } from '../cirro/session';
import type { Collection } from '../data/collection';
import { itemsOf, type CatalogItem, type DatasetRecord } from '../data/model';
import { mapLimit } from '../lib/async';

const SCAN_CONCURRENCY = 4;

export interface CatalogState {
  status: 'loading' | 'scanning' | 'ready' | 'error';
  // Why the project couldn't be listed. With status 'error' nothing is listed; otherwise
  // a reload failed, and what is listed is from before it.
  error: string | null;
  // A reload is reading the project again; what is listed is from before it until it ends.
  reloading: boolean;
  datasets: DatasetRecord[];
  byId: Map<string, DatasetRecord>;
  items: CatalogItem[];
  // Datasets worth scanning, and how many have been.
  toScan: number;
  scanned: number;
  failed: { dataset: DatasetRecord; error: string }[];
}

const EMPTY: CatalogState = {
  status: 'loading', error: null, reloading: false, datasets: [], byId: new Map(), items: [], toScan: 0, scanned: 0, failed: [],
};

interface Entry {
  collection: Collection;
  state: CatalogState;
  listeners: Set<() => void>;
  abort: AbortController;
}

const entries = new Map<string, Entry>();

function set(entry: Entry, signal: AbortSignal, patch: Partial<CatalogState>) {
  if (signal.aborted) return;
  entry.state = { ...entry.state, ...patch };
  entry.listeners.forEach((l) => l());
}

function load(entry: Entry, reload = false) {
  entry.abort = new AbortController();
  const { signal } = entry.abort;
  const { collection } = entry;
  // The listing is built here. A first load shows it as it grows; a reload shows it once
  // complete, so what was listed stays on screen meanwhile and a page open on one of its
  // items keeps it.
  let next = EMPTY;
  const update = (patch: Partial<CatalogState>, complete = false) => {
    next = { ...next, ...patch };
    if (complete || !reload) set(entry, signal, next);
  };
  set(entry, signal, reload ? { reloading: true } : EMPTY);
  void (async () => {
    try {
      const datasets = await collection.datasets(signal);
      // Newest first: what someone just made is what they came to see.
      const candidates = datasets.filter((d) => collection.worthScanning(d)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      update({ status: 'scanning', datasets, byId: new Map(datasets.map((d) => [d.id, d])), toScan: candidates.length });
      await mapLimit(candidates, SCAN_CONCURRENCY, async (d) => {
        try {
          const found = itemsOf(d, await collection.scan(d, signal));
          update({ items: found.length ? [...next.items, ...found] : next.items, scanned: next.scanned + 1 });
        } catch (e) {
          // One unreadable dataset (deleted meanwhile, view-restricted) doesn't stop the
          // rest; the map says how many it couldn't read, and why.
          update({ scanned: next.scanned + 1, failed: [...next.failed, { dataset: d, error: describeError(e) }] });
        }
      }, signal);
      update({ status: 'ready' }, true);
    } catch (e) {
      const error = describeError(e, 'list datasets');
      // A reload that fails keeps what was listed, when anything was.
      if (reload && entry.state.status !== 'loading') set(entry, signal, { reloading: false, error });
      else update({ status: 'error', error }, true);
    }
  })();
}

const keyOf = (collection: Collection) => `${collection.kind}:${collection.id}`;

function entryFor(collection: Collection): Entry {
  const key = keyOf(collection);
  let entry = entries.get(key);
  if (!entry) {
    entry = { collection, state: EMPTY, listeners: new Set(), abort: new AbortController() };
    entries.set(key, entry);
    load(entry);
  }
  return entry;
}

export function useCatalog(collection: Collection): CatalogState {
  const entry = entryFor(collection);
  const subscribe = useCallback((l: () => void) => {
    entry.listeners.add(l);
    return () => entry.listeners.delete(l);
  }, [entry]);
  return useSyncExternalStore(subscribe, () => entry.state);
}

/** List and scan the project again, after a save added a dataset to it. */
export function reloadCatalog(collection: Collection) {
  const entry = entries.get(keyOf(collection));
  if (!entry) return;
  entry.abort.abort();
  load(entry, true);
}
