import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { getJobLog, redrawPlot } from '../api';
import { DetailHeader, ParametersSection } from './DetailModal';
import AnsiLog from './AnsiLog';
import RerunEditor from './RerunEditor';
import { useRerunEditor } from '../hooks/useRerunEditor';
import { useFigure } from '../hooks/useFigure';
import { displayFormat, downloadFigure, figureFormats } from '../lib/figures';
import { reportError, useDataSource } from '@cirrobio/spatial-viewer';

export default function PlotDetail() {
  const { selectedPlotId, sessionState, activeSessionId, setSelectedPlotId,
          setExpandedPlotId } = useAppStore();
  const source = useDataSource();
  const [log, setLog] = useState<string>('');
  const [redrawing, setRedrawing] = useState(false);

  const item = sessionState?.app_state.plots.find((p) => p.id === selectedPlotId) ?? null;
  // Only a plot the session has a figure for renders — `figures` says so without a
  // fetch, so a pending/failed/invalidated plot never paints a stale figure.
  const figures = sessionState?.figures ?? {};
  const { url: figureUrl, loading: figureLoading } = useFigure(
    item?.id ?? null, item ? displayFormat(figures, item.id) : null);
  const exportFormats = item ? figureFormats(figures, item.id) : [];
  const { fn, fields, editing, setEditing, submitting, rerun, runStaged, saveStaged, canEdit, editBlockedReason } =
    useRerunEditor(item, () => setSelectedPlotId(null));
  const isPending = item?.status === 'pending';

  useEffect(() => {
    if (!activeSessionId || !selectedPlotId || !item) return;
    getJobLog(activeSessionId, selectedPlotId)
      .then(({ log: l }) => setLog(l))
      .catch(() => setLog(''));
  }, [activeSessionId, selectedPlotId, item?.status]);

  if (!item) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No plot selected
      </div>
    );
  }

  async function handleRedraw() {
    if (!activeSessionId || !item) return;
    setRedrawing(true);
    try {
      await redrawPlot(activeSessionId, item.id);
    } catch (err) {
      console.error(err);
    } finally {
      setRedrawing(false);
    }
  }

  const actionBtn = 'px-3 py-1.5 text-xs rounded border border-border bg-surface hover:bg-border text-muted hover:text-text transition-colors';
  // Lowercased to sit inside a parenthetical, as in Sidebar's disabled-tab titles.
  const blockedNote = (editBlockedReason ?? '').toLowerCase();

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <DetailHeader title={`${item.namespace}.${item.function}`} status={item.status} onClose={() => setSelectedPlotId(null)}>
        {editing ? (
          <button onClick={() => setEditing(false)} className={actionBtn}>Cancel</button>
        ) : isPending ? (
          <>
            {fn && (
              <button
                onClick={() => setEditing(true)}
                disabled={!canEdit}
                title={editBlockedReason ?? undefined}
                className="px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent text-xs rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Edit params
              </button>
            )}
            <button
              onClick={runStaged}
              disabled={submitting || !canEdit}
              title={editBlockedReason ?? undefined}
              className="px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent text-xs rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? 'Queuing...' : 'Run'}
            </button>
          </>
        ) : (
          <>
            {figureUrl && (
              <button onClick={() => setExpandedPlotId(item.id)} className={actionBtn}>Expand</button>
            )}
            {source && exportFormats.map((fmt) => (
              <button
                key={fmt}
                onClick={() => {
                  downloadFigure(source, item, fmt)
                    .catch((err: unknown) => reportError(`Export ${fmt.toUpperCase()} failed`, err));
                }}
                className={actionBtn}
              >
                Export {fmt.toUpperCase()}
              </button>
            ))}
            {fn && (
              <button
                onClick={() => setEditing(true)}
                disabled={!canEdit}
                title={editBlockedReason ?? undefined}
                className="px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent text-xs rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Edit &amp; rerun
              </button>
            )}
            <button
              onClick={handleRedraw}
              disabled={redrawing || !canEdit}
              title={editBlockedReason ?? undefined}
              className="px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent text-xs rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {redrawing ? 'Redrawing...' : 'Redraw'}
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
            ? 'Editing a staged plot — Save keeps it pending; run it from the step view or with Run all.'
            : 'Editing parameters — rerun draws a new plot from the same function.'}
          submitLabel={isPending ? 'Save' : 'Rerun'}
          onSubmit={isPending ? saveStaged : rerun}
        />
      ) : (
        <div className="flex-1 overflow-y-auto">
          {figureUrl ? (
            <div className="p-4">
              <button
                type="button"
                onClick={() => setExpandedPlotId(item.id)}
                title="Open fullscreen"
                className="block w-full bg-white rounded overflow-hidden"
              >
                <img src={figureUrl} alt={`${item.namespace}.${item.function}`} className="w-full" />
              </button>
            </div>
          ) : figureLoading ? (
            <div className="flex items-center justify-center h-32 text-muted text-sm">Loading figure...</div>
          ) : item.status === 'drawn' ? (
            <div className="flex items-center justify-center h-32 text-muted text-sm px-4 text-center">
              {canEdit
                ? 'This checkpoint was saved without figures — click Redraw'
                : 'This checkpoint was saved without figures'}
            </div>
          ) : item.status === 'queued' || item.status === 'running' ? (
            <div className="flex items-center justify-center h-32 text-accent text-sm animate-pulse">
              {item.status === 'running' ? 'Drawing...' : 'Queued...'}
            </div>
          ) : item.status === 'invalidated' ? (
            <div className="flex items-center justify-center h-32 text-warn text-sm">
              {canEdit
                ? 'Figure invalidated — click Redraw'
                : `Figure invalidated — redraw unavailable (${blockedNote})`}
            </div>
          ) : item.status === 'failed' ? (
            <div className="flex items-center justify-center h-32 text-danger text-sm">
              Plot failed — see log below
            </div>
          ) : item.status === 'pending' ? (
            <div className="flex items-center justify-center h-32 text-warn text-sm">
              {canEdit
                ? 'Staged — edit params or run to draw'
                : `Staged — running it is unavailable (${blockedNote})`}
            </div>
          ) : null}

          <div className="p-4 border-t border-border">
            <ParametersSection params={item.params} />
          </div>

          {log && (
            <div className="p-4 border-t border-border">
              <h3 className="text-xs font-mono text-muted uppercase tracking-wide mb-2">Log</h3>
              <AnsiLog
                text={log}
                className="bg-bg border border-border rounded p-3 text-xs font-mono text-muted overflow-auto max-h-48 whitespace-pre-wrap"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
