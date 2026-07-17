import { useEffect } from 'react';
import { useAppStore } from '../store/sessionStore';
import { getSessions } from '../api';
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
    addQueuedEntry,
    setEntryStatus,
    activeSessionId,
    setSessionState,
    refreshSessionState,
    refreshShapeAnnotations,
    pushNotification,
    setActiveSessionId,
    setSessions,
    removeSession,
    setCirroUploads,
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

    // Show the row immediately from the event itself. A refetch here can't do it:
    // GET /api/sessions takes the session read lock, which blocks until the
    // already-running job releases the write lock — so the row would only appear
    // once the job finished. Insert on queued, flip to running on started, and let
    // the terminal events below refetch to reconcile the full record (the write
    // lock is released by then). Job tracking is scoped to the active session so
    // another session's activity never spins this viewer's UI.
    es.addEventListener('job.queued', (e: MessageEvent) => {
      const data = parseEvent<JobQueuedEvent>(e);
      if (data.session_id !== activeSessionId) return;
      addActiveJob(data.job_id);
      if (data.effect_class) {
        const d = data.descriptor as { namespace: string; function: string; params?: Record<string, unknown> };
        addQueuedEntry(data.effect_class, {
          id: data.job_id, namespace: d.namespace, function: d.function, params: d.params ?? {},
        });
      }
    });

    es.addEventListener('job.started', (e: MessageEvent) => {
      const data = parseEvent<JobStartedEvent>(e);
      if (data.session_id !== activeSessionId) return;
      addActiveJob(data.job_id);
      setEntryStatus(data.job_id, 'running');
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
      // Flip the row to its terminal status from the event, not the refetch below:
      // in a back-to-back queue (recipe / run-all) this job's completion refetch
      // blocks on the read lock behind the NEXT job's write lock, so without this
      // the finished row would keep showing "running" until the whole batch drains.
      if (data.kind === 'compute') setEntryStatus(data.job_id, 'completed');
      // Save runs as a background job with no visible result; confirm it finished.
      if (data.kind === 'save') {
        pushNotification({ kind: 'info', message: 'Session saved.' });
      }
      // A lasso subset produces a child session and evicts the parent: move the
      // parent's viewers to the child and refresh the list. session.removed prunes
      // the evicted parent from every other viewer's list.
      if (data.child_id) {
        setActiveSessionId(data.child_id);
        getSessions().then(({ sessions }) => setSessions(sessions)).catch(console.error);
        return;
      }
      // Shape-annotation geometry lives in sdata.shapes, not app_state, so a
      // job.completed for it needs its own refetch alongside the session-state one.
      if (data.kind === 'shape_annotate') {
        void refreshShapeAnnotations(data.session_id);
      }
      void refreshSessionState(data.session_id);
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
      // Frontend jobs keep failures in history (keep_failures=True); flip the row
      // from the event so it doesn't linger as "running" behind a blocked refetch.
      setEntryStatus(data.job_id, 'failed');
      const prefix = data.source ? `[${data.source} @ ${data.timestamp}] ` : '';
      pushNotification({ kind: 'error', message: `${prefix}${data.error ?? 'unknown error'}` });
      void refreshSessionState(data.session_id);
    });

    // Cirro upload isn't tied to a session (it uploads selected checkpoint files),
    // so its result events are NOT session-gated — the toast always reaches the
    // user who started the upload, even after switching sessions.
    es.addEventListener('cirro.upload.state', (e: MessageEvent) => {
      const data = parseEvent<{ uploading: number; pending: number }>(e);
      setCirroUploads({ uploading: data.uploading, pending: data.pending });
    });

    es.addEventListener('cirro.upload.completed', (e: MessageEvent) => {
      const data = parseEvent<{ dataset_name: string }>(e);
      pushNotification({ kind: 'info', message: `Uploaded to Cirro as "${data.dataset_name}".` });
    });

    es.addEventListener('cirro.upload.failed', (e: MessageEvent) => {
      const data = parseEvent<{ error: string }>(e);
      pushNotification({ kind: 'error', message: `Cirro upload failed: ${data.error}` });
    });

    es.addEventListener('plot.drawn', (e: MessageEvent) => {
      const data = parseEvent<PlotDrawnEvent>(e);
      if (data.session_id === activeSessionId) {
        setEntryStatus(data.plot_id, 'drawn');
        void refreshSessionState(data.session_id);
      }
    });

    es.addEventListener('plot.invalidated', (e: MessageEvent) => {
      const data = parseEvent<PlotInvalidatedEvent>(e);
      if (data.session_id === activeSessionId) {
        data.plot_ids.forEach((id) => setEntryStatus(id, 'invalidated'));
        void refreshSessionState(data.session_id);
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
  }, [activeSessionId, upsertSession, setResourceSample, updateDataVersions, updateDisplay, addActiveJob, removeActiveJob, addQueuedEntry, setEntryStatus, setSessionState, refreshSessionState, refreshShapeAnnotations, pushNotification, setActiveSessionId, setSessions, removeSession, setCirroUploads]);
}
