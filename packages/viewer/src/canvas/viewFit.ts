import { useState, useEffect, useRef, type RefObject } from 'react';

// Shared camera-fit primitives for the spatial and embedding canvases. Kept in one
// place so the zoom range and fit math can't drift between the views that must
// frame data identically.
export const ZOOM_LIMITS = { minZoom: -8, maxZoom: 8 };
// Zoom delta per zoom-button click (OrthographicView zoom is log2, so 0.5 ≈ 1.41× per step).
export const ZOOM_STEP = 0.5;
const FIT_MARGIN = 0.9; // leave ~10% padding around the data

/** The zoom level the canvas is actually rendering at, from a deck view state.
 *
 * Two things make this more than a property read. `zoom` may be a per-axis `[x, y]`
 * array, and when `zoomX`/`zoomY` are present `FlipOrthographicViewport` renders at
 * `min(zoomX, zoomY)` — so anything deriving a threshold from `zoom` alone (text sizing,
 * the shapes-fetch cutoff, arrowhead scale, the minimap window, the persisted viewport)
 * could disagree with what is on screen. One helper so they all read the same number. */
export function effectiveZoom(
  vs: { zoom?: number | number[]; zoomX?: number; zoomY?: number } | null | undefined,
): number {
  if (!vs) return 0;
  const base = (Array.isArray(vs.zoom) ? vs.zoom[0] : vs.zoom) ?? 0;
  return Math.min(vs.zoomX ?? base, vs.zoomY ?? base);
}

// Zoom that frames a world extent (extentX x extentY) inside a pixel viewport
// (pxW x pxH). OrthographicView: world units per pixel = 1 / 2**zoom, so fitting
// an extent E into P pixels needs zoom = log2(P / E).
export function fitZoom(extentX: number, extentY: number, pxW: number, pxH: number): number {
  return Math.log2(Math.min((pxW * FIT_MARGIN) / extentX, (pxH * FIT_MARGIN) / extentY));
}

/** The midpoint of an axis range, or 0 for a range that has none.
 *
 * A 0-row table leaves `useArrowPositions` bounds at +/-Infinity, whose sum is NaN, and a
 * NaN in a viewport target silently blanks the canvas instead of failing. Every axis of
 * every fit — including the embedding's Z — goes through here so none can miss the guard. */
export function finiteMidpoint(min: number, max: number): number {
  return Number.isFinite(min + max) ? (min + max) / 2 : 0;
}

/** The 2D world extent a camera is asked to frame. */
export interface FitBounds {
  d0min: number;
  d0max: number;
  d1min: number;
  d1max: number;
}

/** Where the camera sits and how far in, in the coordinate space the bounds are in. */
export interface CanvasFit {
  centerX: number;
  centerY: number;
  zoom: number;
}

/** Frame `bounds` inside a pxW x pxH canvas, or null when no camera can be derived.
 *
 * Both canvases fit through this one function so neither can hold a guard the other
 * lacks — which is exactly how they drifted before: the embedding hook fitted against
 * `window.innerWidth` and had neither the +/-Infinity centre guard nor the non-finite
 * zoom bail, so an empty table and a hidden container each pointed its camera nowhere.
 *
 * Null in two cases, both meaning "no camera yet, ask again":
 *  - the canvas is unmeasured (0 px). Fitting into it yields zoom = log2(0) = -Infinity,
 *    and since each hook only fits until one lands, that value would stick and blank
 *    every layer. Both hooks re-run when the observed size arrives.
 *  - the zoom is still non-finite (a degenerate extent against a degenerate viewport). */
export function fitBounds(bounds: FitBounds, pxW: number, pxH: number): CanvasFit | null {
  if (!(pxW > 0 && pxH > 0)) return null;
  const zoom = fitZoom(
    Math.max(1, bounds.d0max - bounds.d0min),
    Math.max(1, bounds.d1max - bounds.d1min),
    pxW,
    pxH,
  );
  if (!Number.isFinite(zoom)) return null;
  return {
    centerX: finiteMidpoint(bounds.d0min, bounds.d0max),
    centerY: finiteMidpoint(bounds.d1min, bounds.d1max),
    zoom,
  };
}

/** The pixel box to fit against: the size the ResizeObserver has reported, falling back
 * to the element's current layout size, then to zero (which `fitBounds` rejects).
 *
 * Never the window: the element's own box is what the camera has to frame, and a hidden
 * or pre-layout container measures 0, so a fit taken then must be refused rather than
 * aimed at the wrong box. */
export function measuredCanvasSize(
  canvasSize: { width: number; height: number } | null,
  containerRef: RefObject<HTMLDivElement | null>,
): { width: number; height: number } {
  return {
    width: canvasSize?.width ?? containerRef.current?.clientWidth ?? 0,
    height: canvasSize?.height ?? containerRef.current?.clientHeight ?? 0,
  };
}

// Track the canvas element's pixel size so a tile layer can pick a level of detail,
// enumerate visible tiles, and drive the fit math.
export function useCanvasSize(): {
  containerRef: RefObject<HTMLDivElement | null>;
  canvasSize: { width: number; height: number } | null;
} {
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
  return { containerRef, canvasSize };
}
