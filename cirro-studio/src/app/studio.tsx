// What every view of the app reads: the session (null when nobody is logged in), the open
// project as a collection, its catalog, and the library built from it.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { CirroSession } from '../cirro/session';
import type { Collection, ProjectAccess } from '../data/collection';
import { PublicProject } from '../data/publicProject';
import type { PublicProjectInfo } from '../data/publicProjects';
import { useCatalog, type CatalogState } from './catalog';
import { buildLibrary, type Library } from './library';

export interface Studio {
  session: CirroSession | null;
  collection: Collection;
  catalog: CatalogState;
  library: Library;
}

const StudioContext = createContext<Studio | null>(null);

// A project the app can open: one of the signed-in user's Cirro projects, or a public one.
export type ProjectRef = { kind: 'cirro'; id: string; name: string; access: ProjectAccess } | { kind: 'public'; project: PublicProjectInfo };

export const refId = (ref: ProjectRef) => (ref.kind === 'cirro' ? ref.id : ref.project.id);

// One collection per project for the life of the page, so its caches (listings, signed
// reads, scans) outlive the views that use them.
const collections = new Map<string, Collection>();

export function collectionFor(session: CirroSession | null, ref: ProjectRef): Collection {
  const key = `${ref.kind}:${refId(ref)}`;
  let c = collections.get(key);
  if (!c) {
    if (ref.kind === 'public') c = new PublicProject(ref.project);
    else if (session) c = session.openProject(ref);
    else throw new Error(`Log in to Cirro to open ${ref.name}.`);
    collections.set(key, c);
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
