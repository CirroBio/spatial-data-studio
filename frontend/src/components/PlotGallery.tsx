// The Plots main view: every plot in the session as a thumbnail, clicking one opens it
// fullscreen (FigureLightbox). Figures come from the data source, so this is the same
// view in the app and in a shared checkpoint — the difference is only that a checkpoint
// can't redraw a plot whose figure it doesn't carry.
import { useAppStore } from '../store/sessionStore';
import { useFigure } from '../hooks/useFigure';
import { displayFormat } from '../lib/figures';
import StatusBadge from './StatusBadge';
import type { PlotEntry } from '../types';

export default function PlotGallery() {
  const { sessionState, setExpandedPlotId, setSelectedPlotId, setSidebarTab } = useAppStore();
  const plots = sessionState?.app_state.plots ?? [];

  if (!sessionState || !plots.length) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-1 text-muted">
        <span className="text-sm">No plots yet</span>
        <span className="text-xs text-muted/70">Run a plot function from the Plots panel to fill this view.</span>
      </div>
    );
  }

  // A figure-less plot opens in the detail panel instead, where it can be redrawn.
  function open(plot: PlotEntry, hasFigure: boolean) {
    if (hasFigure) {
      setExpandedPlotId(plot.id);
      return;
    }
    setSidebarTab('plots');
    setSelectedPlotId(plot.id);
  }

  return (
    <div className="h-full overflow-y-auto p-4 pt-12">
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
        {plots.map((plot) => (
          <PlotCard
            key={plot.id}
            plot={plot}
            format={displayFormat(sessionState.figures, plot.id, true)}
            onOpen={open}
          />
        ))}
      </div>
    </div>
  );
}

function PlotCard({ plot, format, onOpen }: {
  plot: PlotEntry;
  format: ReturnType<typeof displayFormat>;
  onOpen: (plot: PlotEntry, hasFigure: boolean) => void;
}) {
  const { url, loading } = useFigure(plot.id, format);

  return (
    <button
      onClick={() => onOpen(plot, format !== null)}
      title={`${plot.namespace}.${plot.function}`}
      className="flex flex-col rounded border border-border hover:border-accent/60 overflow-hidden text-left transition-colors"
    >
      <span className="w-full aspect-[4/3] flex items-center justify-center bg-white/90 overflow-hidden">
        {url ? (
          <img src={url} alt={`${plot.namespace}.${plot.function}`}
            className="w-full h-full object-contain" />
        ) : (
          <span className="text-[11px] text-black/50 px-2 text-center">
            {loading ? 'Loading…'
              : plot.status === 'drawn' ? 'No saved figure'
              : `Not drawn (${plot.status})`}
          </span>
        )}
      </span>
      <span className="flex items-center justify-between gap-2 px-2 py-1.5 min-w-0">
        <span className="text-xs font-mono text-text truncate">{plot.function}</span>
        <StatusBadge status={plot.status} size="xs" />
      </span>
    </button>
  );
}
