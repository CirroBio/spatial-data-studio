import { useMemo } from 'react';
import { selectionShapeRing } from '@cirrobio/spatial-viewer';
import { useAppStore } from '../store/sessionStore';

// Shared cell-selection draw state for the regions/subsetting panels: drawPolygons
// holds committed rings, drawRing is the in-progress clicked ring, and drawShape the
// in-progress geometric shape. Both panels need the same derived region count and the
// full polygon list — committed rings plus whatever is in progress and already encloses
// an area — to send to the backend.
export function useDrawSelection() {
  const { drawPolygons, drawRing, drawShape, commitDrawRegion, clearDraw } = useAppStore();

  const shapeRing = useMemo(() => (drawShape ? selectionShapeRing(drawShape) : null), [drawShape]);
  const regionCount = drawPolygons.length + (shapeRing ? 1 : 0) + (drawRing.length >= 3 ? 1 : 0);
  const allPolygons = [
    ...drawPolygons,
    ...(shapeRing ? [shapeRing] : []),
    ...(drawRing.length >= 3 ? [drawRing] : []),
  ];

  return {
    drawPolygons, drawRing, shapePlaced: shapeRing !== null,
    regionCount, allPolygons, commitDrawRegion, clearDraw,
  };
}
