import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PickingInfo } from '@deck.gl/core';
import { pointInRing } from '../lib/pointInPolygon';
import {
  applySelectionHandleDrag, selectionShapeFromDrag, selectionShapeHandles, selectionShapeRing,
  translateSelectionShape,
  type SelectionShape, type SelectionShapeKind, type SelectionTool,
} from '../lib/selectionShapes';
import type { ShapeHandle } from '../lib/shapeAnnotations';

type Point = [number, number];

// Pointer-to-handle grab distance in screen pixels. The drawn handle is 5px, so this is
// forgiving without letting neighbouring handles overlap.
const HANDLE_GRAB_PX = 10;
// A creation drag shorter than this (screen px) is a click, not a placement: committing
// it would leave an invisible zero-size shape where a shape used to be.
const MIN_CREATE_PX = 3;
// A dragged lasso keeps a point each time the pointer has moved this far (screen px), so
// the ring follows the hand without a vertex per pointer event.
const STROKE_STEP_PX = 3;
// The share of the square on its bounding box a dragged ring must enclose to be kept: a
// circle encloses 0.79 of it, an ellipse twelve times as long as wide 0.065, and a
// straight drag (made out of habit, to pan) next to nothing.
const MIN_RING_FILL = 0.05;

type DragTarget =
  | { kind: 'create'; tool: SelectionShapeKind; start: Point }
  | { kind: 'translate'; start: Point; origin: SelectionShape }
  | { kind: 'handle'; handleId: string };

export interface SelectionShapeEditor {
  /** The shape as it should render right now: an in-progress drag's preview, else the
   * placed one. Null when the selection has no geometric shape. */
  shape: SelectionShape | null;
  /** `shape` as a closed ring, for the overlay and for hit-testing. */
  ring: Point[] | null;
  /** Edit handles for the placed shape; empty while a creation drag is still running. */
  handles: ShapeHandle[];
  /** The ring a lasso drag is drawing, until it is released and banked with `addRing`. */
  stroke: Point[] | null;
  /** True while this gesture belongs to the shape editor — the camera's dragPan (and,
   * in an orbit view, dragRotate) has to be off before the drag starts. */
  interacting: boolean;
  cursor: string;
  onDragStart: (info: PickingInfo) => void;
  onDrag: (info: PickingInfo) => void;
  onDragEnd: () => void;
  onHover: (info: PickingInfo) => void;
}

/** Place / relocate / resize / rotate the one geometric shape a cell-selection mode has
 * in progress, and draw a lasso ring in one drag. Coordinate-space agnostic: `toCoord` maps a pick to whichever space the
 * shape is stored in (world on the spatial canvas, embedding coords in a 2D embedding,
 * screen pixels in a 3D one) and `unitsPerPixel` scales the pixel hit distances into it,
 * so the same state machine drives every canvas.
 *
 * Hit-testing is geometric rather than deck.gl picking: the handles are known positions
 * and the body is a ring, which works identically in a screen-space overlay where the
 * shape has no pickable layer at all.
 *
 * Only one shape is in progress at a time, mirroring the single in-progress lasso ring:
 * with one placed, a drag over empty canvas is left to the camera (so the view still
 * pans) and the host's Finish action is what banks it and frees the surface for the next.
 * The lasso claims every drag instead, each one a whole ring banked on release, so with it
 * armed the camera pans only while Space is held. */
export function useSelectionShape({
  enabled, tool, shape: placed, setShape, addRing, toCoord, unitsPerPixel,
}: {
  enabled: boolean;
  tool: SelectionTool;
  shape: SelectionShape | null;
  setShape: (shape: SelectionShape | null) => void;
  addRing: (ring: Point[]) => void;
  toCoord: (info: PickingInfo) => Point | null;
  unitsPerPixel: number;
}): SelectionShapeEditor {
  const [drag, setDrag] = useState<DragTarget | null>(null);
  const [preview, setPreview] = useState<SelectionShape | null>(null);
  // Kept in a ref as well, since pointer moves can arrive faster than renders.
  const strokeRef = useRef<Point[] | null>(null);
  const [stroke, setStrokeState] = useState<Point[] | null>(null);
  const setStroke = useCallback((next: Point[] | null) => {
    strokeRef.current = next;
    setStrokeState(next);
  }, []);
  const panning = useSpaceHeld(enabled);
  // What the cursor is over, tracked on hover so the controller options are already
  // right when a drag gesture starts (deck reads them at panstart, not per move).
  const [hover, setHover] = useState<'handle' | 'body' | null>(null);

  const shape = drag ? preview : placed;
  const ring = useMemo(() => (shape ? selectionShapeRing(shape) : null), [shape]);
  const handles = useMemo(
    () => (shape && drag?.kind !== 'create' ? selectionShapeHandles(shape) : []),
    [shape, drag?.kind],
  );

  const grabHandle = useCallback((pt: Point): string | null => {
    const limit = HANDLE_GRAB_PX * unitsPerPixel;
    let best: { id: string; distance: number } | null = null;
    for (const h of handles) {
      const distance = Math.hypot(h.position[0] - pt[0], h.position[1] - pt[1]);
      if (distance <= limit && (!best || distance < best.distance)) best = { id: h.id, distance };
    }
    return best?.id ?? null;
  }, [handles, unitsPerPixel]);

  const onDragStart = useCallback((info: PickingInfo) => {
    if (!enabled || panning) return;
    const pt = toCoord(info);
    if (!pt) return;
    if (placed) {
      const handleId = grabHandle(pt);
      if (handleId) {
        setDrag({ kind: 'handle', handleId });
        setPreview(placed);
        return;
      }
      if (ring && pointInRing(pt[0], pt[1], ring)) {
        setDrag({ kind: 'translate', start: pt, origin: placed });
        setPreview(placed);
        return;
      }
    }
    if (tool === 'lasso') setStroke([pt]);
    // Empty canvas with a shape already placed: the camera keeps this drag.
    else if (!placed) {
      setDrag({ kind: 'create', tool, start: pt });
      setPreview(selectionShapeFromDrag(tool, pt, pt));
    }
  }, [enabled, panning, placed, ring, tool, grabHandle, toCoord, setStroke]);

  const onDrag = useCallback((info: PickingInfo) => {
    const drawn = strokeRef.current;
    if (drawn) {
      const pt = toCoord(info);
      const last = drawn[drawn.length - 1];
      if (pt && Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= STROKE_STEP_PX * unitsPerPixel) setStroke([...drawn, pt]);
      return;
    }
    if (!drag) return;
    const pt = toCoord(info);
    if (!pt) return;
    if (drag.kind === 'create') {
      setPreview(selectionShapeFromDrag(drag.tool, drag.start, pt));
    } else if (drag.kind === 'translate') {
      setPreview(translateSelectionShape(drag.origin, pt[0] - drag.start[0], pt[1] - drag.start[1]));
    } else {
      setPreview((prev) => (prev ? applySelectionHandleDrag(prev, drag.handleId, pt) : prev));
    }
  }, [drag, toCoord, unitsPerPixel, setStroke]);

  const onDragEnd = useCallback(() => {
    const drawn = strokeRef.current;
    if (drawn) {
      // A ring needs an inside: a stroke that stayed within a few pixels was a click, and
      // one that encloses next to nothing would only leave a sliver.
      const xs = drawn.map((p) => p[0]);
      const ys = drawn.map((p) => p[1]);
      const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      let twiceArea = 0;
      for (let i = 0, j = drawn.length - 1; i < drawn.length; j = i++) {
        twiceArea += (drawn[j][0] + drawn[i][0]) * (drawn[j][1] - drawn[i][1]);
      }
      if (extent >= MIN_CREATE_PX * unitsPerPixel && Math.abs(twiceArea) / 2 >= MIN_RING_FILL * extent * extent) addRing(drawn);
      setStroke(null);
      return;
    }
    if (drag && preview) {
      // A creation gesture that never really moved is a click; leave whatever was there.
      const placement = drag.kind !== 'create'
        || Math.max(preview.radiusX, preview.radiusY) >= (MIN_CREATE_PX * unitsPerPixel) / 2;
      if (placement) setShape(preview);
    }
    setDrag(null);
    setPreview(null);
  }, [drag, preview, setShape, addRing, unitsPerPixel, setStroke]);

  const onHover = useCallback((info: PickingInfo) => {
    if (drag) return; // the target is fixed for the duration of a drag
    if (!enabled || !placed || !ring) {
      setHover(null);
      return;
    }
    const pt = toCoord(info);
    if (!pt) {
      setHover(null);
      return;
    }
    setHover(grabHandle(pt) ? 'handle' : pointInRing(pt[0], pt[1], ring) ? 'body' : null);
  }, [drag, enabled, placed, ring, grabHandle, toCoord]);

  const interacting = enabled && !panning && (drag !== null || stroke !== null || hover !== null || tool === 'lasso' || !placed);
  const cursor = panning ? 'grab'
    : drag?.kind === 'translate' || hover === 'body' ? 'move'
    : hover === 'handle' ? 'pointer'
    // With a shape placed, an armed tool no longer claims empty canvas — that drag pans.
    : placed && tool !== 'lasso' ? 'grab'
    : 'crosshair';

  return { shape, ring, handles, stroke, interacting, cursor, onDragStart, onDrag, onDragEnd, onHover };
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName));

/** Whether Space is held while drawing is armed: the drawing tools' way back to panning.
 * Left to a focused field or button, where Space types or presses. */
function useSpaceHeld(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const down = (e: KeyboardEvent) => {
      if (e.key !== ' ' || typing(e.target)) return;
      e.preventDefault();
      setHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') setHeld(false);
    };
    // A key released in another window never reports here.
    const release = () => setHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', release);
      setHeld(false);
    };
  }, [enabled]);
  return held;
}
