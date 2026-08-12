import { useEffect, useCallback } from 'react';
import { useAppStore } from '../store/sessionStore';

/** Keeps the store's session state in sync with the backend. `enabled` is false in
 * serverless (checkpoint) mode, where the session state is synthesized locally and
 * there is no backend to fetch it from — distinct from `sessionId === null`, which
 * means "no session open" and clears the state. */
export function useSession(sessionId: string | null, enabled = true): {
  loading: boolean;
  refresh: () => void;
} {
  const { setSessionState, refreshSessionState, refreshShapeAnnotations, sessionState } = useAppStore();

  const load = useCallback(() => {
    if (!enabled) return;
    if (!sessionId) {
      setSessionState(null);
      return;
    }
    void refreshSessionState(sessionId);
    void refreshShapeAnnotations(sessionId);
  }, [enabled, sessionId, setSessionState, refreshSessionState, refreshShapeAnnotations]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    loading: enabled && sessionState === null && sessionId !== null,
    refresh: load,
  };
}
