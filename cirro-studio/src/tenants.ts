// Runtime tenant registry: tenants.json lists each Cirro tenant's web address and the
// client ID its admins issued for this app. Edited on the host, never built in.
import { appKey } from './app/appInfo';
import { hasSignedInUser, signInReturnTenant } from './signInState';

export interface Tenant {
  id: string;
  name: string;
  // The tenant's web address: the API is at /api under it, sign-in at /authorize, and
  // items open in Cirro under it.
  url: string;
  clientId: string;
  addedAt?: string;
  contact?: string;
}

// A tenant's address is an https origin; plain http only for one on this machine.
const TENANT_URL = /^(https:\/\/[^/]+|http:\/\/localhost(:\d+)?)\/?$/;
const TENANT_KEY = appKey('tenant');
const SIGN_IN_NOW_KEY = appKey('sign-in-now');
// The example collection, open without an account; it stands where a tenant would.
export const EXAMPLES_TENANT = 'examples';

export async function loadTenants(): Promise<Tenant[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}tenants.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load tenants.json (HTTP ${res.status}).`);
  const { tenants } = await res.json();
  // An empty list is a site that shows only the examples.
  if (!Array.isArray(tenants)) throw new Error('tenants.json has no tenants list.');
  for (const t of tenants) {
    if (!t.id || !t.url || !t.clientId) throw new Error(`tenants.json entry ${JSON.stringify(t.id ?? t)} needs id, url and clientId.`);
    if (!TENANT_URL.test(t.url)) throw new Error(`tenants.json entry ${JSON.stringify(t.id)} has url ${t.url}; it must be an https address with no path.`);
    if (t.id === EXAMPLES_TENANT) throw new Error(`tenants.json can't use the id "${EXAMPLES_TENANT}"; the app keeps it for its examples.`);
  }
  return tenants.map((t: Tenant) => ({ ...t, url: t.url.replace(/\/$/, '') }));
}

function readSaved(): string | null {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}

export function takeSignInNow(): boolean {
  const now = window.sessionStorage.getItem(SIGN_IN_NOW_KEY) !== null;
  window.sessionStorage.removeItem(SIGN_IN_NOW_KEY);
  return now;
}

export type StartScreen = 'landing' | 'sign-in';
export type Start = { tenant: Tenant | typeof EXAMPLES_TENANT } | { screen: StartScreen; unknownFromUrl?: string };

/** Where a page load starts. The `tenant` URL parameter (context from another app) wins
 * over the saved choice, and a return from sign-in goes to the tenant this tab signed in
 * to; someone signed in to a tenant goes back to it; anyone else starts on the landing
 * page. */
export function startOf(tenants: Tenant[]): Start {
  const params = new URLSearchParams(window.location.search);
  if (params.has('sign-in')) return { screen: 'sign-in' };
  const fromUrl = params.get('tenant');
  if (fromUrl === EXAMPLES_TENANT) return { tenant: EXAMPLES_TENANT };
  if (fromUrl) {
    const t = tenants.find((x) => x.id === fromUrl);
    if (t) {
      localStorage.setItem(TENANT_KEY, t.id);
      return { tenant: t };
    }
    return { screen: 'sign-in', unknownFromUrl: fromUrl };
  }
  const returnTenant = signInReturnTenant();
  const saved = tenants.find((t) => t.id === returnTenant)
    ?? tenants.find((t) => t.id === readSaved())
    ?? tenants.find((t) => hasSignedInUser(t.url, t.clientId));
  return saved ? { tenant: saved } : { screen: 'landing' };
}

function startUrl(params: Record<string, string>): string {
  const url = new URL(window.location.pathname, window.location.href);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString().replace(/=(&|$)/g, '$1');
}

/** Logging in starts with the choice of tenant: a deployment can serve several. */
export const showSignIn = () => window.location.assign(startUrl({ 'sign-in': '' }));
export const showLanding = () => window.location.assign(startUrl({}));
export const openExamples = () => window.location.assign(startUrl({ tenant: EXAMPLES_TENANT, project: EXAMPLES_TENANT }));

export function chooseTenant(t: Tenant) {
  localStorage.setItem(TENANT_KEY, t.id);
  window.sessionStorage.setItem(SIGN_IN_NOW_KEY, '1');
  // Sign-in and the API client are made once per page, for one tenant.
  window.location.assign(startUrl({ tenant: t.id }));
}

export function forgetTenant() {
  localStorage.removeItem(TENANT_KEY);
}
