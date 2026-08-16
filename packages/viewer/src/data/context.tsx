import { createContext, useContext, type ReactNode } from 'react';
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
