import { useState, useEffect } from 'react';
import * as arrow from 'apache-arrow';
import { fetchWhenIdle } from '../lib/fetchWhenIdle';
import { useDataSource } from './context';
import { formatError } from '../lib/format';

type CacheKey = string; // `${sourceId}:${fieldPath}:${version}`

const cache = new Map<CacheKey, arrow.Table>();
const CACHE_MAX = 24; // Arrow tables are large; keep only a small working set.

function cacheKey(sourceId: string, fieldPath: string, version: number): CacheKey {
  return `${sourceId}:${fieldPath}:${version}`;
}

// Insert, evicting superseded versions of the same field and capping total size, so
// the module cache can't grow unbounded as data_versions bump over a long session.
function cacheSet(sourceId: string, fieldPath: string, key: CacheKey, table: arrow.Table): void {
  const prefix = `${sourceId}:${fieldPath}:`;
  for (const k of cache.keys()) {
    if (k !== key && k.startsWith(prefix)) cache.delete(k);
  }
  cache.set(key, table);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function useArrowField(
  fieldPath: string | null,
  version: number
): { table: arrow.Table | null; loading: boolean; error: string | null } {
  const source = useDataSource();
  const [table, setTable] = useState<arrow.Table | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceId = source?.id ?? null;

  useEffect(() => {
    if (!source || !sourceId || !fieldPath) {
      // "Nothing to load" is a resolved state, not a pending one: clearing Color By sets
      // fieldPath null, and leaving `loading` set would keep colorLoading/coordsLoading
      // true forever, with the canvas stuck behind a spinner for a fetch that will never
      // run. The error belongs to the field that just went away, so it goes too. The
      // previous request is already aborted — React ran this effect's cleanup first.
      setTable(null);
      setLoading(false);
      setError(null);
      return;
    }

    const key = cacheKey(sourceId, fieldPath, version);
    const cached = cache.get(key);
    if (cached) {
      setTable(cached);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    // Retry a transient 503 (session busy — most often the async checkpoint load
    // holding the write lock on first open) so coords/colors converge once the lock
    // frees, instead of leaving the canvas stuck on "Loading…" until an unrelated
    // data_versions bump happens to re-trigger this effect.
    //
    // The signal only cancels the retry loop and the state updates: `DataSource.getFieldData`
    // takes no signal, so a request already issued still runs to completion — a cancelled
    // checkpoint read keeps its range GETs in flight until they land.
    fetchWhenIdle(() => source.getFieldData(fieldPath), { signal: controller.signal })
      .then((t) => {
        if (controller.signal.aborted) return;
        cacheSet(sourceId, fieldPath, key, t);
        setTable(t);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(formatError(err));
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [source, sourceId, fieldPath, version]);

  return { table, loading, error };
}
