// The tools over the canvas, at the right of the views bar: a scale bar, and zoom and fit
// under the names the Display drawer's View tab gives them, kept in reach with the
// drawers away.
import type { EmbeddingCanvasControls, SpatialCanvasControls } from '@cirrobio/spatial-viewer';
import { scaleBar } from '../figures/scaleBar';
import { useWorldPerPixel } from './displayState';

// The bar's longest length on screen; it shows the roundest length that fits.
const SCALE_MAX_PX = 96;

function ScaleBar({ wbKey }: { wbKey: string }) {
  const perPixel = useWorldPerPixel(wbKey);
  if (!perPixel) return null;
  // scaleBar picks a length near a fifth of the width it's given.
  const bar = scaleBar(5 * SCALE_MAX_PX * perPixel);
  return (
    <span className="view-scale" title="Scale">
      <span className="view-scale-bar" style={{ width: bar.fraction * 5 * SCALE_MAX_PX }} />
      {bar.label}
    </span>
  );
}

export function SpatialTools({ api, wbKey, unit }: { api: SpatialCanvasControls; wbKey: string; unit: 'µm' | null }) {
  return (
    <div className="view-tools" role="toolbar" aria-label="View">
      {unit && <ScaleBar wbKey={wbKey} />}
      <button type="button" className="view-tool" title="Zoom out" aria-label="Zoom out" onClick={() => api.onZoom(-1)}>−</button>
      <button type="button" className="view-tool" title="Zoom in" aria-label="Zoom in" onClick={() => api.onZoom(1)}>+</button>
      <button type="button" className="view-tool" onClick={api.onFit}>Fit to data</button>
    </div>
  );
}

export function EmbeddingTools({ api }: { api: EmbeddingCanvasControls }) {
  return (
    <div className="view-tools" role="toolbar" aria-label="View">
      <button type="button" className="view-tool" onClick={api.onFit}>Fit to data</button>
    </div>
  );
}
