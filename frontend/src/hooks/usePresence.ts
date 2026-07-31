import { useEffect } from 'react';
import { useAppStore } from '../store/sessionStore';
import { postPresence } from '../api';
import { clientName, editBlockReason } from '../lib/presence';

// Heartbeat cadence. The backend drops a viewer, releasing its lock, after
// SDS_PRESENCE_TIMEOUT_S (20 s — four beats) of silence, so this must stay well under it.
const HEARTBEAT_MS = 5000;

/** Announces this viewer (id, display name, session being viewed) on a heartbeat, and
 * keeps the store's presence map seeded from each response. Live changes arrive over
 * SSE as `presence.updated`; the heartbeat's own response is what makes a fresh tab —
 * and the tab that just took a lock — correct before the next event. */
export function usePresence(activeSessionId: string | null): void {
  const setPresence = useAppStore((s) => s.setPresence);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function beat() {
      try {
        const { sessions } = await postPresence(activeSessionId, clientName());
        if (!stopped) setPresence(sessions);
      } catch {
        // A missed beat is harmless — the backend's timeout is several beats wide.
      } finally {
        if (!stopped) timer = setTimeout(beat, HEARTBEAT_MS);
      }
    }
    void beat();

    // Closing or navigating away detaches immediately (and releases the lock) instead
    // of leaving it held for the timeout. `keepalive` lets the request outlive the page.
    const leave = () => { void postPresence(null, clientName(), true).catch(() => {}); };
    window.addEventListener('pagehide', leave);

    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('pagehide', leave);
    };
  }, [activeSessionId, setPresence]);
}

/** Whether this viewer may change the active session, and why not when they can't.
 * The one gate every mutating control reads: a frozen read-only snapshot and another
 * viewer's lock block the same set of actions (see lib/presence.editBlockReason). */
export function useEditGate(): { canEdit: boolean; reason: string | null } {
  const reason = useAppStore((s) => editBlockReason(s.sessionState, s.presence));
  return { canEdit: reason === null, reason };
}
