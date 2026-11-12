// Google Analytics for what the Pages deploy publishes: the web app, the viewer and the
// docs. docs.yml builds them with VITE_GA_MEASUREMENT_ID set; every other build (local
// dev, the release's viewer-dist, the Analysis Workspace image) passes no ID and reports
// nothing.
//
// No Google code runs here: Google's script would share the page with the Cirro sign-in
// and could read it. Each event is one request to the endpoint gtag.js itself sends to.
// That endpoint is not documented, so a change on Google's side stops the counts without
// an error; the documented Measurement Protocol needs a secret a browser can't keep. GA is
// given a page's address without its query or hash, which carry the sign-in code on the
// return from Cirro, store addresses (`open`, `checkpoint`), the tenant and search text.
//
// Besides page views, each page's time in view goes out as a `user_engagement` event when
// the page is hidden, left or replaced: GA counts a returning visitor as an active user
// only once it has engagement time.

const COLLECT_URL = 'https://www.google-analytics.com/g/collect';
const VISITOR_KEY = 'spatial-data-studio.analytics-visitor';
// GA's own: an event this long after the last starts a new session.
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
// GA's own: a session is engaged after this long in view, or at its second page view.
const ENGAGED_SESSION_MS = 10 * 1000;

// What GA needs to count visitors and sessions. `client` is a random ID made here, not
// derived from anything about the person.
interface Visitor {
  client: string;
  session: number;
  sessions: number;
  // This session's page views and time in view, which make it engaged.
  views: number;
  engagedMs: number;
  lastHit: number;
}

// The page last reported, whose time in view is counted until the next one.
let page: { measurementId: string; location: string; title: string } | null = null;
let visibleSince: number | null = null;

function addressOnly(href: string): string {
  const url = new URL(href);
  return url.origin + url.pathname;
}

// The stored visitor at `now`, in a new session once SESSION_TIMEOUT_MS has passed without
// an event.
function visitorAt(now: number): { visitor: Visitor; first: boolean; newSession: boolean } {
  const stored = localStorage.getItem(VISITOR_KEY);
  const before: Visitor | null = stored ? JSON.parse(stored) : null;
  const seconds = Math.floor(now / 1000);
  const newSession = before === null || now - before.lastHit > SESSION_TIMEOUT_MS;
  const visitor: Visitor = newSession
    ? {
        // GA's own format: a random number and the first visit's time in seconds.
        client: before?.client ?? `${Math.floor(Math.random() * 2 ** 31)}.${seconds}`,
        session: seconds,
        sessions: (before?.sessions ?? 0) + 1,
        views: 0,
        engagedMs: 0,
        lastHit: now,
      }
    // A visitor stored before engagement was counted has no views or engagedMs.
    : { ...before, views: before.views ?? 0, engagedMs: before.engagedMs ?? 0, lastHit: now };
  return { visitor, first: before === null, newSession };
}

function send(measurementId: string, params: Record<string, string>, views: number, engagedMs: number): void {
  const { visitor, first, newSession } = visitorAt(Date.now());
  visitor.views += views;
  visitor.engagedMs += engagedMs;
  localStorage.setItem(VISITOR_KEY, JSON.stringify(visitor));

  const hit = new URLSearchParams({
    v: '2',
    tid: measurementId,
    cid: visitor.client,
    sid: String(visitor.session),
    sct: String(visitor.sessions),
    seg: visitor.views > 1 || visitor.engagedMs >= ENGAGED_SESSION_MS ? '1' : '0',
    ul: navigator.language.toLowerCase(),
    sr: `${screen.width}x${screen.height}`,
    ...params,
  });
  if (first) hit.set('_fv', '1');
  if (newSession) {
    hit.set('_ss', '1');
    // Where the visit came from counts once, when it starts.
    if (document.referrer) hit.set('dr', addressOnly(document.referrer));
  }
  navigator.sendBeacon(`${COLLECT_URL}?${hit}`);
}

// Report the reported page's time in view since it was shown or last reported.
function reportEngagement(): void {
  if (page === null || visibleSince === null) return;
  const now = Date.now();
  const inView = now - visibleSince;
  visibleSince = document.visibilityState === 'visible' ? now : null;
  send(page.measurementId, { en: 'user_engagement', _et: String(inView), dl: page.location, dt: page.title }, 0, inView);
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') reportEngagement();
  else visibleSince = Date.now();
}

// Safari can leave a page without hiding it first.
function onPageHide(): void {
  reportEngagement();
  visibleSince = null;
}

/** Report the page now showing; nothing when `measurementId` is unset. */
export function reportPageView(measurementId: string | undefined): void {
  if (!measurementId) return;
  if (page === null) {
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
  } else {
    reportEngagement();
  }
  page = { measurementId, location: addressOnly(window.location.href), title: document.title };
  visibleSince = document.visibilityState === 'visible' ? Date.now() : null;
  send(measurementId, { en: 'page_view', dl: page.location, dt: page.title }, 1, 0);
}
