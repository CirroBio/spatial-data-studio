import { useEffect, useCallback } from 'react';
import { useAppStore } from '../store/sessionStore';
import { getSession } from '../api';
import { isSpatialDisplay } from '../types';

export function useSession(sessionId: string | null): {
  loading: boolean;
  refresh: () => void;
} {
  const { setSessionState, setIsolatedCategory, sessionState } = useAppStore();

  const load = useCallback(() => {
    if (!sessionId) {
      setSessionState(null);
      return;
    }
    getSession(sessionId)
      .then((state) => {
        setSessionState(state);
        // Restore the persisted isolated category (setActiveSessionId cleared it).
        const spatial = state.app_state.displays.find(isSpatialDisplay);
        setIsolatedCategory(spatial ? spatial.encoding.isolated_category ?? null : null);
      })
      .catch(console.error);
  }, [sessionId, setSessionState, setIsolatedCategory]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    loading: sessionState === null && sessionId !== null,
    refresh: load,
  };
}
