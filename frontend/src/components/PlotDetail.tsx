import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { getJobLog, redrawPlot, getFigureUrl } from '../api';
import { DetailHeader, ParametersSection } from './DetailModal';
import AnsiLog from './AnsiLog';
import RerunEditor from './RerunEditor';
import { useRerunEditor } from '../hooks/useRerunEditor';
import { reportError } from '../lib/errors';

export default function PlotDetail() {
  const { selectedPlotId, sessionState, activeSessionId, setSelectedPlotId } = useAppStore();
  const [log, setLog] = useState<string>('');
  const [svgContent, setSvgContent] = useState<string>('');
  const [redrawing, setRedrawing] = useState(false);

  const item = sessionState?.app_state.plots.find((p) => p.id === selectedPlotId) ?? null;
  const { fn, fields, editing, setEditing, submitting, rerun, runStaged, saveStaged } = useRerunEditor(
    item,
    () => setSelectedPlotId(null)
  );
  const isPending = item?.status === 'pending';

  useEffect(() => {
    if (!activeSessionId || !selectedPlotId || !item) return;
    getJobLog(activeSessionId, selectedPlotId)
      .then(({ log: l }) => setLog(l))
      .catch(() => setLog(''));
  }, [activeSessionId, selectedPlotId, item?.status]);

  useEffect(() => {
    if (!activeSessionId || !selectedPlotId || !item) return;
    // Clear any prior figure so switching to a pending/failed/invalidated plot never
    // paints the previous plot's SVG under the new item's state.
    if (item.status !== 'drawn') { setSvgContent(''); return; }
    const url = getFigureUrl(activeSessionId, selectedPlotId);
    fetch(url)
      .then((r) => r.text())
      .then(setSvgContent)
      .catch(() => setSvgContent(''));
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

  function handleExportSvg() {
    if (!svgContent || !item) return;
    const blob = new Blob([svgContent], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${item.function}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleExportPdf() {
    if (!activeSessionId || !item) return;
    try {
      const res = await fetch(getFigureUrl(activeSessionId, item.id, 'pdf'));
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${item.function}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      reportError('Export PDF failed', err);
    }
  }

  const actionBtn = 'px-3 py-1.5 text-xs rounded border border-border bg-surface hover:bg-border text-muted hover:text-text transition-colors';

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
                className="px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent text-xs rounded transition-colors"
              >
                Edit params
              </button>
            )}
            <button
              onClick={runStaged}
              disabled={submitting}
              className="px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent text-xs rounded transition-colors disabled:opacity-50"
            >
              {submitting ? 'Queuing...' : 'Run'}
            </button>
          </>
        ) : (
          <>
            {svgContent && (
              <>
                <button onClick={handleExportSvg} className={actionBtn}>Export SVG</button>
                <button onClick={handleExportPdf} className={actionBtn}>Export PDF</button>
              </>
            )}
            {fn && (
              <button
                onClick={() => setEditing(true)}
                className="px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent text-xs rounded transition-colors"
              >
                Edit &amp; rerun
              </button>
            )}
            <button
              onClick={handleRedraw}
              disabled={redrawing}
              className="px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent text-xs rounded transition-colors disabled:opacity-50"
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
          {svgContent ? (
            <div className="p-4">
              <div
                className="bg-white rounded overflow-auto"
                // SVG from trusted backend
                dangerouslySetInnerHTML={{ __html: svgContent }}
              />
            </div>
          ) : item.status === 'drawn' ? (
            <div className="flex items-center justify-center h-32 text-muted text-sm">Loading figure...</div>
          ) : item.status === 'queued' || item.status === 'running' ? (
            <div className="flex items-center justify-center h-32 text-accent text-sm animate-pulse">
              {item.status === 'running' ? 'Drawing...' : 'Queued...'}
            </div>
          ) : item.status === 'invalidated' ? (
            <div className="flex items-center justify-center h-32 text-warn text-sm">
              Figure invalidated — click Redraw
            </div>
          ) : item.status === 'failed' ? (
            <div className="flex items-center justify-center h-32 text-danger text-sm">
              Plot failed — see log below
            </div>
          ) : item.status === 'pending' ? (
            <div className="flex items-center justify-center h-32 text-warn text-sm">
              Staged — edit params or run to draw
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
