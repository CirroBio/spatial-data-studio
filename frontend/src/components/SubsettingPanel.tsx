import { useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { subsetSession } from '../api';
import { reportError } from '../lib/errors';
import { useDrawSelection } from '../hooks/useDrawSelection';
import DrawControls from './DrawControls';

export default function SubsettingPanel() {
  const { activeSessionId, setBlockingJob, regionCellCount, regionCellIndices } = useAppStore();
  const { drawPolygons, drawRing, regionCount, allPolygons, commitDrawRing, clearDraw } = useDrawSelection();

  const [working, setWorking] = useState(false);

  // The action is offered only once the region is finished: at least one committed
  // ring and no partially-drawn ring left open (the user commits with Finish region).
  const finished = drawPolygons.length > 0 && drawRing.length === 0;

  async function handleSubset(invert: boolean) {
    if (!activeSessionId || !finished) return;
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
          className="py-1.5 text-xs bg-accent hover:bg-accent/80 disabled:opacity-40 text-white rounded transition-colors"
        >
          {working ? 'Subsetting...' : `Only keep cells in region${finished ? ` (n=${regionCellCount.toLocaleString()})` : ''}`}
        </button>
        <button
          type="button"
          onClick={() => handleSubset(true)}
          disabled={working || !finished}
          className="py-1.5 text-xs bg-bg border border-border text-text hover:border-accent disabled:opacity-40 rounded transition-colors"
        >
          {working ? 'Subsetting...' : `Remove cells in region${finished ? ` (n=${regionCellCount.toLocaleString()})` : ''}`}
        </button>
        {regionCount > 0 && !finished && (
          <p className="text-[10px] text-warn leading-snug">Finish the region first (Finish region above).</p>
        )}
        <p className="text-[10px] text-muted/60 leading-snug">Creates a child session; the parent is evicted.</p>
      </div>
    </div>
  );
}
