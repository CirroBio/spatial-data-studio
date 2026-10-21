import { UserManager, type OidcMetadata, type User } from 'oidc-client-ts';
import { REDIRECT_URI, SIGN_IN_TENANT_KEY } from './signInState';

// Sign-in goes through the tenant's Cirro authorize page, which shows the user this
// app's name and requested permissions and lets them pick their sign-in provider. The
// tenant publishes its endpoints (authorize, token, revocation, registration) in its
// OAuth metadata document. Tokens come with PKCE (no client secret). oidc-client-ts
// keeps them in sessionStorage (its default): the app is served from github.io, an
// origin other sites share, where the app kit forbids localStorage. A reload keeps the
// sign-in; a new tab signs in again.

// Public Apps allow only the openid scope; asking for more fails with invalid_scope.
const SCOPE = 'openid';

/** clientId is set for a tenant whose registration isn't discoverable, such as a
 * development registration; otherwise the tenant gives the client ID for this app's
 * callback URL. */
export async function createSignIn(tenantUrl: string, clientId: string | undefined): Promise<UserManager> {
  // Fetched here rather than through the library's metadataUrl, which reads it only on
  // first use: the client ID lookup needs its registration_endpoint first.
  const url = `${tenantUrl}/.well-known/oauth-authorization-server`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load sign-in settings: ${url} answered HTTP ${res.status}`);
  const metadata: Partial<OidcMetadata> = await res.json();
  return new UserManager({
    authority: tenantUrl,
    metadata,
    client_id: clientId || (await registeredClientId(metadata.registration_endpoint)),
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    // The ID token carries the username; skip the userinfo request.
    loadUserInfo: false,
    automaticSilentRenew: true,
  });
}

// Asks the tenant for the client ID of the registration that lists this app's callback
// URL (dynamic client registration, RFC 7591). A tenant admin sets that registration up
// with discovery enabled; the app never ships a client ID for it.
async function registeredClientId(endpoint: string | undefined): Promise<string> {
  if (!endpoint) throw new Error('This Cirro doesn\'t offer app registration lookup, so tenants.json needs this app\'s client ID for it.');
  // A tenant whose lookup doesn't answer other sites fails here, before any status.
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  }).catch(() => {
    throw new Error(`This Cirro didn't answer the app's registration lookup from ${window.location.origin}, so ${REDIRECT_URI} may not be registered there yet. A Cirro admin registers it, with discovery enabled.`);
  });
  if (res.status === 401) throw new Error(`No app is registered in this Cirro for ${REDIRECT_URI}. A Cirro admin registers it, with discovery enabled.`);
  if (res.status === 409) throw new Error(`More than one app in this Cirro is registered for ${REDIRECT_URI}; each app needs its own callback URL.`);
  if (!res.ok) throw new Error(`Could not get this app's client ID: ${endpoint} answered HTTP ${res.status}`);
  return (await res.json()).client_id;
}

interface ReturnState { returnTo: string }


export async function startSignIn(signIn: UserManager, tenantId: string) {
  window.sessionStorage.setItem(SIGN_IN_TENANT_KEY, tenantId);
  await signIn.signinRedirect({ state: { returnTo: window.location.search } satisfies ReturnState });
}

/** Finishes a sign-in redirect if this page load is one, then returns the signed-in user. */
export async function currentUser(signIn: UserManager): Promise<User | null> {
  const params = new URLSearchParams(window.location.search);
  if (params.has('code') && params.has('state')) {
    const user = await signIn.signinRedirectCallback();
    const returnTo = (user.state as ReturnState | undefined)?.returnTo ?? '';
    window.history.replaceState({}, '', window.location.pathname + returnTo);
    return user;
  }
  return activeUser(signIn);
}

/** The stored user, renewed with the refresh token if its access token has expired;
 * null when renewal fails, which means the user is signed out. */
export async function activeUser(signIn: UserManager): Promise<User | null> {
  const user = await signIn.getUser();
  if (!user?.expired) return user;
  return signIn.signinSilent().catch(() => null);
}

export const usernameOf = (user: User) => String(user.profile['cognito:username'] ?? user.profile.sub);

/** Ends the app's session in this browser: revokes the refresh token and forgets the
 * user. The user stays signed in to Cirro itself. */
export async function signOut(signIn: UserManager) {
  try {
    await signIn.revokeTokens(['refresh_token']);
  } catch (e) {
    throw new Error(`Logged out of this app, but the refresh token was not revoked: ${e instanceof Error ? e.message : e}`);
  } finally {
    // Forget the user even when revocation fails, so a failed sign-out can't leave them signed in.
    await signIn.removeUser();
  }
}
