import { useCallback, useMemo, useState } from 'react';
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
 * in progress. Coordinate-space agnostic: `toCoord` maps a pick to whichever space the
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
 * pans) and the host's Finish action is what banks it and frees the surface for the next. */
export function useSelectionShape({
  enabled, tool, shape: placed, setShape, toCoord, unitsPerPixel,
}: {
  enabled: boolean;
  tool: SelectionTool;
  shape: SelectionShape | null;
  setShape: (shape: SelectionShape | null) => void;
  toCoord: (info: PickingInfo) => Point | null;
  unitsPerPixel: number;
}): SelectionShapeEditor {
  const [drag, setDrag] = useState<DragTarget | null>(null);
  const [preview, setPreview] = useState<SelectionShape | null>(null);
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
    if (!enabled) return;
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
      }
      return; // empty canvas with a shape already placed: the camera keeps this drag
    }
    if (tool === 'lasso') return;
    setDrag({ kind: 'create', tool, start: pt });
    setPreview(selectionShapeFromDrag(tool, pt, pt));
  }, [enabled, placed, ring, tool, grabHandle, toCoord]);

  const onDrag = useCallback((info: PickingInfo) => {
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
  }, [drag, toCoord]);

  const onDragEnd = useCallback(() => {
    if (drag && preview) {
      // A creation gesture that never really moved is a click; leave whatever was there.
      const placement = drag.kind !== 'create'
        || Math.max(preview.radiusX, preview.radiusY) >= (MIN_CREATE_PX * unitsPerPixel) / 2;
      if (placement) setShape(preview);
    }
    setDrag(null);
    setPreview(null);
  }, [drag, preview, setShape, unitsPerPixel]);

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

  const interacting = enabled && (drag !== null || hover !== null || (!placed && tool !== 'lasso'));
  const cursor = drag?.kind === 'translate' || hover === 'body' ? 'move'
    : hover === 'handle' ? 'pointer'
    // With a shape placed, an armed tool no longer claims empty canvas — that drag pans.
    : placed && tool !== 'lasso' ? 'grab'
    : 'crosshair';

  return { shape, ring, handles, interacting, cursor, onDragStart, onDrag, onDragEnd, onHover };
}
