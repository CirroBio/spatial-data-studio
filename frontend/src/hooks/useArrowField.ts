import { useState, useEffect, useRef } from 'react';
import * as arrow from 'apache-arrow';
import { getFieldData, fetchWhenIdle } from '../api';
import { formatError } from '../lib/format';

type CacheKey = string; // `${sessionId}:${fieldPath}:${version}`

const cache = new Map<CacheKey, arrow.Table>();
const CACHE_MAX = 24; // Arrow tables are large; keep only a small working set.

function cacheKey(sessionId: string, fieldPath: string, version: number): CacheKey {
  return `${sessionId}:${fieldPath}:${version}`;
}

// Insert, evicting superseded versions of the same field and capping total size, so
// the module cache can't grow unbounded as data_versions bump over a long session.
function cacheSet(sessionId: string, fieldPath: string, key: CacheKey, table: arrow.Table): void {
  const prefix = `${sessionId}:${fieldPath}:`;
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
  sessionId: string | null,
  fieldPath: string | null,
  version: number
): { table: arrow.Table | null; loading: boolean; error: string | null } {
  const [table, setTable] = useState<arrow.Table | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!sessionId || !fieldPath) {
      setTable(null);
      return;
    }

    const key = cacheKey(sessionId, fieldPath, version);
    const cached = cache.get(key);
    if (cached) {
      setTable(cached);
      setLoading(false);
      setError(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);

    // Retry a transient 503 (session busy — most often the async checkpoint load
    // holding the write lock on first open) so coords/colors converge once the lock
    // frees, instead of leaving the canvas stuck on "Loading…" until an unrelated
    // data_versions bump happens to re-trigger this effect.
    fetchWhenIdle(() => getFieldData(sessionId, fieldPath), { signal: controller.signal })
      .then((t) => {
        if (controller.signal.aborted) return;
        cacheSet(sessionId, fieldPath, key, t);
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
  }, [sessionId, fieldPath, version]);

  return { table, loading, error };
}
