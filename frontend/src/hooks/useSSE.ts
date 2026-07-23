import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/sessionStore';
import { getSessions, pollEvents } from '../api';
import type {
  JobQueuedEvent,
  JobStartedEvent,
  JobCompletedEvent,
  JobFailedEvent,
  JobLogEvent,
  PlotDrawnEvent,
  PlotInvalidatedEvent,
  DisplayUpdatedEvent,
  SessionCreatedEvent,
  SessionRemovedEvent,
  SessionLoadingEvent,
  ResourceSample,
  MemoryWarningEvent,
} from '../types';

// Poll cadence for the fallback below. Matches the read-retry cadence elsewhere
// (fetchWhenIdle); the fallback only runs where SSE is blocked, so a few seconds
// of latency is the accepted trade for updates arriving at all.
const POLL_INTERVAL_MS = 2000;

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
    setLoadProgress,
    appendLoadLog,
    appendJobLog,
    clearJobLog,
  } = useAppStore();

  // Last event id processed, kept across effect re-runs (session switches) so the
  // polling fallback resumes where it left off — the JSON mirror of SSE's
  // Last-Event-ID resume — instead of re-baselining and dropping events.
  const cursor = useRef<number | undefined>(undefined);

  // Debounces the full-session refetch that job.completed/job.failed/plot.drawn/
  // plot.invalidated each trigger to reconcile fields the event itself doesn't carry
  // (queue view, obs/obsm field list, compute-history detail). Status badges and
  // data_versions already update instantly from the event payload, so delaying the
  // catch-up refetch by one tick is invisible to the user — but it collapses a
  // back-to-back batch (a recipe's N queued steps, or run-all) into one request
  // instead of N, each of which would otherwise queue behind the next step's write lock.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleRefresh(sessionId: string) {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { void refreshSessionState(sessionId); }, 250);
  }

  useEffect(() => {
    let lastMemoryWarnAt = 0;

    // One handler per event type, driven identically by the SSE stream and by the
    // polling fallback. Data arrives already parsed (JSON.parse for SSE frames,
    // native JSON for the poll), so each handler just narrows the payload type.
    const handlers: Record<string, (data: unknown) => void> = {
      'session.created': (data) => {
        upsertSession((data as SessionCreatedEvent).summary);
      },

      // Progress of a synchronous checkpoint load, before any session id exists. The
      // New Session dialog mints the load_id, subscribes via the store, and clears it.
      // A `log` chunk is the reader's live output (appended); a milestone event (no
      // `log`) carries the stage message/pct.
      'session.loading': (data) => {
        const d = data as SessionLoadingEvent;
        if (d.log != null) appendLoadLog(d.log);
        else setLoadProgress(d);
      },

      // Live log lines from a running reader (read bootstrap). Session-gated like the
      // other job events so another session's import never streams into this viewer.
      'job.log': (data) => {
        const d = data as JobLogEvent;
        if (d.session_id !== activeSessionId) return;
        appendJobLog(d.job_id, d.chunk);
      },

      // A session another user (or a subset eviction) closed drops out of everyone's
      // list. reason==="subset" means the parent's own viewers are being moved to the
      // child by the job.completed(child_id) handler, so don't null/notify them here.
      'session.removed': (data) => {
        const d = data as SessionRemovedEvent;
        removeSession(d.session_id);
        if (d.reason !== 'subset' && d.session_id === activeSessionId) {
          setActiveSessionId(null);
          setSessionState(null);
          pushNotification({ kind: 'info', message: 'This session was closed.' });
        }
      },

      // Show the row immediately from the event itself. A refetch here can't do it:
      // GET /api/sessions takes the session read lock, which blocks until the
      // already-running job releases the write lock — so the row would only appear
      // once the job finished. Insert on queued, flip to running on started, and let
      // the terminal events below refetch to reconcile the full record (the write
      // lock is released by then). Job tracking is scoped to the active session so
      // another session's activity never spins this viewer's UI.
      'job.queued': (data) => {
        const d = data as JobQueuedEvent;
        if (d.session_id !== activeSessionId) return;
        addActiveJob(d.job_id);
        if (d.effect_class) {
          const desc = d.descriptor as { namespace: string; function: string; params?: Record<string, unknown> };
          addQueuedEntry(d.effect_class, {
            id: d.job_id, namespace: desc.namespace, function: desc.function, params: desc.params ?? {},
          });
        }
      },

      'job.started': (data) => {
        const d = data as JobStartedEvent;
        if (d.session_id !== activeSessionId) return;
        addActiveJob(d.job_id);
        setEntryStatus(d.job_id, 'running');
      },

      'job.completed': (data) => {
        const d = data as JobCompletedEvent;
        removeActiveJob(d.job_id);
        // The full log is now fetchable from the store; drop the live buffer.
        clearJobLog(d.job_id);
        // Save and the persisted transform edit both block the UI behind the saving
        // overlay; clear it once the matching job lands (this is always the viewer's
        // own job, keyed by job_id, so it's not session-gated).
        if (useAppStore.getState().savingJobId === d.job_id) {
          useAppStore.getState().setSavingJobId(null);
        }
        // Everything below reflects a change to a specific session; only apply it to a
        // viewer who is actually looking at that session so another user's work never
        // moves this viewer, re-renders their canvas, or toasts at them.
        if (d.session_id !== activeSessionId) return;
        updateDataVersions(d.data_versions);
        // Flip the row to its terminal status from the event, not the refetch below:
        // in a back-to-back queue (recipe / run-all) this job's completion refetch
        // blocks on the read lock behind the NEXT job's write lock, so without this
        // the finished row would keep showing "running" until the whole batch drains.
        if (d.kind === 'compute') setEntryStatus(d.job_id, 'completed');
        // Save runs as a background job with no visible result; confirm it finished.
        if (d.kind === 'save') {
          pushNotification({ kind: 'info', message: 'Session saved.' });
        }
        // A lasso subset produces a child session and evicts the parent: move the
        // parent's viewers to the child and refresh the list. session.removed prunes
        // the evicted parent from every other viewer's list.
        if (d.child_id) {
          setActiveSessionId(d.child_id);
          getSessions().then(({ sessions }) => setSessions(sessions)).catch(console.error);
          return;
        }
        // Shape-annotation geometry lives in sdata.shapes, not app_state, so a
        // job.completed for it needs its own refetch alongside the session-state one.
        if (d.kind === 'shape_annotate') {
          void refreshShapeAnnotations(d.session_id);
        }
        scheduleRefresh(d.session_id);
      },

      'job.failed': (data) => {
        const d = data as JobFailedEvent;
        removeActiveJob(d.job_id);
        clearJobLog(d.job_id);
        if (useAppStore.getState().savingJobId === d.job_id) {
          useAppStore.getState().setSavingJobId(null);
        }
        // Failed compute jobs vanish from history (DESIGN §6.1); surface the error so
        // the user isn't left with a silently-closed form and no feedback — but only to
        // the viewer of that session, so another user's failure doesn't toast here.
        if (d.session_id !== activeSessionId) return;
        // Failed jobs stay in history (audit-log model); flip the row from the event
        // so it doesn't linger as "running" behind a blocked refetch.
        setEntryStatus(d.job_id, 'failed');
        const prefix = d.source ? `[${d.source} @ ${d.timestamp}] ` : '';
        pushNotification({ kind: 'error', message: `${prefix}${d.error ?? 'unknown error'}` });
        // Shape edits/deletes apply optimistically to local state before the job runs;
        // if it failed, re-read the authoritative geometry so the canvas doesn't keep a
        // change (or deletion) that never persisted.
        if (d.kind === 'shape_annotate') {
          void refreshShapeAnnotations(d.session_id);
        }
        scheduleRefresh(d.session_id);
      },

      // Cirro upload isn't tied to a session (it uploads selected checkpoint files),
      // so its result events are NOT session-gated — the toast always reaches the
      // user who started the upload, even after switching sessions.
      'cirro.upload.state': (data) => {
        const d = data as { uploading: number; pending: number };
        setCirroUploads({ uploading: d.uploading, pending: d.pending });
      },

      'cirro.upload.completed': (data) => {
        const d = data as { dataset_name: string };
        pushNotification({ kind: 'info', message: `Uploaded to Cirro as "${d.dataset_name}".` });
      },

      'cirro.upload.failed': (data) => {
        const d = data as { error: string };
        pushNotification({ kind: 'error', message: `Cirro upload failed: ${d.error}` });
      },

      'plot.drawn': (data) => {
        const d = data as PlotDrawnEvent;
        if (d.session_id === activeSessionId) {
          setEntryStatus(d.plot_id, 'drawn');
          scheduleRefresh(d.session_id);
        }
      },

      'plot.invalidated': (data) => {
        const d = data as PlotInvalidatedEvent;
        if (d.session_id === activeSessionId) {
          d.plot_ids.forEach((id) => setEntryStatus(id, 'invalidated'));
          scheduleRefresh(d.session_id);
        }
      },

      'display.updated': (data) => {
        const d = data as DisplayUpdatedEvent;
        // Same-session viewers see each other's encoding edits live (real collaboration);
        // a viewer of another session must not have their displays touched.
        if (d.session_id === activeSessionId) {
          updateDisplay(d.spec);
        }
      },

      'resource.sample': (data) => {
        setResourceSample(data as ResourceSample);
      },

      // Backend memory pressure: a job held at the admission boundary, or a store opened
      // read-only because its app_state schema is newer. Throttled, since a held job
      // re-publishes every retry until the pressure clears.
      'memory.warning': (data) => {
        if (Date.now() - lastMemoryWarnAt < 10000) return;
        lastMemoryWarnAt = Date.now();
        pushNotification({ kind: 'info', message: (data as MemoryWarningEvent).message });
      },
    };

    const es = new EventSource('/api/events');
    for (const type of Object.keys(handlers)) {
      es.addEventListener(type, (e) => {
        const me = e as MessageEvent;
        handlers[type](JSON.parse(me.data as string));
        if (me.lastEventId) cursor.current = Number(me.lastEventId);
      });
    }

    // Polling fallback: some deployments front the app with a proxy that rejects the
    // SSE content type (text/event-stream) or buffers the stream, so live updates
    // never arrive. When the browser reports the stream fatally closed — a 406 / wrong
    // content type does NOT auto-reconnect, unlike a transient network blip which
    // leaves readyState === CONNECTING — poll the same events as JSON (which such a
    // proxy passes through) and run them through the handlers above. Lock-free on the
    // backend: reads the event ring, never a session lock.
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    async function pollOnce() {
      try {
        const { last_id, events } = await pollEvents(cursor.current);
        if (stopped) return;
        for (const ev of events) handlers[ev.event]?.(ev.data);
        cursor.current = last_id;
      } catch {
        // Transient failure (busy proxy, network blip): keep polling.
      } finally {
        if (!stopped) pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
      }
    }

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && pollTimer === undefined && !stopped) {
        void pollOnce();
      }
    };

    return () => {
      stopped = true;
      es.close();
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [activeSessionId, upsertSession, setResourceSample, updateDataVersions, updateDisplay, addActiveJob, removeActiveJob, addQueuedEntry, setEntryStatus, setSessionState, refreshSessionState, refreshShapeAnnotations, pushNotification, setActiveSessionId, setSessions, removeSession, setCirroUploads, setLoadProgress, appendLoadLog, appendJobLog, clearJobLog]);
}
