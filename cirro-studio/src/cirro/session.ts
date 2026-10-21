// The signed-in Cirro session, and plain words for what Cirro answers.
import type { DataService, FileService } from '@cirrobio/sdk';
import type { Collection } from '../data/collection';
import type { Tenant } from '../tenants';

export interface CirroSession {
  tenant: Tenant;
  data: DataService;
  // One per session: it caches file credentials until they expire.
  files: FileService;
  username: string;
  // How notes the app writes name the user: their email where the ID token has it.
  displayName: string;
  tenantName: string;
  // tenantInfo.id from /info/system, used in sheet references.
  tenantId: string;
  sheetsEnabled: boolean;
  signOut: () => Promise<void>;
  // A project as a collection. Made here, where the Cirro code is loaded, so a visitor
  // to the examples never downloads it.
  openProject: (project: { id: string; name: string }) => Collection;
}

// The SDK's ApiError, recognized by its shape: every page uses this module, and importing
// the class would load the whole Cirro client for visitors who never sign in.
interface ApiError extends Error { errorCode: number; errors: string[] }
export const isApiError = (e: unknown): e is ApiError => e instanceof Error && typeof (e as Partial<ApiError>).errorCode === 'number';

const RATE_LIMIT_WAITS_MS = [2000, 5000, 10000];
const isRateLimited = (e: unknown) => isApiError(e) && e.errorCode === 429;

/** Retries a call Cirro answered with 429: the file-credential endpoint is rate-limited
 * per user, and every app signed in as one person shares it. */
export async function retryRateLimited<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimited(e) || attempt >= RATE_LIMIT_WAITS_MS.length) throw e;
      await new Promise((r) => setTimeout(r, RATE_LIMIT_WAITS_MS[attempt]));
    }
  }
}

/** The permission a refusal names ("Not allowed to CREATE_DATASET on project …"). */
export const refusedPermission = (e: unknown): string | null =>
  isApiError(e) && (e.errorCode === 403 || e.errorCode === 401)
    ? /Not allowed to ([A-Z_]+)/.exec([e.message, ...(e.errors ?? [])].join(' '))?.[1] ?? null
    : null;

export const needsPermission = (perm: string) =>
  `This needs the ${perm} permission, which your role in this project or this app's registration doesn't grant. `
  + 'A project owner can change your role, or a Cirro admin can grant the app the permission.';

/** Plain words for a failure; a refusal names who can fix it. */
export function describeError(e: unknown, action?: string): string {
  if (isApiError(e)) {
    const perm = refusedPermission(e);
    if (perm) return needsPermission(perm);
    // File-credential refusals come back as 401 with "Not allowed to …"; a bare 401 is
    // an ended session.
    if (e.errorCode === 401) return 'Your Cirro session has ended. Log in again.';
    if (isRateLimited(e)) return 'Cirro is limiting how fast this account can make requests. Wait a minute and try again.';
    if (e.errorCode === 403) {
      return `You don't have permission to ${action ?? 'do this'} in this project. A project owner can change your role, `
        + `or a Cirro admin can grant this app the permission. (${e.message})`;
    }
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

