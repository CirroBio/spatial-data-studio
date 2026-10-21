// The pages before the app: the landing page, the choice of tenant to log in to, and
// what is shown when starting fails.
import type { ReactNode } from 'react';
import { APP_NAME, CIRRO_URL, DOCS_URL, REPO_URL } from '../app/appInfo';
import { chooseTenant, openExamples, showLanding, showSignIn, type StartScreen, type Tenant } from '../tenants';
import Backdrop from './Backdrop';


function Footer() {
  return (
    <footer className="start-footer">
      <a href={DOCS_URL} target="_blank" rel="noreferrer">How it works</a>
      <span aria-hidden="true">·</span>
      <a href={REPO_URL} target="_blank" rel="noreferrer">Source</a>
      <span aria-hidden="true">·</span>
      <a href={CIRRO_URL} target="_blank" rel="noreferrer">Cirro</a>
    </footer>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="start">
      <Backdrop />
      <div className="start-hero">{children}</div>
      <Footer />
    </main>
  );
}

const ExamplesIcon = () => (
  <svg viewBox="0 0 36 36" className="start-choice-icon" aria-hidden="true">
    {[[9, 12], [15, 8], [21, 11], [27, 9], [11, 19], [18, 17], [25, 20], [14, 26], [22, 27]].map(([x, y], i) => (
      <circle key={i} cx={x} cy={y} r={2.6} fill="currentColor" opacity={0.35 + (i % 3) * 0.25} />
    ))}
    <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

const SignInIcon = () => (
  <svg viewBox="0 0 36 36" className="start-choice-icon" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 7h7a2 2 0 0 1 2 2v18a2 2 0 0 1-2 2h-7" />
    <path d="M7 18h15M17 12l6 6-6 6" />
  </svg>
);

function Landing({ hasTenants }: { hasTenants: boolean }) {
  return (
    <Frame>
      <h1 className="start-title">{APP_NAME}</h1>
      <p className="start-lede">
        Spatial omics in your browser: open tissue sections cell by cell, find what sets regions and cell types apart,
        and save each step as a version on top of the data.
      </p>
      <div className="start-choices">
        <button type="button" className="start-choice" onClick={openExamples}>
          <ExamplesIcon />
          <span className="start-choice-title">Explore example data</span>
          <span className="start-choice-text">Xenium and Visium sections, ready to open. No account needed.</span>
        </button>
        <button type="button" className="start-choice" onClick={showSignIn} disabled={!hasTenants}>
          <SignInIcon />
          <span className="start-choice-title">Log In with Cirro</span>
          <span className="start-choice-text">
            {hasTenants ? 'Your projects: images, instrument runs and SpatialData, with versions saved back to Cirro.' : 'No Cirro is connected to this site yet.'}
          </span>
        </button>
      </div>
    </Frame>
  );
}

function SignIn({ tenants, unknownFromUrl }: { tenants: Tenant[]; unknownFromUrl?: string }) {
  return (
    <Frame>
      <div className="card start-card">
        <h2>Log in with Cirro</h2>
        {unknownFromUrl && <p className="notice notice-warning">This site isn't connected to the Cirro called "{unknownFromUrl}".</p>}
        <p className="muted">Choose your organization's Cirro. You'll sign in on Cirro's own page, which shows what this app may do.</p>
        <ul className="start-tenants">
          {tenants.map((t) => (
            <li key={t.id}>
              <button type="button" className="button start-tenant" onClick={() => chooseTenant(t)}>
                <span>{t.name}</span>
                <span className="muted">{new URL(t.url).host}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="link-button" onClick={showLanding}>← Back</button>
      </div>
    </Frame>
  );
}

export function StartPages({ tenants, screen, unknownFromUrl }: { tenants: Tenant[]; screen: StartScreen; unknownFromUrl?: string }) {
  return screen === 'sign-in'
    ? <SignIn tenants={tenants} unknownFromUrl={unknownFromUrl} />
    : <Landing hasTenants={tenants.length > 0} />;
}

export function SignInPage({ tenantName, onSignIn }: { tenantName: string; onSignIn: () => void }) {
  return (
    <Frame>
      <div className="card start-card">
        <h2>Log in to {tenantName}</h2>
        <p className="muted">Your session has ended, or this tab hasn't signed in yet.</p>
        <div className="button-row">
          <button type="button" className="button button-primary" onClick={onSignIn}>Log in</button>
          <button type="button" className="button" onClick={showLanding}>Start page</button>
        </div>
      </div>
    </Frame>
  );
}

export function FatalError({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return (
    <main className="centered-page">
      <div className="card start-card" role="alert">
        <h2>{title}</h2>
        <p>{message}</p>
        {action}
      </div>
    </main>
  );
}
