import { useState, useEffect, useCallback, type RefObject } from 'react';
import type { OrthographicViewState } from '@deck.gl/core';
import type { SpatialDisplaySpec, ImageInfo } from '../../types';
import type { ScatterPositions } from './useArrowPositions';
import { ZOOM_LIMITS, fitZoom, useCanvasSize } from './viewFit';

// Zoom at which a cell of characteristic world diameter d reaches SHAPES_MIN_CELL_PX
// on screen (d * 2**zoom px = px ⇒ zoom = log2(px / d)). Below this the cells are too
// small to warrant their polygon outlines, so the shapes fetch is deferred — the
// viewport would hold more cells than the backend ships anyway. Points cover the view.
export const SHAPES_MIN_CELL_PX = 6;
export function shapesFetchZoomThreshold(meanSpacingWorld: number): number {
  return Math.log2(SHAPES_MIN_CELL_PX / Math.max(meanSpacingWorld, 1e-9));
}

interface Params {
  positions: ScatterPositions | null;
  imageInfo: ImageInfo | null;
  showImage: boolean;
  display: SpatialDisplaySpec;
}

export function useCanvasViewState(
  { positions, imageInfo, showImage, display }: Params,
): {
  containerRef: RefObject<HTMLDivElement>;
  canvasSize: { width: number; height: number } | null;
  viewState: OrthographicViewState | null;
  setViewState: (vs: OrthographicViewState) => void;
  fitToData: () => OrthographicViewState | null;
} {
  const [viewState, setViewState] = useState<OrthographicViewState | null>(null);
  const { containerRef, canvasSize } = useCanvasSize();

  // Compute a view state that frames the data bounds within the current canvas size.
  const fitToData = useCallback((): OrthographicViewState | null => {
    if (!positions) return null;
    let { d0min, d0max, d1min, d1max } = positions.bounds;
    // Frame the whole section: union the spot extent with the image extent when the
    // image is shown, so a tissue image larger than the spots is fully visible.
    if (showImage && imageInfo) {
      const [ix0, iy0, ix1, iy1] = imageInfo.bounds;
      d0min = Math.min(d0min, ix0, ix1);
      d0max = Math.max(d0max, ix0, ix1);
      d1min = Math.min(d1min, iy0, iy1);
      d1max = Math.max(d1max, iy0, iy1);
    }
    // An empty table (0 rows) leaves bounds at ±Infinity; guard the center so the
    // viewport target never becomes NaN (which silently blanks the canvas).
    const centerX = Number.isFinite(d0min + d0max) ? (d0min + d0max) / 2 : 0;
    const centerY = Number.isFinite(d1min + d1max) ? (d1min + d1max) / 2 : 0;
    const extentX = Math.max(1, d0max - d0min);
    const extentY = Math.max(1, d1max - d1min);
    const el = containerRef.current;
    const zoom = fitZoom(extentX, extentY, el?.clientWidth || window.innerWidth, el?.clientHeight || window.innerHeight);
    return { target: [centerX, centerY, 0], zoom, ...ZOOM_LIMITS };
  }, [positions, showImage, imageInfo, containerRef]);

  // A freshly loaded session always frames its data (the persisted display viewport
  // is not restored here — it only seeds a snapshot's viewport server-side). The
  // canvas is remounted per session (key on the session id in App), so this runs
  // once per session load. Wait for the image bounds before the first fit when a
  // tissue image is shown, so the whole section (which can extend beyond the spots)
  // is framed, not just the spots.
  useEffect(() => {
    if (viewState) return;
    if (!positions) return;
    if (display.encoding.image_layer && !imageInfo) return;
    const fit = fitToData();
    if (fit) setViewState(fit);
  }, [fitToData, display.encoding.image_layer, imageInfo, positions, viewState]);

  return { containerRef, canvasSize, viewState, setViewState, fitToData };
}
