import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';
import type { OrthographicViewState } from '@deck.gl/core';
import type { SpatialDisplaySpec, ImageInfo } from '../types';
import type { ScatterPositions } from './useArrowPositions';
import { ZOOM_LIMITS, fitBounds, measuredCanvasSize, useCanvasSize } from './viewFit';

// Zoom at which a cell of characteristic world diameter d reaches SHAPES_MIN_CELL_PX
// on screen (d * 2**zoom px = px ⇒ zoom = log2(px / d)). Below this the cells are too
// small to warrant their polygon outlines, so the shapes fetch is deferred — the
// viewport would hold more cells than the backend ships anyway. Points cover the view.
const SHAPES_MIN_CELL_PX = 6;
export function shapesFetchZoomThreshold(meanSpacingWorld: number): number {
  return Math.log2(SHAPES_MIN_CELL_PX / Math.max(meanSpacingWorld, 1e-9));
}

interface Params {
  positions: ScatterPositions | null;
  imageInfo: ImageInfo | null;
  // The image-info fetch failed terminally: stop waiting for the image and fall
  // through to the world-space spot-bounds fit (imageInfo stays null, so the
  // no-affine rendering path applies).
  imageInfoFailed: boolean;
  showImage: boolean;
  display: SpatialDisplaySpec;
}

export function useCanvasViewState(
  { positions, imageInfo, imageInfoFailed, showImage, display }: Params,
): {
  containerRef: RefObject<HTMLDivElement | null>;
  canvasSize: { width: number; height: number } | null;
  viewState: OrthographicViewState | null;
  setViewState: (vs: OrthographicViewState) => void;
  fitToData: () => OrthographicViewState | null;
} {
  const [viewState, setViewState] = useState<OrthographicViewState | null>(null);
  const { containerRef, canvasSize } = useCanvasSize();

  // Compute a view state that frames the data bounds within the current canvas size.
  // The extent to frame is this canvas' own business; the guards on it (unmeasured
  // canvas, empty bounds, non-finite zoom) all live in `fitBounds`, shared with the
  // embedding canvas. Null from there means "no camera yet": the effect below only
  // fits until one lands and re-runs when `canvasSize` arrives, so the first real fit
  // lands as soon as layout settles.
  const fitToData = useCallback((): OrthographicViewState | null => {
    if (!positions) return null;
    const { width, height } = measuredCanvasSize(canvasSize, containerRef);
    // When the display has an image, the canvas coordinate space IS the image's pixel
    // space (SpatialCanvas: image at [0,0,W,H], points carry a world->pixel modelMatrix),
    // so frame the image's level-0 pixel extent. The cells overlay it.
    if (display.encoding.image_layer && imageInfo?.pixel_to_world && imageInfo.levels.length) {
      const { width: W, height: H } = imageInfo.levels[0];
      const fit = fitBounds({ d0min: 0, d0max: W, d1min: 0, d1max: H }, width, height);
      if (!fit) return null;
      return { target: [fit.centerX, fit.centerY, 0], zoom: fit.zoom, ...ZOOM_LIMITS };
    }
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
    const fit = fitBounds({ d0min, d0max, d1min, d1max }, width, height);
    if (!fit) return null;
    return { target: [fit.centerX, fit.centerY, 0], zoom: fit.zoom, ...ZOOM_LIMITS };
  }, [positions, showImage, imageInfo, canvasSize, containerRef, display.encoding.image_layer]);

  // A freshly loaded session always frames its data (the persisted display viewport
  // is not restored here — it only seeds a snapshot's viewport server-side). The
  // canvas is remounted per session (key on the session id in App), so this runs
  // once per session load. Wait for the image bounds before the first fit when a
  // tissue image is shown, so the whole section (which can extend beyond the spots)
  // is framed, not just the spots — unless the image-info fetch failed, in which
  // case the spots are all there is to frame.
  //
  // It also runs again whenever the image element changes: the canvas coordinate space
  // IS the chosen image's pixel space, so a camera framed for the previous element (or
  // for world space) points somewhere arbitrary in the new one. `framedElement` only
  // advances once a fit actually lands, so an unsized canvas or a pending image info
  // retries rather than leaving the new element unframed.
  const framedElement = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const element = display.encoding.image_layer;
    if (viewState && framedElement.current === element) return;
    if (!positions) return;
    if (element && !imageInfo && !imageInfoFailed) return;
    const fit = fitToData();
    if (!fit) return;
    framedElement.current = element;
    setViewState(fit);
  }, [fitToData, display.encoding.image_layer, imageInfo, imageInfoFailed, positions, viewState]);

  return { containerRef, canvasSize, viewState, setViewState, fitToData };
}
