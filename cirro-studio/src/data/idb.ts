// A small key-value store over IndexedDB: values are structured-cloned, so typed arrays
// and nested objects go in and come back as they were.
import { appKey } from '../app/appInfo';

const DB_NAME = appKey('browser');
const STORES = ['datasets', 'scans', 'drafts'] as const;
export type KvStore = (typeof STORES)[number];

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Bumped whenever STORES grows, so the upgrade adds the new store.
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      for (const name of STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('This browser would not open its local storage.'));
  });
}

function run<T>(store: KvStore, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = work(tx.objectStore(store));
    tx.oncomplete = () => {
      db.close();
      resolve(req.result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('This browser could not read or write its local storage.'));
    };
    // A write refused at commit (no room left, say) aborts without an error event.
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error('This browser stopped a read or write of its local storage.'));
    };
  }));
}

export const kvGet = <T>(store: KvStore, key: string) => run<T | undefined>(store, 'readonly', (s) => s.get(key));
export const kvPut = (store: KvStore, key: string, value: unknown) => run(store, 'readwrite', (s) => s.put(value, key)).then(() => undefined);
export const kvValues = <T>(store: KvStore) => run<T[]>(store, 'readonly', (s) => s.getAll());
export const kvDelete = (store: KvStore, key: string) => run(store, 'readwrite', (s) => s.delete(key)).then(() => undefined);

export function kvDeleteWhere<T>(store: KvStore, drop: (value: T) => boolean): Promise<void> {
  return run(store, 'readwrite', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (drop(cursor.value as T)) cursor.delete();
      cursor.continue();
    };
    return req;
  }).then(() => undefined);
}
