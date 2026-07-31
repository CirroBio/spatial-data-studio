import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { submitJob, runPendingStep, editPendingStep, getSession } from '../api';
import { reportError } from '../lib/errors';
import { useEditGate } from './usePresence';
import type { SessionFields } from '../types';

export const EMPTY_FIELDS: SessionFields = {
  obs: [], obsm: [], n_obs: 0, var_names_count: 0, obsp: [], layers: [], images: [], image_dims: [], shapes: [],
};

interface RerunItem {
  id: string;
  namespace: string;
  function: string;
  params: Record<string, unknown>;
}

// Shared edit-and-rerun state for the compute/plot detail views: the function
// entry + session fields the form needs, an editing toggle (reset when the
// selected item changes), and a submit that queues a fresh job then closes.
// Every submit here is a mutating route, so it also carries the edit gate for the
// callers' buttons — the detail views stay readable without the lock, but rerunning
// from them does not.
export function useRerunEditor(item: RerunItem | null, onDone: () => void) {
  const { functions, sessionState, activeSessionId, setSessionState } = useAppStore();
  const { canEdit, reason: editBlockedReason } = useEditGate();
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const fn = item ? functions.find((f) => f.key === `${item.namespace}.${item.function}`) ?? null : null;
  const fields = sessionState?.fields ?? EMPTY_FIELDS;

  useEffect(() => setEditing(false), [item?.id]);

  // Losing the gate mid-edit (someone else took the lock) leaves a form whose submit
  // would be refused, so fold the editor away — the same move Sidebar makes for a
  // mutating tab that is open when the gate closes.
  useEffect(() => {
    if (!canEdit) setEditing(false);
  }, [canEdit]);

  async function rerun(params: Record<string, unknown>) {
    if (!activeSessionId || !item) return;
    setSubmitting(true);
    try {
      await submitJob(activeSessionId, { namespace: item.namespace, function: item.function, params });
      onDone();
    } catch (err) {
      reportError('Rerun failed', err);
    } finally {
      setSubmitting(false);
    }
  }

  // Submit the staged step to the queue (job.queued SSE then refreshes state).
  async function runStaged() {
    if (!activeSessionId || !item) return;
    setSubmitting(true);
    try {
      await runPendingStep(activeSessionId, item.id);
      onDone();
    } catch (err) {
      reportError('Run failed', err);
    } finally {
      setSubmitting(false);
    }
  }

  // Persist edited params but keep the step pending. Staging emits no SSE event,
  // so refetch to reflect the change.
  async function saveStaged(params: Record<string, unknown>) {
    if (!activeSessionId || !item) return;
    setSubmitting(true);
    try {
      await editPendingStep(activeSessionId, item.id, params);
      setSessionState(await getSession(activeSessionId));
      setEditing(false);
    } catch (err) {
      reportError('Save failed', err);
    } finally {
      setSubmitting(false);
    }
  }

  return { fn, fields, editing, setEditing, submitting, rerun, runStaged, saveStaged, canEdit, editBlockedReason };
}
