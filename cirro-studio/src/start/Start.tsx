// The pages before the app: the landing page, the log-in box for a Cirro tenant, and
// what is shown when starting fails. The first two move between each other without
// reloading, so the backdrop carries on.
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { APP_NAME, CIRRO_URL, DOCS_URL, REPO_URL } from '../app/appInfo';
import {
  SUGGEST_AFTER, chooseTenant, hostOf, lastTenant, openExamples, showLanding, startScreenOf, startUrl, suggestTenants, tenantNamed,
  type StartScreen, type Tenant,
} from '../tenants';
import Backdrop from './Backdrop';


function Footer() {
  return (
    <footer className="start-footer">
      <a href={DOCS_URL}>About</a>
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

function Landing({ onSignIn }: { onSignIn: () => void }) {
  return (
    <>
      <h1 className="start-title">{APP_NAME}</h1>
      <p className="start-lede">
        Spatial omics in your browser: open tissue sections cell by cell, find what sets regions and cell types apart,
        and save each step as a version on top of the data.
      </p>
      <div className="start-choices">
        <button type="button" className="start-choice" onClick={openExamples}>
          <ExamplesIcon />
          <span className="start-choice-title">Public Data</span>
          <span className="start-choice-text">Xenium and Visium sections, ready to open. No account needed.</span>
        </button>
        <button type="button" className="start-choice" onClick={onSignIn}>
          <SignInIcon />
          <span className="start-choice-title">Private Data (Cirro)</span>
          <span className="start-choice-text">Your projects: images, instrument runs and SpatialData, with versions saved back to Cirro.</span>
        </button>
      </div>
      <a className="start-about" href={DOCS_URL}>About {APP_NAME} <span aria-hidden="true">→</span></a>
    </>
  );
}

// The user names their Cirro: the box suggests listed tenants once SUGGEST_AFTER
// characters are typed, and takes any Cirro's address.
function SignIn({ tenants, unknownFromUrl, onBack }: { tenants: Tenant[]; unknownFromUrl?: string; onBack: () => void }) {
  const [text, setText] = useState(() => lastTenant(tenants)?.name ?? '');
  // The suggestion list opens on typing and closes on a pick, Escape or leaving the box.
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const choice = tenantNamed(text, tenants);
  const typed = text.trim().length >= SUGGEST_AFTER;
  // Nothing to suggest once the box already names the one tenant the list would show; it
  // would only cover the button below.
  const matches = open ? suggestTenants(text, tenants) : [];
  const suggestions = matches.length === 1 && matches[0] === choice ? [] : matches;
  const pick = (t: Tenant) => {
    setText(t.name);
    setOpen(false);
    setActive(-1);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!suggestions.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(suggestions[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };
  return (
    <form
      className="card start-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (choice) chooseTenant(choice);
      }}
    >
      <h2>Log In (Cirro)</h2>
      {unknownFromUrl && (
        <p role="alert" className="notice notice-warning">
          The link named <code>{unknownFromUrl}</code>, which this site doesn't connect to.
        </p>
      )}
      <div className="popover start-tenant">
        <label className="field">
          <span>Your organization's Cirro</span>
          <input
            className="input"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            aria-controls="start-tenant-options"
            aria-activedescendant={active >= 0 && suggestions[active] ? `start-tenant-${suggestions[active].id}` : undefined}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onKeyDown={onKey}
            onBlur={() => setOpen(false)}
            placeholder="Its name or address"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </label>
        {suggestions.length > 0 && (
          <ul id="start-tenant-options" role="listbox" className="popover-panel popover-left menu start-tenant-options">
            {suggestions.map((t, i) => (
              <li
                key={t.id}
                id={`start-tenant-${t.id}`}
                role="option"
                aria-selected={i === active}
                className="menu-item"
                // Before the box's blur, which would close the list first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(t);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span>{t.name}</span>
                <span className="muted">{hostOf(t)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {typed && !choice && !suggestions.length && <p className="muted">Pick a suggestion, or type the address you use for Cirro, such as cirro.example.org.</p>}
      <p className="muted">You'll sign in on Cirro's own page, which shows what this app may do.</p>
      <button type="submit" className="button button-primary" disabled={!choice}>{choice ? `Log in to ${choice.name}` : 'Log in'}</button>
      <button type="button" className="link-button" onClick={onBack}>← Back</button>
    </form>
  );
}

export function StartPages({ tenants, screen: first, unknownFromUrl }: { tenants: Tenant[]; screen: StartScreen; unknownFromUrl?: string }) {
  const [screen, setScreen] = useState(first);
  useEffect(() => {
    const onPop = () => setScreen(startScreenOf(new URLSearchParams(window.location.search)));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = (next: StartScreen) => {
    window.history.pushState(null, '', startUrl(next));
    setScreen(next);
  };
  return (
    <Frame>
      {screen === 'sign-in'
        ? <SignIn tenants={tenants} unknownFromUrl={unknownFromUrl} onBack={() => go('landing')} />
        : <Landing onSignIn={() => go('sign-in')} />}
    </Frame>
  );
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
