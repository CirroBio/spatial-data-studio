import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { submitJob } from '../api';
import { reportError } from '../lib/errors';
import type { SessionFields } from '../types';

export const EMPTY_FIELDS: SessionFields = {
  obs: [], obsm: [], var_names_count: 0, obsp: [], layers: [], images: [], shapes: [],
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
export function useRerunEditor(item: RerunItem | null, onDone: () => void) {
  const { functions, sessionState, activeSessionId } = useAppStore();
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const fn = item ? functions.find((f) => f.key === `${item.namespace}.${item.function}`) ?? null : null;
  const fields = sessionState?.fields ?? EMPTY_FIELDS;

  useEffect(() => setEditing(false), [item?.id]);

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

  return { fn, fields, editing, setEditing, submitting, rerun };
}
