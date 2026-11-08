import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import type { Project } from '@cirrobio/api-client';
import { describeError, type CirroSession } from '../cirro/session';
import type { ProjectAccess } from '../data/collection';
import { usePublicProjects } from '../data/publicProjects';
import { PUBLIC_TENANT } from '../tenants';
import { appKey } from './appInfo';
import { navigate, useRoute } from './route';
import { Settings } from './Settings';
import { Shell } from './Shell';
import { collectionFor, refId, StudioProvider, type ProjectRef } from './studio';

// The map and the item pages carry the WebGL and Zarr code; the shell paints first.
const MapView = lazy(() => import('../map/MapView'));
const ItemPage = lazy(() => import('../item/ItemPage'));
const AddData = lazy(() => import('../add/AddData'));

const lastProjectKey = (tenantId: string) => appKey(`last-project.${tenantId}`);

export type CirroProject = Project & { access: ProjectAccess };

function useProjects(session: CirroSession | null) {
  const [state, setState] = useState<{ projects: CirroProject[] | null; error: string | null }>({ projects: null, error: null });
  useEffect(() => {
    if (!session) return;
    let live = true;
    Promise.all([session.data.projects.getProjects(), session.projectAccess()]).then(
      ([projects, access]) => live && setState({
        projects: projects.map((p) => ({ ...p, access: access.get(p.id) ?? 'write' })).sort((a, b) => a.name.localeCompare(b.name)),
        error: null,
      }),
      (e: unknown) => live && setState({ projects: [], error: describeError(e, 'list projects') }),
    );
    return () => {
      live = false;
    };
  }, [session]);
  return state;
}

// Reached once every listed public project has answered and none could be read.
function NoPublicProjects({ onSettings }: { onSettings: () => void }) {
  const listed = usePublicProjects().length;
  return (
    <div className="page-message">
      <p>{listed
        ? `${listed === 1 ? 'The public project listed in this browser could not' : 'None of the public projects listed in this browser could'} be read. Settings shows why.`
        : 'No public project is listed in this browser. Add one, or bring back Spatial Data Studio\'s, in Settings.'}</p>
      <button type="button" className="button button-primary" onClick={onSettings}>Settings</button>
    </div>
  );
}

export function App({ session }: { session: CirroSession | null }) {
  const route = useRoute();
  const { projects, error } = useProjects(session);
  const publicProjects = usePublicProjects();
  const ready = publicProjects.flatMap((p) => (p.status === 'ready' ? [p.project] : []));
  const publicSettled = publicProjects.every((p) => p.status !== 'loading');
  // Kept here, above the pages below, so the dialog stays open while they change.
  const [settings, setSettings] = useState(false);
  const openSettings = () => setSettings(true);

  // The project in the URL, else the one last open on this tenant, else the only Cirro
  // project, else (logged out) the first public one. Public projects are waited for only
  // when one of them is wanted, or (logged out) until the first that can be read answers.
  const tenantId = session?.tenant.id ?? PUBLIC_TENANT;
  const wanted = route.project ?? localStorage.getItem(lastProjectKey(tenantId));
  const cirro = projects?.find((p) => p.id === wanted);
  const open = ready.find((p) => p.id === wanted);
  const awaitingPublic = !open && (wanted && !cirro ? !publicSettled : !session && publicProjects.find((p) => p.status !== 'error')?.status === 'loading');
  const waiting = (session !== null && !projects) || Boolean(awaitingPublic);
  let ref: ProjectRef | null = null;
  if (cirro) ref = { kind: 'cirro', id: cirro.id, name: cirro.name, access: cirro.access };
  else if (open) ref = { kind: 'public', project: open };
  else if (!waiting && session && projects?.length === 1) ref = { kind: 'cirro', id: projects[0].id, name: projects[0].name, access: projects[0].access };
  else if (!waiting && !session && ready.length) ref = { kind: 'public', project: ready[0] };
  const refKey = ref && refId(ref);

  useEffect(() => {
    if (!refKey) return;
    localStorage.setItem(lastProjectKey(tenantId), refKey);
    if (route.project !== refKey || route.tenant !== tenantId) navigate({ tenant: tenantId, project: refKey }, { replace: true });
  }, [refKey, route.project, route.tenant, tenantId]);

  const shell = (children: ReactNode) => <Shell session={session} projects={projects} onSettings={openSettings}>{children}</Shell>;
  let page: ReactNode;
  if (waiting) page = shell(<p className="page-message muted">Loading projects…</p>);
  else if (!ref) {
    page = shell(!session ? <NoPublicProjects onSettings={openSettings} /> : (
      <div className="page-message">
        {error ? <p className="notice notice-danger">{error}</p> : projects?.length || ready.length
          ? <p>Choose a project from the menu above.</p>
          : <p>Your Cirro account can't see any projects this app has access to. A project admin can add you, or a Cirro admin can grant this app access to a project.</p>}
      </div>
    ));
  } else {
    page = (
      <StudioProvider session={session} collection={collectionFor(session, ref)}>
        {shell(
          <Suspense fallback={<p className="page-message muted">Loading…</p>}>
            {route.section === 'add' ? <AddData /> : route.section === 'item' || route.section === 'task' ? <ItemPage /> : <MapView />}
          </Suspense>,
        )}
      </StudioProvider>
    );
  }
  return (
    <>
      {page}
      {settings && <Settings onClose={() => setSettings(false)} />}
    </>
  );
}
