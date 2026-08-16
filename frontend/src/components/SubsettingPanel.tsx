import { useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { subsetSession } from '../api';
import { reportError } from '@cirrobio/spatial-viewer';
import { useDrawSelection } from '../hooks/useDrawSelection';
import { useLocalEditsOnly } from '../hooks/usePresence';
import DrawControls from './DrawControls';

export default function SubsettingPanel() {
  const {
    activeSessionId, setBlockingJob, regionCellCount, regionCellIndices,
    hiddenCells, setHiddenCells, sessionState,
  } = useAppStore();
  const { drawPolygons, drawRing, regionCount, allPolygons, commitDrawRing, clearDraw } = useDrawSelection();

  const [working, setWorking] = useState(false);
  // A real subset runs `polygon_query` and opens a child session, both of which need
  // the backend. A checkpoint instead hides the cells on the canvas: the same framing
  // ("only keep" / "remove"), but presentation only and reversible.
  const hideOnly = useLocalEditsOnly();

  // The action is offered only once the region is finished: at least one committed
  // ring and no partially-drawn ring left open (the user commits with Finish region).
  const finished = drawPolygons.length > 0 && drawRing.length === 0;

  function handleHide(invert: boolean) {
    const selected = new Set(regionCellIndices ?? []);
    const total = sessionState?.fields.n_obs ?? 0;
    const hidden = new Set<number>();
    for (let i = 0; i < total; i++) {
      // "Only keep" hides everything outside the selection; "remove" hides inside it.
      if (invert ? selected.has(i) : !selected.has(i)) hidden.add(i);
    }
    setHiddenCells(hidden);
    clearDraw();
  }

  async function handleSubset(invert: boolean) {
    if (!activeSessionId || !finished) return;
    if (hideOnly) { handleHide(invert); return; }
    setWorking(true);
    try {
      // Block the UI until the (async, write-locked) subset job lands — its job.completed
      // clears the overlay (useSSE). The child session then replaces the evicted parent.
      const { job_id } = await subsetSession(activeSessionId, {
        ...(regionCellIndices ? { cell_indices: regionCellIndices } : { polygons: allPolygons }),
        invert,
      });
      setBlockingJob({ id: job_id, label: 'Subsetting…' });
      clearDraw();
    } catch (err) {
      reportError('Subset failed', err);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex flex-col gap-0">
      {/* Draw controls — drawing happens on the canvas; actions live here. */}
      <div className="px-3 py-2 border-b border-border/50 flex flex-col gap-1.5">
        <span className="text-[10px] text-muted font-mono uppercase tracking-wide">Selection</span>
        <DrawControls
          regionCount={regionCount}
          drawRingLength={drawRing.length}
          drawPolygonsLength={drawPolygons.length}
          onFinish={commitDrawRing}
          onClear={clearDraw}
        />
        <button
          type="button"
          onClick={() => handleSubset(false)}
          disabled={working || !finished}
          className="py-1.5 text-xs bg-accent hover:bg-accent/80 disabled:opacity-40 text-on-accent rounded transition-colors"
        >
          {working ? 'Subsetting...' : `${hideOnly ? 'Only show' : 'Only keep'} cells in region${finished ? ` (n=${regionCellCount.toLocaleString()})` : ''}`}
        </button>
        <button
          type="button"
          onClick={() => handleSubset(true)}
          disabled={working || !finished}
          className="py-1.5 text-xs bg-bg border border-border text-text hover:border-accent disabled:opacity-40 rounded transition-colors"
        >
          {working ? 'Subsetting...' : `${hideOnly ? 'Hide' : 'Remove'} cells in region${finished ? ` (n=${regionCellCount.toLocaleString()})` : ''}`}
        </button>
        {regionCount > 0 && !finished && (
          <p className="text-[10px] text-warn leading-snug">Finish the region first (Finish region above).</p>
        )}
        {hideOnly && hiddenCells && (
          <button
            type="button"
            onClick={() => setHiddenCells(null)}
            className="py-1.5 text-xs bg-bg border border-border text-text hover:border-accent rounded transition-colors"
          >
            Show all cells again ({hiddenCells.size.toLocaleString()} hidden)
          </button>
        )}
        <p className="text-[10px] text-muted/60 leading-snug">
          {hideOnly
            ? 'Hides the cells on this canvas only — the checkpoint is unchanged.'
            : 'Creates a child session; the parent is evicted.'}
        </p>
      </div>
    </div>
  );
}
