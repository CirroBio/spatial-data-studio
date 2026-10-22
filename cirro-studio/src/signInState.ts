// What sign-in leaves in this browser, readable without the sign-in library, so a page
// that never signs in (the examples, the landing page) doesn't load it.
import { appKey } from './app/appInfo';

// Sign-in returns here. The tenant finds the app's registration by it, so it is unique to
// the app, and the registration must list it character for character: the bare origin
// when the app is served at a site's root (http://localhost:5171), the folder it is
// served from otherwise (https://cirrobio.github.io/spatial-data-studio/).
const APP_PATH = window.location.pathname.replace(/index\.html$/, '');
export const REDIRECT_URI = APP_PATH === '/' ? window.location.origin : window.location.origin + APP_PATH;

// The tenant this tab is signing in to. The saved tenant choice is shared by every tab,
// so another tab can change it while this one is at Cirro's authorize page.
export const SIGN_IN_TENANT_KEY = appKey('sign-in-tenant');

export const isSignInReturn = (params: URLSearchParams) => params.has('state') && (params.has('code') || params.has('error'));

export function signInReturnTenant(): string | null {
  return isSignInReturn(new URLSearchParams(window.location.search)) ? window.sessionStorage.getItem(SIGN_IN_TENANT_KEY) : null;
}

/** A failed return from sign-in (?error=), usually a registration that doesn't match.
 * Shown rather than retried, which would fail the same way in a loop. Only a return to a
 * sign-in this browser started counts (oidc-client-ts keeps its pending state in
 * localStorage under oidc.<state>), so a crafted link can't put its own text on the page. */
export function signInError(): string | null {
  const params = new URLSearchParams(window.location.search);
  const state = params.get('state');
  if (!params.has('error') || !state || window.localStorage.getItem(`oidc.${state}`) === null) return null;
  return params.get('error_description') ?? params.get('error');
}

// The logins stored for a tenant in this tab: oidc-client-ts keeps the user under
// oidc.user:<authority>:<client id>, and the authority is the tenant's URL. The client ID
// may only be known once the tenant is asked, so any one counts.
function storedUserKeys(tenantUrl: string): string[] {
  const prefix = `oidc.user:${tenantUrl}:`;
  const store = window.sessionStorage;
  return Array.from({ length: store.length }, (_, i) => store.key(i)).filter((k): k is string => !!k?.startsWith(prefix));
}

export function hasSignedInUser(tenantUrl: string): boolean {
  try {
    return storedUserKeys(tenantUrl).length > 0;
  } catch {
    return false;
  }
}

/** Forgets every login stored for this tenant, whichever registration it was made under:
 * one from a registration since replaced would otherwise keep reopening the tenant. */
export function forgetStoredUsers(tenantUrl: string) {
  for (const k of storedUserKeys(tenantUrl)) window.sessionStorage.removeItem(k);
}
