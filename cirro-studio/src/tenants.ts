// Runtime tenant registry: tenants.json lists the Cirro tenants the log-in box suggests.
// Edited on the host, never built in. The app asks each tenant for its client ID by
// callback URL, unless the entry gives one (a registration without discovery, such as a
// development one), so the user may also type the address of a Cirro the list doesn't name.
import { appKey } from './app/appInfo';
import { hasSignedInUser, isSignInReturn, signInReturnTenant } from './signInState';

export interface Tenant {
  id: string;
  name: string;
  // The tenant's web address: the API is at /api under it, sign-in at /authorize, and
  // items open in Cirro under it.
  url: string;
  clientId?: string;
  addedAt?: string;
  contact?: string;
}

// A tenant's address is an https origin; plain http only for one on this machine.
const TENANT_URL = /^(https:\/\/[^/]+|http:\/\/localhost(:\d+)?)\/?$/;
// The tenant the app opens in. Cleared on log-out.
const TENANT_KEY = appKey('tenant');
// The tenant last chosen in the log-in box, which fills it next time. Kept after log-out.
const LAST_TENANT_KEY = appKey('last-tenant');
const SIGN_IN_NOW_KEY = appKey('sign-in-now');
const SIGN_IN_PARAM = 'sign-in';
// Suggestions appear once this much is typed, so the box doesn't list every tenant to anyone.
export const SUGGEST_AFTER = 3;
// The example collection, open without an account; it stands where a tenant would.
export const EXAMPLES_TENANT = 'examples';

export async function loadTenants(): Promise<Tenant[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}tenants.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load tenants.json (HTTP ${res.status}).`);
  const { tenants } = await res.json();
  // An empty list is a site that suggests no tenant; any Cirro's address still works.
  if (!Array.isArray(tenants)) throw new Error('tenants.json has no tenants list.');
  for (const t of tenants) {
    if (!t.id || !t.url) throw new Error(`tenants.json entry ${JSON.stringify(t.id ?? t)} needs id and url.`);
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

const hasSession = (t: Tenant) => hasSignedInUser(t.url);

export const hostOf = (t: Tenant) => new URL(t.url).host;

// What the user typed, as a host when it is an address.
const bare = (text: string) => text.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');

// A Cirro the list doesn't name, typed as its address; its id is its host.
function typedTenant(text: string): Tenant | null {
  const host = bare(text);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return { id: host, name: host, url: `https://${host}` };
}

// A tenant by its id: a listed one, or one the user typed (whose id is its address).
const byId = (id: string | null, tenants: Tenant[]) => (id ? tenants.find((t) => t.id === id) ?? typedTenant(id) ?? undefined : undefined);

const names = (t: Tenant) => [t.id, t.name, hostOf(t)].map((s) => s.toLowerCase());

/** The tenant the log-in box names: a listed one by name, id or address, or another
 * Cirro's address. */
export function tenantNamed(text: string, tenants: Tenant[]): Tenant | null {
  const q = bare(text);
  return tenants.find((t) => names(t).includes(q)) ?? typedTenant(q);
}

export function suggestTenants(text: string, tenants: Tenant[]): Tenant[] {
  const q = text.trim().toLowerCase();
  return q.length < SUGGEST_AFTER ? [] : tenants.filter((t) => names(t).some((n) => n.includes(q)));
}

/** What the log-in box starts with: the tenant chosen there last time. */
export function lastTenant(tenants: Tenant[]): Tenant | undefined {
  try {
    return byId(localStorage.getItem(LAST_TENANT_KEY), tenants);
  } catch {
    return undefined;
  }
}

export function takeSignInNow(): boolean {
  const now = window.sessionStorage.getItem(SIGN_IN_NOW_KEY) !== null;
  window.sessionStorage.removeItem(SIGN_IN_NOW_KEY);
  return now;
}

export type StartScreen = 'landing' | 'sign-in';
export type Start = { tenant: Tenant | typeof EXAMPLES_TENANT } | { screen: StartScreen; unknownFromUrl?: string };

/** The start page a URL asks for. */
export const startScreenOf = (params: URLSearchParams): StartScreen => (params.has(SIGN_IN_PARAM) ? 'sign-in' : 'landing');

/** Where a page load starts. The `tenant` URL parameter (context from another app) wins
 * over the saved choice, and a return from sign-in goes to the tenant this tab signed in
 * to; someone signed in to a tenant goes back to it; anyone else starts on the landing
 * page, unless the URL asks for the log-in box. */
export function startOf(tenants: Tenant[]): Start {
  const params = new URLSearchParams(window.location.search);
  const screen = startScreenOf(params);
  if (screen !== 'landing') return { screen };
  const fromUrl = params.get('tenant');
  if (fromUrl === EXAMPLES_TENANT) return { tenant: EXAMPLES_TENANT };
  if (fromUrl) {
    // A typed tenant only by the user's own choice, so a link can't send them to a
    // look-alike host.
    const t = tenants.find((x) => x.id === fromUrl) ?? (fromUrl === readSaved() ? typedTenant(fromUrl) : null);
    if (t) {
      localStorage.setItem(TENANT_KEY, t.id);
      return { tenant: t };
    }
    return { screen: 'sign-in', unknownFromUrl: fromUrl };
  }
  // The saved tenant opens only for someone still logged in to it, or coming back from its
  // sign-in; anyone else gets the landing page, and the log-in box remembers their choice.
  const saved = byId(readSaved(), tenants);
  const tenant = byId(signInReturnTenant(), tenants)
    ?? (saved && (isSignInReturn(params) || hasSession(saved)) ? saved : undefined)
    ?? tenants.find(hasSession);
  return tenant ? { tenant } : { screen: 'landing' };
}

/** The start pages' address, without whatever the app had in the URL. */
export function startUrl(screen: StartScreen): string {
  const url = new URL(window.location.pathname, window.location.href);
  if (screen === 'sign-in') url.searchParams.set(SIGN_IN_PARAM, '');
  return url.toString().replace(/=$/, '');
}

function openWith(params: Record<string, string>) {
  const url = new URL(window.location.pathname, window.location.href);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  window.location.assign(url.toString());
}

/** Logging in starts with the choice of tenant: a deployment can serve several. */
export const showSignIn = () => window.location.assign(startUrl('sign-in'));
export const showLanding = () => window.location.assign(startUrl('landing'));
export const openExamples = () => openWith({ tenant: EXAMPLES_TENANT, project: EXAMPLES_TENANT });

export function chooseTenant(t: Tenant) {
  localStorage.setItem(TENANT_KEY, t.id);
  localStorage.setItem(LAST_TENANT_KEY, t.id);
  window.sessionStorage.setItem(SIGN_IN_NOW_KEY, '1');
  // Sign-in and the API client are made once per page, for one tenant.
  openWith({ tenant: t.id });
}

export function forgetTenant() {
  localStorage.removeItem(TENANT_KEY);
}
