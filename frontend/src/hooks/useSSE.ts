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
  SessionRemovedEvent,
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
    removeSession,
  } = useAppStore();

  useEffect(() => {
    const es = new EventSource('/api/events');

    es.addEventListener('session.created', (e: MessageEvent) => {
      const data = parseEvent<SessionCreatedEvent>(e);
      upsertSession(data.summary);
    });

    // A session another user (or a subset eviction) closed drops out of everyone's
    // list. reason==="subset" means the parent's own viewers are being moved to the
    // child by the job.completed(child_id) handler, so don't null/notify them here.
    es.addEventListener('session.removed', (e: MessageEvent) => {
      const data = parseEvent<SessionRemovedEvent>(e);
      removeSession(data.session_id);
      if (data.reason !== 'subset' && data.session_id === activeSessionId) {
        setActiveSessionId(null);
        setSessionState(null);
        pushNotification({ kind: 'info', message: 'This session was closed.' });
      }
    });

    // The backend appends the history/plot record at enqueue time, so refetch as
    // soon as a job is queued/started — the entry then shows immediately (queued →
    // running) instead of only appearing once it finishes. Job tracking is scoped to
    // the active session so another session's activity never spins this viewer's UI.
    es.addEventListener('job.queued', (e: MessageEvent) => {
      const data = parseEvent<JobQueuedEvent>(e);
      if (data.session_id === activeSessionId) {
        addActiveJob(data.job_id);
        getSession(data.session_id).then(setSessionState).catch(console.error);
      }
    });

    es.addEventListener('job.started', (e: MessageEvent) => {
      const data = parseEvent<JobStartedEvent>(e);
      if (data.session_id === activeSessionId) {
        addActiveJob(data.job_id);
        getSession(data.session_id).then(setSessionState).catch(console.error);
      }
    });

    es.addEventListener('job.completed', (e: MessageEvent) => {
      const data = parseEvent<JobCompletedEvent>(e);
      removeActiveJob(data.job_id);
      // Save and the persisted transform edit both block the UI behind the saving
      // overlay; clear it once the matching job lands (this is always the viewer's
      // own job, keyed by job_id, so it's not session-gated).
      if (useAppStore.getState().savingJobId === data.job_id) {
        useAppStore.getState().setSavingJobId(null);
      }
      // Everything below reflects a change to a specific session; only apply it to a
      // viewer who is actually looking at that session so another user's work never
      // moves this viewer, re-renders their canvas, or toasts at them.
      if (data.session_id !== activeSessionId) return;
      updateDataVersions(data.data_versions);
      // Save runs as a background job with no visible result; confirm it finished.
      if (data.kind === 'save') {
        pushNotification({ kind: 'info', message: 'Session saved.' });
      }
      // Cirro upload runs as a background job too; confirm it finished.
      if (data.kind === 'cirro_upload') {
        pushNotification({ kind: 'info', message: `Uploaded to Cirro as "${data.dataset_name}".` });
      }
      // A lasso subset produces a child session and evicts the parent: move the
      // parent's viewers to the child and refresh the list. session.removed prunes
      // the evicted parent from every other viewer's list.
      if (data.child_id) {
        setActiveSessionId(data.child_id);
        getSessions().then(({ sessions }) => setSessions(sessions)).catch(console.error);
        return;
      }
      getSession(data.session_id).then(setSessionState).catch(console.error);
    });

    es.addEventListener('job.failed', (e: MessageEvent) => {
      const data = parseEvent<JobFailedEvent>(e);
      removeActiveJob(data.job_id);
      if (useAppStore.getState().savingJobId === data.job_id) {
        useAppStore.getState().setSavingJobId(null);
      }
      // Failed compute jobs vanish from history (DESIGN §6.1); surface the error so
      // the user isn't left with a silently-closed form and no feedback — but only to
      // the viewer of that session, so another user's failure doesn't toast here.
      if (data.session_id !== activeSessionId) return;
      const prefix = data.source ? `[${data.source} @ ${data.timestamp}] ` : '';
      pushNotification({ kind: 'error', message: `${prefix}${data.error ?? 'unknown error'}` });
      getSession(data.session_id).then(setSessionState).catch(console.error);
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
      // Same-session viewers see each other's encoding edits live (real collaboration);
      // a viewer of another session must not have their displays touched.
      if (data.session_id === activeSessionId) {
        updateDisplay(data.spec);
      }
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
  }, [activeSessionId, upsertSession, setResourceSample, updateDataVersions, updateDisplay, addActiveJob, removeActiveJob, setSessionState, pushNotification, setActiveSessionId, setSessions, removeSession]);
}
