import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';
import type { OrthographicViewState, OrbitViewState } from '@deck.gl/core';
import type { ScatterPositions } from './useArrowPositions';

const ZOOM_LIMITS = { minZoom: -8, maxZoom: 8 };
const DEFAULT_ROTATION_X = 25;

export type EmbeddingViewState = OrthographicViewState | OrbitViewState;

interface Params {
  positions: ScatterPositions | null;
  is3d: boolean;
}

// 2D-or-3D view state for the embeddings scatter: an OrthographicView (pan/zoom)
// or an OrbitView (rotate/zoom) depending on the 3D toggle. Kept separate from
// useCanvasViewState — the view-state shape and view class genuinely differ, and
// there's no image layer/bounds to union in here.
export function useEmbeddingViewState(
  { positions, is3d }: Params,
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

  // A freshly loaded session always frames its data; the persisted display viewport
  // is not restored here (the canvas is remounted per session — key on the session id
  // in App — so this runs once per session load).
  useEffect(() => {
    if (viewState) return;
    if (!positions) return;
    const fit = fitToData();
    if (fit) setViewState(fit);
  }, [fitToData, positions, viewState]);

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
