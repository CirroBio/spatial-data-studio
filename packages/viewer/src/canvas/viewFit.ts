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
