import { useEffect, useRef } from 'react';
import type { Viewport } from '../types';

// Tolerance for "the camera is already there": viewport numbers round-trip through
// the display store (JSON) and float camera math, so exact equality would re-apply
// a viewport the canvas itself just persisted. Anything within this is a match.
const VIEWPORT_EPSILON = 1e-6;

/** True when two camera scalars agree up to viewport round-trip noise. */
export function near(a: number, b: number): boolean {
  return Math.abs(a - b) < VIEWPORT_EPSILON;
}

interface Params<VS> {
  /** Opt-in flag (the canvas's `followDisplayViewport` prop). */
  enabled: boolean;
  /** The display's persisted viewport; null means auto-fit. */
  viewport: Viewport | null;
  viewState: VS | null;
  setViewState: (vs: VS) => void;
  fitToData: () => VS | null;
  /** True when the live camera already sits on `viewport` (compare with `near`). */
  matches: (viewport: Viewport, viewState: VS) => boolean;
  /** The view state that places the camera on `viewport`. */
  apply: (viewport: Viewport, viewState: VS) => VS;
}

/**
 * Follow a viewport the host applied to the display wholesale (the embedded viewer's
 * apply-display, and the checkpoint's saved viewport on mount) into the camera.
 * Opt-in on purpose — a live session never restores a persisted viewport into a
 * mounted canvas (see useCanvasViewState), and doing so there would let another
 * viewer's PUT echo yank this one's camera. The canvas supplies only what differs
 * between cameras: `matches`/`apply` over its own view-state shape.
 */
export function useFollowDisplayViewport<VS>({
  enabled, viewport, viewState, setViewState, fitToData, matches, apply,
}: Params<VS>): void {
  // Keeps the effect one-shot per applied viewport object; a camera move the canvas
  // made itself round-trips through the store as an equal viewport and is left alone.
  // `undefined` = nothing applied yet, distinct from an applied null (auto-fit).
  const appliedViewport = useRef<Viewport | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !viewState) return;
    if (appliedViewport.current === viewport) return;
    appliedViewport.current = viewport;
    if (!viewport) {
      // null = auto-fit
      const fit = fitToData();
      if (fit) setViewState(fit);
      return;
    }
    if (matches(viewport, viewState)) return;
    setViewState(apply(viewport, viewState));
  }, [enabled, viewport, viewState, fitToData, setViewState, matches, apply]);
}
