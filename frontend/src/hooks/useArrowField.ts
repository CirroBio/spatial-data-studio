import { useState, useEffect, useRef } from 'react';
import * as arrow from 'apache-arrow';
import { getFieldData } from '../api';

type CacheKey = string; // `${sessionId}:${fieldPath}:${version}`

const cache = new Map<CacheKey, arrow.Table>();

function cacheKey(sessionId: string, fieldPath: string, version: number): CacheKey {
  return `${sessionId}:${fieldPath}:${version}`;
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

    getFieldData(sessionId, fieldPath)
      .then((t) => {
        if (controller.signal.aborted) return;
        cache.set(key, t);
        setTable(t);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [sessionId, fieldPath, version]);

  return { table, loading, error };
}
