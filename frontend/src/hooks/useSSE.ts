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
  } = useAppStore();

  useEffect(() => {
    const es = new EventSource('/api/events');

    es.addEventListener('session.created', (e: MessageEvent) => {
      const data = parseEvent<SessionCreatedEvent>(e);
      upsertSession(data.summary);
    });

    // The backend appends the history/plot record at enqueue time, so refetch as
    // soon as a job is queued/started — the entry then shows immediately (queued →
    // running) instead of only appearing once it finishes.
    es.addEventListener('job.queued', (e: MessageEvent) => {
      const data = parseEvent<JobQueuedEvent>(e);
      addActiveJob(data.job_id);
      if (data.session_id === activeSessionId) {
        getSession(data.session_id).then(setSessionState).catch(console.error);
      }
    });

    es.addEventListener('job.started', (e: MessageEvent) => {
      const data = parseEvent<JobStartedEvent>(e);
      addActiveJob(data.job_id);
      if (data.session_id === activeSessionId) {
        getSession(data.session_id).then(setSessionState).catch(console.error);
      }
    });

    es.addEventListener('job.completed', (e: MessageEvent) => {
      const data = parseEvent<JobCompletedEvent>(e);
      removeActiveJob(data.job_id);
      updateDataVersions(data.data_versions);
      // Save runs as a background job with no visible result; confirm it finished.
      if (data.kind === 'save') {
        pushNotification({ kind: 'info', message: 'Session saved.' });
      }
      // Save and the persisted transform edit both block the UI behind the saving
      // overlay; clear it once the matching job lands.
      if (useAppStore.getState().savingJobId === data.job_id) {
        useAppStore.getState().setSavingJobId(null);
      }
      // Cirro upload runs as a background job too; confirm it finished.
      if (data.kind === 'cirro_upload') {
        pushNotification({ kind: 'info', message: `Uploaded to Cirro as "${data.dataset_name}".` });
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
      const prefix = data.source ? `[${data.source} @ ${data.timestamp}] ` : '';
      pushNotification({ kind: 'error', message: `${prefix}${data.error ?? 'unknown error'}` });
      if (useAppStore.getState().savingJobId === data.job_id) {
        useAppStore.getState().setSavingJobId(null);
      }
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

    es.onerror = () => {
      // SSE reconnects automatically
    };

    return () => {
      es.close();
    };
  }, [activeSessionId, upsertSession, setResourceSample, updateDataVersions, updateDisplay, addActiveJob, removeActiveJob, setSessionState, pushNotification, setActiveSessionId, setSessions]);
}
