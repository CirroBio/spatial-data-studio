// Who this browser is, and what the session lock means for it.
//
// Identity is client-minted and kept in localStorage so a reload keeps your name
// and your lock: the backend only ever sees the id + display name the heartbeat
// sends (see hooks/usePresence.ts, backend sessions/presence.py). Two tabs of the
// same browser share the identity, and so count as one viewer holding one lock.
import type { SessionPresence, SessionState } from '../types';

const ID_KEY = 'sds-client-id';
const NAME_KEY = 'sds-client-name';

// Two-word display names in the familiar "adjective + name" style. Deliberately
// small lists: a collision only makes two viewers harder to tell apart in the
// viewer list, since identity is the client id, and the name is editable.
const ADJECTIVES = [
  'gloomy', 'brave', 'sleepy', 'eager', 'quiet', 'clever', 'jolly', 'wistful',
  'bold', 'gentle', 'nimble', 'stoic', 'sunny', 'witty', 'zealous', 'candid',
  'dapper', 'frosty', 'humble', 'lucid', 'merry', 'plucky', 'rustic', 'serene',
];
const NAMES = [
  'socrates', 'curie', 'darwin', 'hopper', 'turing', 'lovelace', 'newton', 'franklin',
  'euler', 'noether', 'ramanujan', 'pasteur', 'mendel', 'hodgkin', 'feynman', 'bohr',
  'kepler', 'galileo', 'faraday', 'maxwell', 'planck', 'meitner', 'cajal', 'linnaeus',
];

function pick(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}

export function randomClientName(): string {
  return `${pick(ADJECTIVES)} ${pick(NAMES)}`;
}

function readOrMint(key: string, mint: () => string): string {
  const stored = localStorage.getItem(key);
  if (stored) return stored;
  const minted = mint();
  localStorage.setItem(key, minted);
  return minted;
}

// Stable for the lifetime of the browser profile. Read once at module load so a
// mid-session localStorage edit can't split one viewer across two identities.
export const CLIENT_ID = readOrMint(ID_KEY, () => crypto.randomUUID());

let clientNameValue = readOrMint(NAME_KEY, randomClientName);

export function clientName(): string {
  return clientNameValue;
}

export function setClientName(name: string): void {
  clientNameValue = name.trim().slice(0, 40) || randomClientName();
  localStorage.setItem(NAME_KEY, clientNameValue);
}

export type LockState =
  | { state: 'you' }
  | { state: 'other'; holder: string }
  | { state: 'none' };

export function lockStateOf(presence: SessionPresence | undefined): LockState {
  const lock = presence?.lock;
  if (!lock) return { state: 'none' };
  return lock.client_id === CLIENT_ID ? { state: 'you' } : { state: 'other', holder: lock.name };
}

/** Why this viewer can't change the session, or null when they can. A frozen
 * read-only snapshot and someone else's lock are the two ways to be blocked; both
 * leave every read path — and local-only display settings — working. */
export function editBlockReason(
  sessionState: SessionState | null,
  presence: Record<string, SessionPresence>,
): string | null {
  if (!sessionState) return null;
  if (sessionState.summary.read_only) return 'Viewing a read-only snapshot';
  const lock = lockStateOf(presence[sessionState.summary.id]);
  return lock.state === 'other' ? `Session is locked by ${lock.holder}` : null;
}
