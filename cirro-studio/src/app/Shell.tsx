import { lazy, Suspense, useState, type ReactNode } from 'react';
import type { Project } from '@cirrobio/api-client';
import { describeError, type CirroSession } from '../cirro/session';
import { forgetTenant, openExamples, showLanding, showSignIn } from '../tenants';
import { About } from './About';
import { APP_NAME, APP_VERSION } from './appInfo';
import { navigate, useRoute } from './route';
import { useOptionalStudio } from './studio';
import { Popover } from './ui';
import { countCirroDrafts } from '../workbench/workbench';

// Only a signed-in project loads it, with the Cirro client its workspaces need.
const Workspaces = lazy(() => import('../workspaces/Workspaces'));

const Chevron = () => <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;

function ProjectPicker({ projects }: { projects: Project[] }) {
  const route = useRoute();
  const [filter, setFilter] = useState('');
  const current = projects.find((p) => p.id === route.project);
  const shown = projects.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Popover label={<>{current?.name ?? 'Choose a project'} <Chevron /></>}>
      {(close) => (
        <div className="menu" role="menu">
          {projects.length > 8 && (
            <input className="input menu-filter" placeholder="Filter projects" value={filter} autoFocus onChange={(e) => setFilter(e.target.value)} />
          )}
          {shown.map((p) => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === route.project} className="menu-item"
              onClick={() => { navigate({ project: p.id, section: 'home' }); close(); }}>
              {p.name}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

// What the catalog is doing, in a few words: the project opens fast from its catalog,
// and the datasets nobody has scanned yet are listed while you look.
function CatalogStatus() {
  const studio = useOptionalStudio();
  if (!studio) return null;
  const { status, error, reloading, scanned, toScan, failed } = studio.catalog;
  const note = studio.collection.catalogNote;
  if (reloading) {
    return <span className="shell-status" aria-live="polite"><span className="spinner" aria-hidden="true" /> Updating the catalog</span>;
  }
  // A reload that failed: the map keeps what was listed before it.
  if (error && status !== 'error') {
    return <span className="shell-status shell-status-warn" title={error}>Catalog not updated</span>;
  }
  if (status === 'scanning') {
    return <span className="shell-status" aria-live="polite"><span className="spinner" aria-hidden="true" /> Reading {scanned} of {toScan} datasets</span>;
  }
  if (status === 'ready' && (failed.length || note)) {
    const notes = [
      ...(failed.length ? [`${failed.length} dataset${failed.length === 1 ? '' : 's'} couldn't be read: ${failed.slice(0, 3).map((f) => `${f.dataset.name} (${f.error})`).join('; ')}`] : []),
      ...(note ? [note] : []),
    ];
    return <span className="shell-status shell-status-warn" title={notes.join('\n')}>{failed.length ? `${failed.length} unreadable` : 'Catalog in this browser'}</span>;
  }
  return null;
}

// Where the app goes once logged out: the start page, or the log-in box for another Cirro.
type Leaving = { next: () => void };

function AccountMenu({ session }: { session: CirroSession | null }) {
  const [problem, setProblem] = useState<Leaving & { message: string } | null>(null);
  const [unsaved, setUnsaved] = useState<Leaving & { drafts: number } | null>(null);
  const [about, setAbout] = useState(false);
  const aboutDialog = about && <About onClose={() => setAbout(false)} />;
  if (!session) {
    return (
      <>
        <button type="button" className="topbar-button" onClick={() => setAbout(true)}>About</button>
        <button type="button" className="button button-primary shell-log-in" onClick={showSignIn}>Log In (Cirro)</button>
        {aboutDialog}
      </>
    );
  }
  // Another Cirro starts with logging out of this one, so a tab never mixes two tenants' data.
  const logOut = async (next: () => void) => {
    forgetTenant();
    try {
      await session.signOut();
      next();
    } catch (e) {
      setProblem({ message: describeError(e), next });
    }
  };
  const askToLogOut = async (next: () => void) => {
    // Where the browser refuses storage, no draft was kept.
    const drafts = await countCirroDrafts().catch(() => 0);
    if (drafts > 0) setUnsaved({ drafts, next });
    else await logOut(next);
  };
  return (
    <>
      <Popover align="right" label={<>{session.tenantName} · {session.displayName} <Chevron /></>}>
        {(close) => (
          <div className="menu" role="menu">
            <button type="button" className="menu-item" onClick={() => { close(); openExamples(); }}>Explore example data</button>
            <button type="button" className="menu-item" onClick={() => { close(); void askToLogOut(showSignIn); }}>Log in to another Cirro</button>
            <button type="button" className="menu-item" onClick={() => { close(); setAbout(true); }}>About {APP_NAME}</button>
            <button type="button" className="menu-item" onClick={() => { close(); void askToLogOut(showLanding); }}>Log out</button>
            <p className="menu-note muted">{APP_NAME} {APP_VERSION}</p>
          </div>
        )}
      </Popover>
      {unsaved && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Discard unsaved changes?</h2>
            <p>
              {unsaved.drafts === 1 ? 'One store has changes' : `${unsaved.drafts} stores have changes`} not saved as a version. This browser
              keeps them only while you are logged in, so logging out discards them.
            </p>
            <div className="button-row">
              <button type="button" className="button" onClick={() => setUnsaved(null)}>Stay logged in</button>
              <button type="button" className="button button-danger" onClick={() => { setUnsaved(null); void logOut(unsaved.next); }}>Log out and discard</button>
            </div>
          </div>
        </div>
      )}
      {aboutDialog}
      {problem && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Logged out</h2>
            <p>{problem.message}</p>
            <button type="button" className="button button-primary" onClick={problem.next}>Continue</button>
          </div>
        </div>
      )}
    </>
  );
}

// The session comes from App rather than the studio: the shell also frames the pages
// shown before a project opens, where the account menu still has to offer Log out.
export function Shell({ session, projects, children }: {
  session: CirroSession | null; projects: Project[] | null; children: ReactNode;
}) {
  const studio = useOptionalStudio();
  return (
    <div className="shell">
      <header className="shell-topbar">
        <button type="button" className="shell-appname" onClick={() => navigate({ section: 'home' })}>{APP_NAME}</button>
        <nav className="shell-breadcrumb" aria-label="Project">
          {!session && <span className="shell-crumb">Example data · nothing leaves this browser</span>}
          {projects && projects.length > 0 && <ProjectPicker projects={projects} />}
        </nav>
        <span className="shell-spacer" />
        <CatalogStatus />
        {session && studio && <Suspense fallback={null}><Workspaces session={session} /></Suspense>}
        <AccountMenu session={session} />
      </header>
      <main className="shell-main">{children}</main>
    </div>
  );
}
