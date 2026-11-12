// Google Analytics for what the Pages deploy publishes: the web app, the viewer and the
// docs. docs.yml builds them with VITE_GA_MEASUREMENT_ID set; every other build (local
// dev, the release's viewer-dist, the Analysis Workspace image) passes no ID and reports
// nothing.
//
// No Google code runs here: Google's script would share the page with the Cirro sign-in
// and could read it. Each page view is one request to the endpoint gtag.js itself sends
// to. That endpoint is not documented, so a change on Google's side stops the counts
// without an error; the documented Measurement Protocol needs a secret a browser can't
// keep. GA is given a page's address without its query or hash, which carry the sign-in
// code on the return from Cirro, store addresses (`open`, `checkpoint`), the tenant and
// search text.

const COLLECT_URL = 'https://www.google-analytics.com/g/collect';
const VISITOR_KEY = 'spatial-data-studio.analytics-visitor';
// GA's own: a page view this long after the last starts a new session.
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// What GA needs to count visitors and sessions. `client` is a random ID made here, not
// derived from anything about the person.
interface Visitor {
  client: string;
  session: number;
  sessions: number;
  lastHit: number;
}

function addressOnly(href: string): string {
  const url = new URL(href);
  return url.origin + url.pathname;
}

/** Report the page now showing; nothing when `measurementId` is unset. */
export function reportPageView(measurementId: string | undefined): void {
  if (!measurementId) return;
  const now = Date.now();
  const stored = localStorage.getItem(VISITOR_KEY);
  const before: Visitor | null = stored ? JSON.parse(stored) : null;
  const newSession = before === null || now - before.lastHit > SESSION_TIMEOUT_MS;
  const seconds = Math.floor(now / 1000);
  const visitor: Visitor = {
    // GA's own format: a random number and the first visit's time in seconds.
    client: before?.client ?? `${Math.floor(Math.random() * 2 ** 31)}.${seconds}`,
    session: newSession ? seconds : before.session,
    sessions: (before?.sessions ?? 0) + (newSession ? 1 : 0),
    lastHit: now,
  };
  localStorage.setItem(VISITOR_KEY, JSON.stringify(visitor));

  const hit = new URLSearchParams({
    v: '2',
    tid: measurementId,
    cid: visitor.client,
    sid: String(visitor.session),
    sct: String(visitor.sessions),
    en: 'page_view',
    dl: addressOnly(window.location.href),
    dt: document.title,
    ul: navigator.language.toLowerCase(),
    sr: `${screen.width}x${screen.height}`,
  });
  if (before === null) hit.set('_fv', '1');
  if (newSession) {
    hit.set('_ss', '1');
    // Where the visit came from counts once, when it starts.
    if (document.referrer) hit.set('dr', addressOnly(document.referrer));
  }
  navigator.sendBeacon(`${COLLECT_URL}?${hit}`);
}
