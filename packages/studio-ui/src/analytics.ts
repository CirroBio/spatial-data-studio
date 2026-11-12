// Google Analytics for what the Pages deploy publishes: the web app, the viewer and the
// docs. docs.yml builds them with VITE_GA_MEASUREMENT_ID set; every other build (local
// dev, the release's viewer-dist, the Analysis Workspace image) passes no ID and reports
// nothing.
//
// GA is given a page's address without its query or hash. The web app's and the viewer's
// carry the sign-in code on the return from Cirro, store addresses (`open`, `checkpoint`),
// the tenant and search text. This holds only while the GA stream's "page changes based
// on browser history events" is off: GA's own page views read the full address.

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

const GTAG_URL = 'https://www.googletagmanager.com/gtag/js';

let started = false;

function gtag(..._args: unknown[]): void {
  // gtag.js reads Arguments objects off the queue; an array of the same values is ignored.
  (window.dataLayer ??= []).push(arguments);
}

function addressOnly(href: string): string {
  const url = new URL(href);
  return url.origin + url.pathname;
}

/** Load gtag.js for `measurementId`, sending nothing until a page view is reported. */
export function startAnalytics(measurementId: string | undefined): void {
  if (!measurementId) return;
  started = true;
  gtag('js', new Date());
  gtag('config', measurementId, { send_page_view: false });
  const script = document.createElement('script');
  script.async = true;
  script.src = `${GTAG_URL}?id=${encodeURIComponent(measurementId)}`;
  document.head.append(script);
}

/** Report the page now showing; nothing unless startAnalytics was given an ID. */
export function reportPageView(): void {
  if (!started) return;
  // `set`, not event parameters, so GA's own events (engagement, scrolls) carry the
  // stripped address too.
  gtag('set', {
    page_location: addressOnly(window.location.href),
    page_referrer: document.referrer && addressOnly(document.referrer),
  });
  gtag('event', 'page_view');
}
