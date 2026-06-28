import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { getJobLog, redrawPlot, getFigureUrl } from '../api';
import StatusBadge from './StatusBadge';

export default function PlotDetail() {
  const { selectedPlotId, sessionState, activeSessionId, setSelectedPlotId } = useAppStore();
  const [log, setLog] = useState<string>('');
  const [svgContent, setSvgContent] = useState<string>('');
  const [redrawing, setRedrawing] = useState(false);

  const item = sessionState?.app_state.plots.find((p) => p.id === selectedPlotId) ?? null;

  useEffect(() => {
    if (!activeSessionId || !selectedPlotId || !item) return;
    getJobLog(activeSessionId, selectedPlotId)
      .then(({ log: l }) => setLog(l))
      .catch(() => setLog(''));
  }, [activeSessionId, selectedPlotId, item?.status]);

  useEffect(() => {
    if (!activeSessionId || !selectedPlotId || !item) return;
    if (item.status !== 'drawn') return;
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSelectedPlotId(null)}
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
        <div className="flex items-center gap-2">
          {svgContent && (
            <button
              onClick={handleExportSvg}
              className="px-3 py-1.5 bg-surface hover:bg-border text-muted hover:text-text text-xs rounded border border-border transition-colors"
            >
              Export SVG
            </button>
          )}
          <button
            onClick={handleRedraw}
            disabled={redrawing}
            className="px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent text-xs rounded transition-colors disabled:opacity-50"
          >
            {redrawing ? 'Redrawing...' : 'Redraw'}
          </button>
        </div>
      </div>

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
        ) : null}

        {log && (
          <div className="p-4 border-t border-border">
            <h3 className="text-xs font-mono text-muted uppercase tracking-wide mb-2">Log</h3>
            <pre className="bg-bg border border-border rounded p-3 text-xs font-mono text-muted overflow-auto max-h-48 whitespace-pre-wrap">
              {log}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
