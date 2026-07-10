import { useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { subsetSession } from '../api';
import { reportError } from '../lib/errors';
import { useDrawSelection } from '../hooks/useDrawSelection';
import DrawControls from './DrawControls';

interface Props {
  onNewSession: () => void;
}

export default function SubsettingPanel({ onNewSession }: Props) {
  const { activeSessionId } = useAppStore();
  const { drawPolygons, drawRing, regionCount, allPolygons, commitDrawRing, clearDraw } = useDrawSelection();

  const [working, setWorking] = useState(false);

  async function handleSubset() {
    if (!activeSessionId || regionCount === 0) return;
    setWorking(true);
    try {
      await subsetSession(activeSessionId, { polygons: allPolygons });
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
          onClick={handleSubset}
          disabled={working || regionCount === 0}
          className="py-1.5 text-xs bg-accent hover:bg-accent/80 disabled:opacity-40 text-white rounded transition-colors"
        >
          {working ? 'Subsetting...' : `Subset to selection${regionCount ? ` (${regionCount})` : ''}`}
        </button>
        <p className="text-[10px] text-muted/60 leading-snug">Creates a child session; the parent is evicted.</p>
      </div>

      {/* New session shortcut */}
      <div className="px-3 py-2">
        <button
          onClick={onNewSession}
          className="w-full py-1.5 text-xs bg-bg border border-border rounded text-muted hover:text-text hover:border-accent/50 transition-colors"
        >
          New session...
        </button>
      </div>
    </div>
  );
}
