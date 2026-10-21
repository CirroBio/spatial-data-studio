import React, { type ErrorInfo, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import type { SystemInfoResponse } from '@cirrobio/api-client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { REDIRECT_URI, signInError } from './signInState';
import { EXAMPLES_TENANT, loadTenants, startOf, takeSignInNow, type Tenant } from './tenants';
import { FatalError, SignInPage, StartPages } from './start/Start';
import { App } from './app/App';
import { APP_NAME } from './app/appInfo';
import { describeError, type CirroSession } from './cirro/session';
import { forgetCirroDrafts } from './workbench/workbench';
import './styles/tokens.css';
import './styles/app.css';
import './styles/studio-ui.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);

// A rendering error anywhere shows a message and a way back, not a blank page.
class ErrorBoundary extends React.Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  render() {
    return this.state.failed
      ? <FatalError title="Something went wrong" message={`${APP_NAME} hit an unexpected error on this page. Reloading usually fixes it.`} action={<button type="button" className="button button-primary" onClick={() => window.location.reload()}>Reload</button>} />
      : this.props.children;
  }
}

const render = (node: ReactNode) => root.render(<React.StrictMode><ErrorBoundary>{node}</ErrorBoundary></React.StrictMode>);
const tryAgain = <button type="button" className="button button-primary" onClick={() => window.location.assign(REDIRECT_URI)}>Try again</button>;

// A Cirro tenant: its public system info, then sign-in through its authorize page, then
// the app with an API client whose token comes from the sign-in library on every call.
async function startTenant(tenant: Tenant, tenants: Tenant[]) {
  const signInNow = takeSignInNow();
  root.render(<main className="centered-page"><p className="muted">Connecting to {tenant.name}…</p></main>);
  const res = await fetch(`${tenant.url}/api/info/system`).catch(() => null);
  if (!res?.ok) {
    render(<FatalError title={`Can't reach ${tenant.name}`} message="Cirro didn't answer. Check your connection and try again." action={tryAgain} />);
    return;
  }
  const system = (await res.json()) as SystemInfoResponse;
  const tenantName = system.tenantInfo.name || tenant.name;
  if (system.maintenanceModeEnabled) {
    render(<FatalError title={`${tenantName} is in maintenance`} message="Cirro is being updated. Try again in a few minutes." action={tryAgain} />);
    return;
  }
  const failed = signInError();
  if (failed) {
    render(<FatalError title={`Logging in to ${tenantName} didn't finish`} message={`Cirro answered: ${failed}`} action={tryAgain} />);
    return;
  }
  const { activeUser, createSignIn, currentUser, signOut, startSignIn, usernameOf } = await import('./auth');
  // A step caught with this resolves to undefined, meaning "failed, already shown" — not
  // currentUser's null, which means nobody is signed in.
  const didntFinish = (e: unknown): undefined => {
    render(<FatalError title={`Logging in to ${tenantName} didn't finish`} message={describeError(e)} action={tryAgain} />);
  };
  const signIn = await createSignIn(tenant.url, tenant.clientId).catch(didntFinish);
  if (!signIn) return;
  const user = await currentUser(signIn).catch(didntFinish);
  if (user === undefined) return;
  if (!user) {
    const redirect = () => startSignIn(signIn, tenant.id).catch(didntFinish);
    if (signInNow) await redirect();
    else render(<SignInPage tenantName={tenantName} onSignIn={redirect} />);
    return;
  }
  const tokenGetter = async () => {
    const current = await activeUser(signIn);
    if (!current) throw new Error('Your Cirro session has ended. Reload the page to log in again.');
    return current.access_token;
  };
  // The Cirro client and the code that reads projects load only for a signed-in visit.
  const [{ DataService, FileService }, { CirroCollection }, { forgetBrowserCatalog }] = await Promise.all([
    import('@cirrobio/sdk'), import('./cirro/cirroCollection'), import('./cirro/catalogSheet'),
  ]);
  const data = new DataService({ basePath: `${tenant.url}/api`, tokenGetter });
  const username = usernameOf(user);
  const session: CirroSession = {
    tenant,
    data,
    files: new FileService(data.file),
    username,
    displayName: typeof user.profile.email === 'string' ? user.profile.email : username,
    tenantName,
    tenantId: system.tenantInfo.id,
    sheetsEnabled: Boolean(system.tenantInfo.features?.sheetsEnabled),
    signOut: async () => {
      try {
        await signOut(signIn);
      } finally {
        // The project data this browser kept goes with the login: github.io is an origin
        // other sites share, and the next person to sign in here may be someone else.
        await Promise.all([forgetCirroDrafts(), forgetBrowserCatalog()]);
      }
    },
    openProject: (project) => new CirroCollection(session, project.id, project.name),
  };
  render(<App tenants={tenants} session={session} />);
}

// GitHub Pages can't send a frame-ancestors header, so the app refuses to run inside
// another site's frame (clickjacking) and offers its own tab instead.
if (window.top !== window.self) {
  root.render(
    <main className="centered-page">
      <div className="card start-card">
        <p>{APP_NAME} doesn't run inside another page.</p>
        <a href={window.location.href} target="_blank" rel="noreferrer">Open {APP_NAME} in its own tab</a>
      </div>
    </main>,
  );
} else {
  loadTenants()
    .then((tenants) => {
      const start = startOf(tenants);
      if (!('tenant' in start)) render(<StartPages tenants={tenants} screen={start.screen} unknownFromUrl={start.unknownFromUrl} />);
      else if (start.tenant === EXAMPLES_TENANT) render(<App tenants={tenants} session={null} />);
      else return startTenant(start.tenant, tenants);
    })
    .catch((e: unknown) => {
      console.error(e);
      render(<FatalError title={`${APP_NAME} couldn't start`} message="Reload the page to try again. If it keeps happening, contact the site's maintainer." action={tryAgain} />);
    });
}
