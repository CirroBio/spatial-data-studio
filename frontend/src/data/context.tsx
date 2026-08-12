import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createApiSource } from './apiSource';
import type { DataSource } from './types';

// The canvas reads its data through whichever source is in context: a live session
// (default) or a checkpoint opened by the serverless viewer. Null before a session
// exists — the canvas isn't mounted then.
const DataSourceContext = createContext<DataSource | null>(null);

export function useDataSource(): DataSource | null {
  return useContext(DataSourceContext);
}

export function DataSourceProvider(
  { source, children }: { source: DataSource | null; children: ReactNode },
) {
  return <DataSourceContext.Provider value={source}>{children}</DataSourceContext.Provider>;
}

/** Live-session source for `sessionId`, memoized so the canvas hooks see a stable
 * reference across renders. */
export function useApiSource(sessionId: string | null): DataSource | null {
  return useMemo(() => (sessionId ? createApiSource(sessionId) : null), [sessionId]);
}
