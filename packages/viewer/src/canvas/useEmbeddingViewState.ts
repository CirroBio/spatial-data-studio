import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';
import type { OrthographicViewState, OrbitViewState } from '@deck.gl/core';
import type { ScatterPositions } from './useArrowPositions';
import { ZOOM_LIMITS, fitZoom, useCanvasSize } from './viewFit';

const DEFAULT_ROTATION_X = 25;
// Let the orbit camera tilt through the full pitch circle (deck defaults to +/-90,
// which walls the drag at straight-down/up); +/-180 lets a rotate-drag reach every
// angle, including inverted.
const ROTATION_LIMITS = { minRotationX: -180, maxRotationX: 180 };

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
  containerRef: RefObject<HTMLDivElement | null>;
  canvasSize: { width: number; height: number } | null;
  viewState: EmbeddingViewState | null;
  setViewState: (vs: EmbeddingViewState) => void;
  fitToData: () => EmbeddingViewState | null;
} {
  const [viewState, setViewState] = useState<EmbeddingViewState | null>(null);
  const { containerRef, canvasSize } = useCanvasSize();

  // Same fit-to-data math as useCanvasViewState (see viewFit.fitZoom); adds a
  // centered Z target in 3D so the orbit camera starts looking at the point cloud.
  const fitToData = useCallback((): EmbeddingViewState | null => {
    if (!positions) return null;
    const { d0min, d0max, d1min, d1max, d2min, d2max } = positions.bounds;
    const centerX = (d0min + d0max) / 2;
    const centerY = (d1min + d1max) / 2;
    const extentX = Math.max(1, d0max - d0min);
    const extentY = Math.max(1, d1max - d1min);
    const el = containerRef.current;
    const zoom = fitZoom(extentX, extentY, el?.clientWidth || window.innerWidth, el?.clientHeight || window.innerHeight);
    if (is3d) {
      const centerZ = d2min !== undefined && d2max !== undefined ? (d2min + d2max) / 2 : 0;
      return { target: [centerX, centerY, centerZ], zoom, rotationX: DEFAULT_ROTATION_X, rotationOrbit: 0, ...ROTATION_LIMITS, ...ZOOM_LIMITS };
    }
    return { target: [centerX, centerY, 0], zoom, ...ZOOM_LIMITS };
  }, [positions, is3d, containerRef]);

  // Frames the data on first load, and re-frames whenever the data occupies a different
  // extent — the camera IS in the plotted coordinate space, so one framed for a UMAP's
  // single digits points somewhere arbitrary once the same canvas plots a PCA's tens or
  // pixel coordinates in the thousands. This used to fit only while there was no camera
  // at all, which held for the Studio (a canvas per session) but left any host that
  // switches coordinates in place — or any switch of the plotted key here — pointed at
  // the wrong place.
  //
  // Keyed on the extent rather than on the obsm key, because only the extent is in step
  // with `positions`: the key changes on the pick, the fetch is marked in flight a render
  // later, and the positions arrive a commit after the table does. Every key-derived
  // identity tried here fitted the outgoing data and then refused the incoming. Panning
  // and recolouring leave the extent alone, so neither re-frames; recomputed coordinates
  // legitimately do.
  const framedExtent = useRef<string | null>(null);
  useEffect(() => {
    if (!positions) return;
    const { d0min, d0max, d1min, d1max, d2min, d2max } = positions.bounds;
    const extent = `${d0min},${d0max},${d1min},${d1max},${d2min},${d2max},${is3d}`;
    if (viewState && framedExtent.current === extent) return;
    // Not against an unmeasured canvas: `fitToData` falls back to the window, which is
    // itself zero for a hidden one, and the resulting camera frames nothing. Leaving the
    // marker alone means the real size arriving retries, as `useCanvasViewState` does.
    if (!canvasSize) return;
    const fit = fitToData();
    if (!fit) return;
    framedExtent.current = extent;
    setViewState(fit);
  }, [fitToData, positions, viewState, canvasSize, is3d]);

  // The 2D and 3D view-state shapes aren't interchangeable — re-fit on toggle
  // rather than trying to carry an orthographic pan/zoom into an orbit camera.
  // (DeckGL is also remounted on toggle — see the key in EmbeddingCanvas — so its
  // controller is rebuilt for the new view class instead of reusing the stale one.)
  const is3dRef = useRef(is3d);
  useEffect(() => {
    if (is3dRef.current === is3d) return;
    is3dRef.current = is3d;
    const fit = fitToData();
    if (fit) setViewState(fit);
  }, [is3d, fitToData]);

  return { containerRef, canvasSize, viewState, setViewState, fitToData };
}
