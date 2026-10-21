// What sign-in leaves in this browser, readable without the sign-in library, so a page
// that never signs in (the examples, the landing page) doesn't load it.
import { appKey } from './app/appInfo';

// Sign-in returns here, and the registration must list it character for character:
// the bare origin when the app is served at a site's root (http://localhost:5171), the
// folder it is served from otherwise (https://cirrobio.github.io/spatial-data-studio/app/).
const APP_PATH = window.location.pathname.replace(/index\.html$/, '');
export const REDIRECT_URI = APP_PATH === '/' ? window.location.origin : window.location.origin + APP_PATH;

// The tenant this tab is signing in to. The saved tenant choice is shared by every tab,
// so another tab can change it while this one is at Cirro's authorize page.
export const SIGN_IN_TENANT_KEY = appKey('sign-in-tenant');

const isSignInReturn = (params: URLSearchParams) => params.has('state') && (params.has('code') || params.has('error'));

export function signInReturnTenant(): string | null {
  return isSignInReturn(new URLSearchParams(window.location.search)) ? window.sessionStorage.getItem(SIGN_IN_TENANT_KEY) : null;
}

/** A failed return from sign-in (?error=), usually a registration that doesn't match.
 * Shown rather than retried, which would fail the same way in a loop. Only a return to a
 * sign-in this browser started counts (oidc-client-ts keeps its pending state under
 * oidc.<state>), so a crafted link can't put its own text on the page. */
export function signInError(): string | null {
  const params = new URLSearchParams(window.location.search);
  const state = params.get('state');
  if (!params.has('error') || !state || window.sessionStorage.getItem(`oidc.${state}`) === null) return null;
  return params.get('error_description') ?? params.get('error');
}

export function hasSignedInUser(tenantUrl: string, clientId: string): boolean {
  try {
    return window.sessionStorage.getItem(`oidc.user:${tenantUrl}:${clientId}`) !== null;
  } catch {
    return false;
  }
}
