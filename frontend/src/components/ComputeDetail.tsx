import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { getJobLog } from '../api';
import { DetailHeader, ParametersSection } from './DetailModal';
import AnsiLog from './AnsiLog';
import RerunEditor from './RerunEditor';
import { useRerunEditor } from '../hooks/useRerunEditor';

export default function ComputeDetail() {
  const { selectedComputeId, sessionState, activeSessionId, setSelectedComputeId, jobLogs } = useAppStore();
  const [log, setLog] = useState<string>('');

  const item = sessionState?.app_state.compute_history.find(
    (h) => h.id === selectedComputeId
  ) ?? null;
  const { fn, fields, editing, setEditing, submitting, rerun, runStaged, saveStaged } = useRerunEditor(
    item,
    () => setSelectedComputeId(null)
  );
  const isPending = item?.status === 'pending';
  // While a reader/compute runs its stored log is empty (delivered at completion), so
  // fall back to the live buffer streamed over `job.log` (transport/livelog.py).
  const shownLog = log || (selectedComputeId ? jobLogs[selectedComputeId] : '') || '';

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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <DetailHeader title={`${item.namespace}.${item.function}`} status={item.status} onClose={() => setSelectedComputeId(null)}>
        {editing ? (
          <button
            onClick={() => setEditing(false)}
            className="px-3 py-1.5 text-xs rounded border border-border bg-surface hover:bg-border text-muted hover:text-text transition-colors"
          >
            Cancel
          </button>
        ) : (
          <>
            {fn && (
              <button
                onClick={() => setEditing(true)}
                className="px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent text-xs rounded transition-colors"
              >
                {isPending ? 'Edit params' : 'Edit & rerun'}
              </button>
            )}
            <button
              onClick={() => (isPending ? runStaged() : rerun(item.params))}
              disabled={submitting}
              className="px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent text-xs rounded transition-colors disabled:opacity-50"
            >
              {submitting ? 'Queuing...' : isPending ? 'Run' : 'Re-run'}
            </button>
          </>
        )}
      </DetailHeader>

      {editing && fn ? (
        <RerunEditor
          fn={fn}
          fields={fields}
          sessionId={activeSessionId!}
          submitting={submitting}
          params={item.params}
          note={isPending
            ? 'Editing a staged step — Save keeps it pending; run it from the step view or with Run all.'
            : 'Editing parameters — rerun queues the function with these values.'}
          submitLabel={isPending ? 'Save' : 'Rerun'}
          onSubmit={isPending ? saveStaged : rerun}
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          <section>
            <ParametersSection params={item.params} />
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

          {shownLog && (
            <section className="flex-1">
              <h3 className="text-xs font-mono text-muted uppercase tracking-wide mb-2">Log</h3>
              <AnsiLog
                text={shownLog}
                className="bg-bg border border-border rounded p-3 text-xs font-mono text-muted overflow-auto max-h-64 whitespace-pre-wrap"
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
