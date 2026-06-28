import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { getJobLog, submitJob } from '../api';
import StatusBadge from './StatusBadge';
import AnsiLog from './AnsiLog';

export default function ComputeDetail() {
  const { selectedComputeId, sessionState, activeSessionId, setSelectedComputeId } = useAppStore();
  const [log, setLog] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const item = sessionState?.app_state.compute_history.find(
    (h) => h.id === selectedComputeId
  ) ?? null;

  useEffect(() => {
    if (!activeSessionId || !selectedComputeId || !item) return;
    getJobLog(activeSessionId, selectedComputeId)
      .then(({ log: l }) => setLog(l))
      .catch(() => setLog(''));
  }, [activeSessionId, selectedComputeId, item?.status]);

  if (!item) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No compute item selected
      </div>
    );
  }

  async function handleRerun() {
    if (!activeSessionId || !item) return;
    setSubmitting(true);
    try {
      await submitJob(activeSessionId, {
        namespace: item.namespace,
        function: item.function,
        params: item.params,
      });
      setSelectedComputeId(null);
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSelectedComputeId(null)}
            className="text-muted hover:text-text transition-colors"
            aria-label="Back"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 5l-7 7 7 7" />
            </svg>
          </button>
          <span className="text-sm font-mono text-text">{item.namespace}.{item.function}</span>
          <StatusBadge status={item.status} />
        </div>
        <button
          onClick={handleRerun}
          disabled={submitting}
          className="px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent text-xs rounded transition-colors disabled:opacity-50"
        >
          {submitting ? 'Queuing...' : 'Re-run'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        <section>
          <h3 className="text-xs font-mono text-muted uppercase tracking-wide mb-2">Parameters</h3>
          <pre className="bg-bg border border-border rounded p-3 text-xs font-mono text-text overflow-x-auto">
            {JSON.stringify(item.params, null, 2)}
          </pre>
        </section>

        {item.started_at && (
          <section>
            <h3 className="text-xs font-mono text-muted uppercase tracking-wide mb-2">Timing</h3>
            <div className="text-xs text-muted font-mono space-y-0.5">
              <div>Started: {new Date(item.started_at).toLocaleString()}</div>
              {item.finished_at && (
                <div>Finished: {new Date(item.finished_at).toLocaleString()}</div>
              )}
            </div>
          </section>
        )}

        {log && (
          <section className="flex-1">
            <h3 className="text-xs font-mono text-muted uppercase tracking-wide mb-2">Log</h3>
            <AnsiLog
              text={log}
              className="bg-bg border border-border rounded p-3 text-xs font-mono text-muted overflow-auto max-h-64 whitespace-pre-wrap"
            />
          </section>
        )}
      </div>
    </div>
  );
}
