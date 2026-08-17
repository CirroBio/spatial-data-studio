// Fullscreen view of one plot figure, with prev/next across every plot that has one.
// Opened from the Plots view or the plot detail panel (`expandedPlotId` in the store),
// and rendered once at the app root so both entry points share it.
import { useCallback, useEffect } from 'react';
import { reportError, useDataSource } from '@cirrobio/spatial-viewer';
import { useAppStore } from '../store/sessionStore';
import { useFigure } from '../hooks/useFigure';
import { displayFormat, downloadFigure, figureFormats, plotsWithFigures } from '../lib/figures';

export default function FigureLightbox() {
  const { sessionState, expandedPlotId, setExpandedPlotId } = useAppStore();
  const source = useDataSource();
  const plots = plotsWithFigures(sessionState);
  const index = plots.findIndex((p) => p.id === expandedPlotId);
  const plot = index < 0 ? null : plots[index];
  const format = plot && sessionState ? displayFormat(sessionState.figures, plot.id) : null;
  const { url, loading } = useFigure(plot?.id ?? null, format);

  const step = useCallback((delta: number) => {
    if (index < 0 || plots.length < 2) return;
    // Wrap, so the carousel keeps going in one direction rather than dead-ending.
    setExpandedPlotId(plots[(index + delta + plots.length) % plots.length].id);
  }, [index, plots, setExpandedPlotId]);

  useEffect(() => {
    if (expandedPlotId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpandedPlotId(null);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expandedPlotId, step, setExpandedPlotId]);

  // A plot can lose its figure while open (an upstream compute invalidates it); close
  // rather than sit on an empty frame. Not while there is no session yet: a link that
  // names a plot (`ui.plot`) sets `expandedPlotId` before the checkpoint has opened, and
  // closing on that empty first render would drop the plot the link asked for.
  useEffect(() => {
    if (expandedPlotId !== null && sessionState && index < 0) setExpandedPlotId(null);
  }, [expandedPlotId, sessionState, index, setExpandedPlotId]);

  if (!plot || !sessionState) return null;
  const label = `${plot.namespace}.${plot.function}`;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90">
      <div className="flex items-center justify-between gap-3 px-4 py-2 shrink-0 text-white/80">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-sm font-mono truncate">{label}</span>
          <span className="text-xs tabular-nums text-white/50">{index + 1} / {plots.length}</span>
        </div>
        <div className="flex items-center gap-2">
          {source && figureFormats(sessionState.figures, plot.id).map((fmt) => (
            <button
              key={fmt}
              onClick={() => {
                downloadFigure(source, plot, fmt)
                  .catch((err: unknown) => reportError(`Export ${fmt.toUpperCase()} failed`, err));
              }}
              className="px-2.5 py-1 text-xs rounded border border-white/25 hover:bg-white/10 transition-colors"
            >
              {fmt.toUpperCase()}
            </button>
          ))}
          <button
            onClick={() => setExpandedPlotId(null)}
            className="p-1 hover:text-white transition-colors"
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 flex items-center gap-2 px-2 pb-4 min-h-0">
        <NavButton direction="prev" disabled={plots.length < 2} onClick={() => step(-1)} />
        <div className="flex-1 h-full flex items-center justify-center min-w-0">
          {url ? (
            // White plate: matplotlib figures are drawn for a light background and
            // several are transparent outside the axes.
            <img src={url} alt={label} className="max-h-full max-w-full object-contain bg-white rounded" />
          ) : (
            <span className="text-sm text-white/60">{loading ? 'Loading figure…' : 'No figure to show'}</span>
          )}
        </div>
        <NavButton direction="next" disabled={plots.length < 2} onClick={() => step(1)} />
      </div>
    </div>
  );
}

function NavButton({ direction, disabled, onClick }: {
  direction: 'prev' | 'next'; disabled: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === 'prev' ? 'Previous figure' : 'Next figure'}
      className="p-2 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-0 disabled:cursor-default shrink-0"
    >
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d={direction === 'prev' ? 'M15 18l-6-6 6-6' : 'M9 6l6 6-6 6'} />
      </svg>
    </button>
  );
}
