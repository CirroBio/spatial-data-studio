import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';
import type { OrthographicViewState, OrbitViewState } from '@deck.gl/core';
import type { EmbeddingDisplaySpec, Viewport } from '../../types';
import type { ArrowPositions } from './useArrowPositions';

const ZOOM_LIMITS = { minZoom: -8, maxZoom: 8 };
const DEFAULT_ROTATION_X = 25;

export type EmbeddingViewState = OrthographicViewState | OrbitViewState;

interface Params {
  positions: ArrowPositions | null;
  is3d: boolean;
  display: EmbeddingDisplaySpec;
}

function viewStateFromViewport(viewport: Viewport, is3d: boolean): EmbeddingViewState {
  if (is3d) {
    return {
      target: [viewport.target[0], viewport.target[1], viewport.target[2] ?? 0],
      zoom: viewport.zoom,
      rotationX: viewport.rotationX ?? DEFAULT_ROTATION_X,
      rotationOrbit: viewport.rotationOrbit ?? 0,
      ...ZOOM_LIMITS,
    };
  }
  return { target: [viewport.target[0], viewport.target[1], 0], zoom: viewport.zoom, ...ZOOM_LIMITS };
}

// 2D-or-3D view state for the embeddings scatter: an OrthographicView (pan/zoom)
// or an OrbitView (rotate/zoom) depending on the 3D toggle. Kept separate from
// useCanvasViewState — the view-state shape and view class genuinely differ, and
// there's no image layer/bounds to union in here.
export function useEmbeddingViewState(
  { positions, is3d, display }: Params,
): {
  containerRef: RefObject<HTMLDivElement>;
  canvasSize: { width: number; height: number } | null;
  viewState: EmbeddingViewState | null;
  setViewState: (vs: EmbeddingViewState) => void;
  fitToData: () => EmbeddingViewState | null;
} {
  const [viewState, setViewState] = useState<EmbeddingViewState | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setCanvasSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Same log2(pixels / extent) fit-to-data math as useCanvasViewState; adds a
  // centered Z target in 3D so the orbit camera starts looking at the point cloud.
  const fitToData = useCallback((): EmbeddingViewState | null => {
    if (!positions) return null;
    const { d0min, d0max, d1min, d1max, d2min, d2max } = positions.bounds;
    const centerX = (d0min + d0max) / 2;
    const centerY = (d1min + d1max) / 2;
    const extentX = Math.max(1, d0max - d0min);
    const extentY = Math.max(1, d1max - d1min);
    const el = containerRef.current;
    const pxW = el?.clientWidth || window.innerWidth;
    const pxH = el?.clientHeight || window.innerHeight;
    const MARGIN = 0.9;
    const zoom = Math.log2(Math.min((pxW * MARGIN) / extentX, (pxH * MARGIN) / extentY));
    if (is3d) {
      const centerZ = d2min !== undefined && d2max !== undefined ? (d2min + d2max) / 2 : 0;
      return { target: [centerX, centerY, centerZ], zoom, rotationX: DEFAULT_ROTATION_X, rotationOrbit: 0, ...ZOOM_LIMITS };
    }
    return { target: [centerX, centerY, 0], zoom, ...ZOOM_LIMITS };
  }, [positions, is3d]);

  // Initial view state: the saved display viewport, else fit to data.
  useEffect(() => {
    if (viewState) return;
    if (display.viewport) {
      setViewState(viewStateFromViewport(display.viewport, is3d));
      return;
    }
    if (!positions) return;
    const fit = fitToData();
    if (fit) setViewState(fit);
  }, [fitToData, display.viewport, positions, viewState, is3d]);

  // The 2D and 3D view-state shapes aren't interchangeable — re-fit on toggle
  // rather than trying to carry an orthographic pan/zoom into an orbit camera.
  const is3dRef = useRef(is3d);
  useEffect(() => {
    if (is3dRef.current === is3d) return;
    is3dRef.current = is3d;
    const fit = fitToData();
    if (fit) setViewState(fit);
  }, [is3d, fitToData]);

  return { containerRef, canvasSize, viewState, setViewState, fitToData };
}
