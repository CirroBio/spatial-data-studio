// Geometric cell-selection shapes — circle, ellipse, square, rectangle. One is placed
// with a single drag and then relocated, resized and rotated by its handles, the same
// interaction the shape-annotation editor offers for its ellipse and box; what it
// produces, though, is a ring of points unioned into the very selection the click-built
// lasso feeds (indicesInRings on the client, `polygons` for the backend polygon_query).
// Nothing here is persisted — a selection shape is a gesture, not an annotation.
//
// Kept centre-parametrized rather than stored as four free vertices like a 'box'
// annotation: that is what keeps a rectangle rectangular under a resize, keeps a
// rotation independent of the corners, and leaves a zero-size shape recoverable (its
// axes come from `rotation`, so its handles still have somewhere to be).
import {
  ROTATE_HANDLE_ID, centeredRotateHandle, rotatePoint, shapeOutline, type ShapeHandle,
} from './shapeAnnotations';

type Point = [number, number];

export const SELECTION_SHAPE_KINDS = ['circle', 'ellipse', 'square', 'rectangle'] as const;
export type SelectionShapeKind = (typeof SELECTION_SHAPE_KINDS)[number];
/** What a canvas drag does in a cell-selection mode: 'lasso' collects ring vertices a
 * click at a time (the original behavior); any other value places that geometric shape. */
export type SelectionTool = 'lasso' | SelectionShapeKind;

export interface SelectionShape {
  kind: SelectionShapeKind;
  center: Point;
  /** Half-extent along the shape's own x/y axis; equal for a circle or square. */
  radiusX: number;
  radiusY: number;
  /** Radians about the centre. Stays 0 for a circle, which rotation cannot change. */
  rotation: number;
}

/** Handle id of the single half-extent handle an aspect-locked (circle/square) shape
 * gets in place of the separate radiusX/radiusY pair. */
export const RADIUS_HANDLE_ID = 'radius';
// Handle id of the centre handle every selection shape gets — drag it to relocate.
const CENTER_HANDLE_ID = 'center';

// Round shapes approximate to an ellipse outline; the others are four corners.
const ROUND: Record<SelectionShapeKind, boolean> = {
  circle: true, ellipse: true, square: false, rectangle: false,
};
// Aspect-locked shapes keep radiusX === radiusY through creation and every resize.
const LOCKED: Record<SelectionShapeKind, boolean> = {
  circle: true, square: true, ellipse: false, rectangle: false,
};

/** Shape from a drag's down-point and current point. p0/p1 are opposite corners of the
 * bounding box and the shape is inscribed in it — the same reading of the drag as the
 * ellipse and box annotation tools, so one gesture yields shapes of identical extent
 * whichever kind is armed. A locked kind takes the larger drag axis for both extents
 * and anchors on the down-point corner, so it grows toward the cursor rather than
 * around it. */
export function selectionShapeFromDrag(kind: SelectionShapeKind, p0: Point, p1: Point): SelectionShape {
  const halfX = Math.abs(p1[0] - p0[0]) / 2;
  const halfY = Math.abs(p1[1] - p0[1]) / 2;
  if (LOCKED[kind]) {
    const r = Math.max(halfX, halfY);
    const center: Point = [p0[0] + (p1[0] >= p0[0] ? r : -r), p0[1] + (p1[1] >= p0[1] ? r : -r)];
    return { kind, center, radiusX: r, radiusY: r, rotation: 0 };
  }
  return {
    kind,
    center: [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2],
    radiusX: halfX,
    radiusY: halfY,
    rotation: 0,
  };
}

/** Closed ring approximating the shape, in the same coordinate space as its centre —
 * what the point-in-polygon selection tests and every renderer draws. */
export function selectionShapeRing(shape: SelectionShape): Point[] {
  const { center, radiusX, radiusY, rotation } = shape;
  if (ROUND[shape.kind]) return shapeOutline({ kind: 'ellipse', center, radiusX, radiusY, rotation });
  const corners: Point[] = [[-radiusX, -radiusY], [radiusX, -radiusY], [radiusX, radiusY], [-radiusX, radiusY]];
  return corners.map(([dx, dy]) => rotatePoint([center[0] + dx, center[1] + dy], center, rotation));
}

/** Edit handles: the centre (drag to relocate), one half-extent handle per free axis
 * (an aspect-locked kind gets a single one driving both), and a rotate handle floating
 * off the shape's own +Y axis — omitted for a circle, which rotation leaves unchanged. */
export function selectionShapeHandles(shape: SelectionShape): ShapeHandle[] {
  const { center, radiusX, radiusY, rotation } = shape;
  const at = (dx: number, dy: number): Point =>
    rotatePoint([center[0] + dx, center[1] + dy], center, rotation);
  const handles: ShapeHandle[] = [{ id: CENTER_HANDLE_ID, position: center }];
  if (LOCKED[shape.kind]) {
    handles.push({ id: RADIUS_HANDLE_ID, position: at(radiusX, 0) });
  } else {
    handles.push({ id: 'radiusX', position: at(radiusX, 0) }, { id: 'radiusY', position: at(0, radiusY) });
  }
  if (shape.kind !== 'circle') {
    handles.push({ id: ROTATE_HANDLE_ID, position: centeredRotateHandle(center, radiusX, radiusY, rotation) });
  }
  return handles;
}

/** Move the whole shape by (dx, dy), leaving its size and rotation intact. */
export function translateSelectionShape(shape: SelectionShape, dx: number, dy: number): SelectionShape {
  return { ...shape, center: [shape.center[0] + dx, shape.center[1] + dy] };
}

/** Apply a handle drag (a handle id from `selectionShapeHandles`) to `newPos`. */
export function applySelectionHandleDrag(shape: SelectionShape, handleId: string, newPos: Point): SelectionShape {
  if (handleId === CENTER_HANDLE_ID) return { ...shape, center: newPos };
  if (handleId === ROTATE_HANDLE_ID) {
    const { center, radiusX, radiusY, rotation } = shape;
    // Magnitude is irrelevant; the handle's direction encodes the current angle.
    const handle = centeredRotateHandle(center, radiusX, radiusY, rotation);
    const delta = Math.atan2(newPos[1] - center[1], newPos[0] - center[0])
      - Math.atan2(handle[1] - center[1], handle[0] - center[0]);
    return { ...shape, rotation: rotation + delta };
  }
  // Project the drag into the shape's own unrotated frame so a half-extent handle
  // tracks along its rotated axis rather than the world x/y axis.
  const local = rotatePoint(newPos, shape.center, -shape.rotation);
  const dx = Math.abs(local[0] - shape.center[0]);
  const dy = Math.abs(local[1] - shape.center[1]);
  // Every id reaching here came from `selectionShapeHandles`, so anything else is a
  // wiring bug: a locked kind offers no per-axis handle, and honouring one anyway would
  // quietly turn a circle into an ellipse.
  if (LOCKED[shape.kind]) {
    if (handleId !== RADIUS_HANDLE_ID) throw new Error(`unknown ${shape.kind} selection handle '${handleId}'`);
    // One handle, both axes: a circle takes the radial distance to the cursor, a square
    // the larger component — its handle sits on an edge, so either direction resizes it.
    const r = shape.kind === 'circle' ? Math.hypot(dx, dy) : Math.max(dx, dy);
    return { ...shape, radiusX: r, radiusY: r };
  }
  if (handleId === 'radiusX') return { ...shape, radiusX: dx };
  if (handleId === 'radiusY') return { ...shape, radiusY: dy };
  throw new Error(`unknown ${shape.kind} selection handle '${handleId}'`);
}
