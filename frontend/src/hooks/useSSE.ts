import { useEffect } from 'react';
import { useAppStore } from '../store/sessionStore';
import { getSession, getSessions } from '../api';
import type {
  JobQueuedEvent,
  JobStartedEvent,
  JobCompletedEvent,
  JobFailedEvent,
  PlotDrawnEvent,
  PlotInvalidatedEvent,
  DisplayUpdatedEvent,
  SessionCreatedEvent,
  ResourceSample,
} from '../types';

function parseEvent<T>(e: MessageEvent): T {
  return JSON.parse(e.data as string) as T;
}

export function useSSE(): void {
  const {
    upsertSession,
    setResourceSample,
    updateDataVersions,
    updateDisplay,
    addActiveJob,
    removeActiveJob,
    activeSessionId,
    setSessionState,
    pushNotification,
    setActiveSessionId,
    setSessions,
    appendChatMessage,
    setChatPending,
    setChatBusy,
  } = useAppStore();

  useEffect(() => {
    const es = new EventSource('/api/events');

    es.addEventListener('session.created', (e: MessageEvent) => {
      const data = parseEvent<SessionCreatedEvent>(e);
      upsertSession(data.summary);
    });

    es.addEventListener('job.queued', (e: MessageEvent) => {
      const data = parseEvent<JobQueuedEvent>(e);
      addActiveJob(data.job_id);
    });

    es.addEventListener('job.started', (e: MessageEvent) => {
      const data = parseEvent<JobStartedEvent>(e);
      addActiveJob(data.job_id);
    });

    es.addEventListener('job.completed', (e: MessageEvent) => {
      const data = parseEvent<JobCompletedEvent>(e);
      removeActiveJob(data.job_id);
      updateDataVersions(data.data_versions);
      // Save runs as a background job with no visible result; confirm it finished.
      if (data.kind === 'save') {
        pushNotification({ kind: 'info', message: 'Session saved.' });
      }
      // A lasso subset produces a child session and evicts the parent: switch to the
      // child and refresh the list so the evicted parent drops out.
      if (data.child_id) {
        setActiveSessionId(data.child_id);
        getSessions().then(({ sessions }) => setSessions(sessions)).catch(console.error);
        return;
      }
      // Reload session state if this is for the active session
      if (data.session_id === activeSessionId) {
        getSession(data.session_id)
          .then(setSessionState)
          .catch(console.error);
      }
    });

    es.addEventListener('job.failed', (e: MessageEvent) => {
      const data = parseEvent<JobFailedEvent>(e);
      removeActiveJob(data.job_id);
      // Failed compute jobs vanish from history (DESIGN §6.1); surface the error so
      // the user isn't left with a silently-closed form and no feedback.
      pushNotification({ kind: 'error', message: `Job failed: ${data.error ?? 'unknown error'}` });
      if (data.session_id === activeSessionId) {
        getSession(data.session_id).then(setSessionState).catch(console.error);
      }
    });

    es.addEventListener('plot.drawn', (e: MessageEvent) => {
      const data = parseEvent<PlotDrawnEvent>(e);
      if (data.session_id === activeSessionId) {
        getSession(data.session_id)
          .then(setSessionState)
          .catch(console.error);
      }
    });

    es.addEventListener('plot.invalidated', (e: MessageEvent) => {
      const data = parseEvent<PlotInvalidatedEvent>(e);
      if (data.session_id === activeSessionId) {
        getSession(data.session_id).then(setSessionState).catch(console.error);
      }
    });

    es.addEventListener('display.updated', (e: MessageEvent) => {
      const data = parseEvent<DisplayUpdatedEvent>(e);
      updateDisplay(data.spec);
    });

    es.addEventListener('resource.sample', (e: MessageEvent) => {
      const data = parseEvent<ResourceSample>(e);
      setResourceSample(data);
    });

    // ---- AI chat events (v3 Parts 6-8) ----
    es.addEventListener('ai.message', (e: MessageEvent) => {
      const data = parseEvent<{ session_id: string; text: string }>(e);
      if (data.session_id === activeSessionId && data.text) appendChatMessage({ role: 'assistant', text: data.text });
    });
    es.addEventListener('ai.tool', (e: MessageEvent) => {
      const data = parseEvent<{ session_id: string; name: string; phase: string }>(e);
      if (data.session_id === activeSessionId && data.phase === 'proposed') {
        appendChatMessage({ role: 'tool', text: data.name });
      }
    });
    es.addEventListener('ai.approval', (e: MessageEvent) => {
      const data = parseEvent<{ session_id: string; call_id: string; name: string; params: Record<string, unknown> }>(e);
      if (data.session_id === activeSessionId) setChatPending({ call_id: data.call_id, name: data.name, params: data.params });
    });
    es.addEventListener('ai.turn_done', (e: MessageEvent) => {
      const data = parseEvent<{ session_id: string }>(e);
      if (data.session_id === activeSessionId) {
        setChatBusy(false);
        getSession(data.session_id).then(setSessionState).catch(console.error);
      }
    });
    es.addEventListener('ai.error', (e: MessageEvent) => {
      const data = parseEvent<{ session_id: string; error: string }>(e);
      if (data.session_id === activeSessionId) {
        appendChatMessage({ role: 'error', text: data.error });
        setChatBusy(false);
      }
    });

    es.onerror = () => {
      // SSE reconnects automatically
    };

    return () => {
      es.close();
    };
  }, [activeSessionId, upsertSession, setResourceSample, updateDataVersions, updateDisplay, addActiveJob, removeActiveJob, setSessionState, pushNotification, setActiveSessionId, setSessions, appendChatMessage, setChatPending, setChatBusy]);
}
