import { useEffect, useCallback } from 'react';
import { useAppStore } from '../store/sessionStore';

export function useSession(sessionId: string | null): {
  loading: boolean;
  refresh: () => void;
} {
  const { setSessionState, refreshSessionState, sessionState } = useAppStore();

  const load = useCallback(() => {
    if (!sessionId) {
      setSessionState(null);
      return;
    }
    void refreshSessionState(sessionId);
  }, [sessionId, setSessionState, refreshSessionState]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    loading: sessionState === null && sessionId !== null,
    refresh: load,
  };
}
