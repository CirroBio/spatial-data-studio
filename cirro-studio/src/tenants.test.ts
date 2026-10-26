import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tenant } from './tenants';

// Just enough of a browser for startOf: an address and the two storages.
function storage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: (k) => items.get(k) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (k) => void items.delete(k),
    setItem: (k, v) => void items.set(k, String(v)),
  };
}

const location = new URL('http://localhost:5171/');
const localStorage = storage();
const sessionStorage = storage();
vi.stubGlobal('localStorage', localStorage);
vi.stubGlobal('window', { location, localStorage, sessionStorage });

const { chooseTenant, lastTenant, loadTenants, startOf, suggestTenants, tenantNamed } = await import('./tenants');
const { forgetStoredUsers, hasSignedInUser, signInError } = await import('./signInState');

const tenant = (id: string): Tenant => ({ id, name: id, url: `https://${id}.cirro.bio` });
const tenants = [tenant('a'), tenant('b')];
// Where oidc-client-ts keeps a signed-in user: sessionStorage, under the tenant and the
// client ID the tenant gave.
const signedIn = (t: Tenant) => sessionStorage.setItem(`oidc.user:${t.url}:client-${t.id}`, '{}');

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('spatial-data-studio.tenant', 'b');
  sessionStorage.setItem('spatial-data-studio.sign-in-tenant', 'a');
  location.search = '';
});

describe('startOf', () => {
  it('returns from sign-in to the tenant this tab signed in to, not the one saved since', () => {
    location.search = '?code=x&state=y';
    expect(startOf(tenants)).toEqual({ tenant: tenants[0] });
  });

  it('does the same for a failed return', () => {
    location.search = '?error=access_denied&state=y';
    expect(startOf(tenants)).toEqual({ tenant: tenants[0] });
  });

  it('opens the saved tenant on other page loads only while logged in to it', () => {
    expect(startOf(tenants)).toEqual({ screen: 'landing' });
    signedIn(tenants[1]);
    expect(startOf(tenants)).toEqual({ tenant: tenants[1] });
  });

  it('falls back to the saved tenant when this tab\'s tenant is no longer listed', () => {
    sessionStorage.setItem('spatial-data-studio.sign-in-tenant', 'gone');
    location.search = '?code=x&state=y';
    expect(startOf(tenants)).toEqual({ tenant: tenants[1] });
  });

  it('opens the examples and the log-in box by their URLs', () => {
    location.search = '?tenant=examples&project=examples';
    expect(startOf(tenants)).toEqual({ tenant: 'examples' });
    location.search = '?sign-in';
    expect(startOf(tenants)).toEqual({ screen: 'sign-in' });
  });
});

describe('signInError', () => {
  it('shows a failed return only to a sign-in this browser started', () => {
    location.search = '?error=access_denied&error_description=Not+registered&state=s1';
    expect(signInError()).toBeNull();
    // oidc-client-ts keeps its pending state in localStorage, whatever store holds the user.
    localStorage.setItem('oidc.s1', '{}');
    expect(signInError()).toBe('Not registered');
  });
});

describe('forgetStoredUsers', () => {
  it('forgets every login stored for a tenant, under any registration, and no other tenant\'s', () => {
    signedIn(tenants[0]);
    sessionStorage.setItem('oidc.user:https://a.cirro.bio:an-older-client', '{}');
    signedIn(tenants[1]);
    forgetStoredUsers(tenants[0].url);
    expect(hasSignedInUser(tenants[0].url)).toBe(false);
    expect(hasSignedInUser(tenants[1].url)).toBe(true);
  });
});

describe('loadTenants', () => {
  const listing = (entry: Record<string, string>) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ tenants: [{ id: 'a', name: 'A', ...entry }] })));
    return loadTenants();
  };

  it('accepts https addresses and a tenant on this machine, without the trailing slash, and no client ID', async () => {
    expect((await listing({ url: 'https://a.cirro.bio/' }))[0].url).toBe('https://a.cirro.bio');
    expect((await listing({ url: 'http://localhost:8080', clientId: 'c' }))[0].url).toBe('http://localhost:8080');
  });

  it('rejects plain http, other schemes and paths', async () => {
    for (const url of ['http://a.cirro.bio', 'http://localhost.evil.com', 'javascript:alert(1)', 'https://a.cirro.bio/api']) {
      await expect(listing({ url })).rejects.toThrow('must be an https address');
    }
  });

  it('takes a client ID from the local settings for a tenant whose entry has none', async () => {
    vi.stubEnv('VITE_TENANT_CLIENT_IDS', 'b:other,a:local-id');
    expect((await listing({ url: 'https://a.cirro.bio' }))[0].clientId).toBe('local-id');
    expect((await listing({ url: 'https://a.cirro.bio', clientId: 'listed' }))[0].clientId).toBe('listed');
    vi.unstubAllEnvs();
    expect((await listing({ url: 'https://a.cirro.bio' }))[0].clientId).toBeUndefined();
  });

  it('keeps the examples\' id for the examples', async () => {
    await expect(listing({ id: 'examples', url: 'https://a.cirro.bio' })).rejects.toThrow('keeps it for its examples');
  });
});

describe('the log-in box', () => {
  const listed: Tenant[] = [
    { id: 'fredhutch', name: 'Fred Hutch Cancer Center', url: 'https://fredhutch.cirro.bio' },
    { id: 'salk', name: 'Salk Institute', url: 'https://salk.cirro.bio' },
  ];

  it('suggests listed tenants by name, id or address only from the third character', () => {
    expect(suggestTenants('sa', listed)).toEqual([]);
    expect(suggestTenants('sal', listed)).toEqual([listed[1]]);
    expect(suggestTenants('HUTCH', listed)).toEqual([listed[0]]);
    expect(suggestTenants('cirro.bio', listed)).toEqual(listed);
  });

  it('names a listed tenant exactly, or any other Cirro by its address', () => {
    expect(tenantNamed('Salk Institute', listed)).toBe(listed[1]);
    expect(tenantNamed('https://fredhutch.cirro.bio/', listed)).toBe(listed[0]);
    expect(tenantNamed('Cirro.Example.org', listed)).toEqual({ id: 'cirro.example.org', name: 'cirro.example.org', url: 'https://cirro.example.org' });
    expect(tenantNamed('Salk Inst', listed)).toBeNull();
  });

  it('remembers the choice for next time, a typed address included', () => {
    Object.assign(location, { assign: () => {} });
    chooseTenant(listed[1]);
    expect(lastTenant(listed)).toBe(listed[1]);
    chooseTenant(tenantNamed('cirro.example.org', listed)!);
    expect(lastTenant(listed)?.url).toBe('https://cirro.example.org');
  });

  it('opens a typed tenant from the URL only when it is the user\'s own choice', () => {
    location.search = '?tenant=cirro.example.org';
    localStorage.setItem('spatial-data-studio.tenant', 'cirro.example.org');
    expect(startOf(listed)).toEqual({ tenant: { id: 'cirro.example.org', name: 'cirro.example.org', url: 'https://cirro.example.org' } });
    location.search = '?tenant=evil.example.com';
    expect(startOf(listed)).toEqual({ screen: 'sign-in', unknownFromUrl: 'evil.example.com' });
  });
});
