import { useEffect, useCallback } from 'react';
import { useAppStore } from '../store/sessionStore';

export function useSession(sessionId: string | null): {
  loading: boolean;
  refresh: () => void;
} {
  const { setSessionState, refreshSessionState, refreshShapeAnnotations, sessionState } = useAppStore();

  const load = useCallback(() => {
    if (!sessionId) {
      setSessionState(null);
      return;
    }
    void refreshSessionState(sessionId);
    void refreshShapeAnnotations(sessionId);
  }, [sessionId, setSessionState, refreshSessionState, refreshShapeAnnotations]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    loading: sessionState === null && sessionId !== null,
    refresh: load,
  };
}
