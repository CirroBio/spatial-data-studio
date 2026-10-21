// What every view of the app reads: the session (null for the examples), the open
// project as a collection, its catalog, and the library built from it.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { CirroSession } from '../cirro/session';
import type { Collection } from '../data/collection';
import { ExampleCollection } from '../data/examples';
import { useCatalog, type CatalogState } from './catalog';
import { buildLibrary, type Library } from './library';

export interface Studio {
  session: CirroSession | null;
  collection: Collection;
  catalog: CatalogState;
  library: Library;
}

const StudioContext = createContext<Studio | null>(null);

// One collection per project for the life of the page, so its caches (listings, signed
// reads, scans) outlive the views that use them.
const collections = new Map<string, Collection>();
const examples = new ExampleCollection();

export function collectionFor(session: CirroSession | null, project: { id: string; name: string } | null): Collection {
  if (!session || !project) return examples;
  let c = collections.get(project.id);
  if (!c) {
    c = session.openProject(project);
    collections.set(project.id, c);
  }
  return c;
}

export function StudioProvider({ session, collection, children }: {
  session: CirroSession | null; collection: Collection; children: ReactNode;
}) {
  const catalog = useCatalog(collection);
  const library = useMemo(() => buildLibrary(catalog), [catalog]);
  const value = useMemo(() => ({ session, collection, catalog, library }), [session, collection, catalog, library]);
  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useStudio(): Studio {
  const s = useContext(StudioContext);
  if (!s) throw new Error('useStudio outside StudioProvider');
  return s;
}

/** The studio where one is open; the shell also frames the pages before a project is. */
export const useOptionalStudio = (): Studio | null => useContext(StudioContext);
