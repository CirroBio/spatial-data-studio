import { useEffect, useCallback } from 'react';
import { useAppStore } from '../store/sessionStore';
import { getSession } from '../api';

export function useSession(sessionId: string | null): {
  loading: boolean;
  refresh: () => void;
} {
  const { setSessionState, sessionState } = useAppStore();

  const load = useCallback(() => {
    if (!sessionId) {
      setSessionState(null);
      return;
    }
    getSession(sessionId)
      .then(setSessionState)
      .catch(console.error);
  }, [sessionId, setSessionState]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    loading: sessionState === null && sessionId !== null,
    refresh: load,
  };
}
