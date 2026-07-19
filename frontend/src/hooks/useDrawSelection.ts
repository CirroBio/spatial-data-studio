import { useAppStore } from '../store/sessionStore';

// Shared polygon draw-selection state for the annotations/subsetting panels:
// drawPolygons holds committed rings, drawRing is the in-progress ring. Both
// panels need the same derived region count and the full polygon list (rings
// + the in-progress ring once it's closeable) to send to the backend.
export function useDrawSelection() {
  const { drawPolygons, drawRing, commitDrawRing, clearDraw } = useAppStore();

  const regionCount = drawPolygons.length + (drawRing.length >= 3 ? 1 : 0);
  const allPolygons = drawRing.length >= 3 ? [...drawPolygons, drawRing] : drawPolygons;

  return { drawPolygons, drawRing, regionCount, allPolygons, commitDrawRing, clearDraw };
}
