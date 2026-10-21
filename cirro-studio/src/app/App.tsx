import { lazy, Suspense, useEffect, useState } from 'react';
import type { Project } from '@cirrobio/api-client';
import { describeError, type CirroSession } from '../cirro/session';
import { EXAMPLES_ID } from '../data/examples';
import { EXAMPLES_TENANT } from '../tenants';
import { appKey } from './appInfo';
import { navigate, useRoute } from './route';
import { Shell } from './Shell';
import { collectionFor, StudioProvider } from './studio';

// The map and the item pages carry the WebGL and Zarr code; the shell paints first.
const MapView = lazy(() => import('../map/MapView'));
const ItemPage = lazy(() => import('../item/ItemPage'));

const lastProjectKey = (tenantId: string) => appKey(`last-project.${tenantId}`);

function useProjects(session: CirroSession | null) {
  const [state, setState] = useState<{ projects: Project[] | null; error: string | null }>({ projects: null, error: null });
  useEffect(() => {
    if (!session) return;
    let live = true;
    session.data.projects.getProjects().then(
      (projects) => live && setState({ projects: [...projects].sort((a, b) => a.name.localeCompare(b.name)), error: null }),
      (e: unknown) => live && setState({ projects: [], error: describeError(e, 'list projects') }),
    );
    return () => {
      live = false;
    };
  }, [session]);
  return state;
}

export function App({ session }: { session: CirroSession | null }) {
  const route = useRoute();
  const { projects, error } = useProjects(session);

  // The project in the URL, else the one last open on this tenant, else the only one.
  const tenantId = session?.tenant.id ?? EXAMPLES_TENANT;
  const wanted = route.project ?? localStorage.getItem(lastProjectKey(tenantId));
  const project = session
    ? projects?.find((p) => p.id === wanted) ?? (projects?.length === 1 ? projects[0] : null)
    : null;
  useEffect(() => {
    if (!session) {
      if (route.project !== EXAMPLES_ID || route.tenant !== EXAMPLES_TENANT) navigate({ tenant: EXAMPLES_TENANT, project: EXAMPLES_ID }, { replace: true });
      return;
    }
    if (project) {
      localStorage.setItem(lastProjectKey(tenantId), project.id);
      if (route.project !== project.id || route.tenant !== tenantId) navigate({ tenant: tenantId, project: project.id }, { replace: true });
    }
  }, [session, project, route.project, route.tenant, tenantId]);

  if (session && !projects) return <Shell session={session} projects={null}><p className="page-message muted">Loading your projects…</p></Shell>;
  if (session && !project) {
    return (
      <Shell session={session} projects={projects}>
        <div className="page-message">
          {error ? <p className="notice notice-danger">{error}</p> : projects?.length
            ? <p>Choose a project from the menu above.</p>
            : <p>Your Cirro account can't see any projects this app has access to. A project admin can add you, or a Cirro admin can grant this app access to a project.</p>}
        </div>
      </Shell>
    );
  }
  const collection = collectionFor(session, project ? { id: project.id, name: project.name } : null);
  return (
    <StudioProvider session={session} collection={collection}>
      <Shell session={session} projects={projects}>
        <Suspense fallback={<p className="page-message muted">Loading…</p>}>
          {route.section === 'item' || route.section === 'task' ? <ItemPage /> : <MapView />}
        </Suspense>
      </Shell>
    </StudioProvider>
  );
}
