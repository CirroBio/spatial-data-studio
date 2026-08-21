// A selection shape that is subtly wrong fails silently: it still draws as a plausible
// circle or rectangle, and the only symptom is that the wrong cells get labelled. So the
// checks here are on the properties the interaction promises — the drag covers what the
// user dragged over, an aspect-locked kind stays locked through every resize, a rotated
// shape resizes along its own axes rather than the world's, and the ring the selection is
// actually tested against agrees with the parameters.
import { describe, expect, it } from 'vitest';
import { pointInRing } from './pointInPolygon';
import { ROTATE_HANDLE_ID } from './shapeAnnotations';
import {
  RADIUS_HANDLE_ID, SELECTION_SHAPE_KINDS, applySelectionHandleDrag, selectionShapeFromDrag,
  selectionShapeHandles, selectionShapeRing, translateSelectionShape,
  type SelectionShape,
} from './selectionShapes';

type Point = [number, number];

const handleAt = (shape: SelectionShape, id: string): Point => {
  const handle = selectionShapeHandles(shape).find((h) => h.id === id);
  if (!handle) throw new Error(`no '${id}' handle on a ${shape.kind}`);
  return handle.position;
};

describe('selectionShapeFromDrag', () => {
  it('inscribes a free-aspect shape in the drag box', () => {
    for (const kind of ['ellipse', 'rectangle'] as const) {
      const shape = selectionShapeFromDrag(kind, [10, 20], [30, 60]);
      expect(shape.center).toEqual([20, 40]);
      expect(shape.radiusX).toBe(10);
      expect(shape.radiusY).toBe(20);
      expect(shape.rotation).toBe(0);
    }
  });

  it('squares off a locked shape on the larger drag axis, anchored at the down-point', () => {
    for (const kind of ['circle', 'square'] as const) {
      const shape = selectionShapeFromDrag(kind, [10, 20], [30, 60]);
      expect(shape.radiusX).toBe(20);
      expect(shape.radiusY).toBe(20);
      // Grows toward the cursor: the corner the drag started from stays on the boundary.
      expect(shape.center).toEqual([30, 40]);
    }
  });

  it('reads the drag corner-to-corner whichever way it runs', () => {
    for (const kind of SELECTION_SHAPE_KINDS) {
      const forward = selectionShapeFromDrag(kind, [0, 0], [40, 40]);
      const backward = selectionShapeFromDrag(kind, [40, 40], [0, 0]);
      expect(backward.center).toEqual(forward.center);
      expect(backward.radiusX).toBe(forward.radiusX);
      expect(backward.radiusY).toBe(forward.radiusY);
    }
  });
});

describe('selectionShapeRing', () => {
  it('encloses a circle by its radius, not its bounding box', () => {
    const ring = selectionShapeRing({ kind: 'circle', center: [0, 0], radiusX: 10, radiusY: 10, rotation: 0 });
    expect(pointInRing(9.5, 0, ring)).toBe(true);
    expect(pointInRing(0, -9.5, ring)).toBe(true);
    // The bounding box's corner is outside the circle inscribed in it.
    expect(pointInRing(9, 9, ring)).toBe(false);
    expect(pointInRing(11, 0, ring)).toBe(false);
  });

  it('rotates a rectangle about its centre', () => {
    const upright: SelectionShape = { kind: 'rectangle', center: [0, 0], radiusX: 20, radiusY: 4, rotation: 0 };
    const turned = { ...upright, rotation: Math.PI / 2 };
    // A point far along +x is inside the wide upright rectangle and outside the turned
    // one; the tall axis swaps with it.
    expect(pointInRing(15, 0, selectionShapeRing(upright))).toBe(true);
    expect(pointInRing(15, 0, selectionShapeRing(turned))).toBe(false);
    expect(pointInRing(0, 15, selectionShapeRing(upright))).toBe(false);
    expect(pointInRing(0, 15, selectionShapeRing(turned))).toBe(true);
    expect(selectionShapeRing(turned)).toHaveLength(4);
  });
});

describe('applySelectionHandleDrag', () => {
  it('resizes a rotated ellipse along its own axes', () => {
    const shape: SelectionShape = { kind: 'ellipse', center: [0, 0], radiusX: 10, radiusY: 4, rotation: Math.PI / 2 };
    // The rotated +x axis points along world +y, so a drag out to (0, 25) is a 25-unit
    // radiusX — and leaves radiusY alone.
    const resized = applySelectionHandleDrag(shape, 'radiusX', [0, 25]);
    expect(resized.radiusX).toBeCloseTo(25);
    expect(resized.radiusY).toBe(4);
    expect(resized.rotation).toBe(shape.rotation);
    // Dragging the same handle along the *world* x axis is entirely off-axis, so the
    // half-extent it drives collapses rather than following the cursor's distance.
    expect(applySelectionHandleDrag(shape, 'radiusX', [25, 0]).radiusX).toBeCloseTo(0);
  });

  it('keeps a locked shape locked through a resize', () => {
    for (const kind of ['circle', 'square'] as const) {
      const shape: SelectionShape = { kind, center: [5, 5], radiusX: 3, radiusY: 3, rotation: 0 };
      const resized = applySelectionHandleDrag(shape, RADIUS_HANDLE_ID, [17, 5]);
      expect(resized.radiusX).toBeCloseTo(12);
      expect(resized.radiusY).toBe(resized.radiusX);
      expect(resized.center).toEqual([5, 5]);
    }
  });

  it('turns a rotate-handle drag into the angle the handle was dragged to', () => {
    const shape: SelectionShape = { kind: 'square', center: [0, 0], radiusX: 10, radiusY: 10, rotation: 0 };
    const rotated = applySelectionHandleDrag(shape, ROTATE_HANDLE_ID, [40, 0]);
    // The handle started on the shape's +y axis; dragging it onto world +x is a quarter
    // turn, and the handle's new position confirms it (its distance is unchanged — a
    // rotate drag never resizes).
    expect(rotated.rotation).toBeCloseTo(-Math.PI / 2);
    expect(rotated.radiusX).toBe(10);
    const moved = handleAt(rotated, ROTATE_HANDLE_ID);
    expect(moved[0]).toBeCloseTo(Math.hypot(...handleAt(shape, ROTATE_HANDLE_ID)));
    expect(moved[1]).toBeCloseTo(0);
  });

  it('relocates by the centre handle and by a translation alike', () => {
    const shape: SelectionShape = { kind: 'rectangle', center: [0, 0], radiusX: 6, radiusY: 2, rotation: 0.4 };
    const byHandle = applySelectionHandleDrag(shape, 'center', [7, -3]);
    const byTranslate = translateSelectionShape(shape, 7, -3);
    expect(byHandle).toEqual(byTranslate);
    expect(byTranslate.radiusX).toBe(6);
    expect(byTranslate.rotation).toBe(0.4);
  });

  it('rejects a handle id no shape of that kind offers', () => {
    const circle: SelectionShape = { kind: 'circle', center: [0, 0], radiusX: 1, radiusY: 1, rotation: 0 };
    // A circle has one half-extent handle, not the free pair — a stale id here would
    // otherwise read as a dead handle on the canvas.
    expect(() => applySelectionHandleDrag(circle, 'radiusY', [2, 2])).toThrow(/circle/);
  });
});

describe('selectionShapeHandles', () => {
  it('offers the handles each kind can actually act on', () => {
    const ids = (shape: SelectionShape) => selectionShapeHandles(shape).map((h) => h.id);
    const base = { center: [0, 0] as Point, radiusX: 5, radiusY: 3, rotation: 0 };
    expect(ids({ ...base, kind: 'rectangle' })).toEqual(['center', 'radiusX', 'radiusY', ROTATE_HANDLE_ID]);
    expect(ids({ ...base, kind: 'ellipse' })).toEqual(['center', 'radiusX', 'radiusY', ROTATE_HANDLE_ID]);
    expect(ids({ ...base, kind: 'square' })).toEqual(['center', RADIUS_HANDLE_ID, ROTATE_HANDLE_ID]);
    // Rotating a circle changes nothing, so it is offered no rotate handle.
    expect(ids({ ...base, kind: 'circle' })).toEqual(['center', RADIUS_HANDLE_ID]);
  });

  it('places a rotated shape handle on its own axis', () => {
    const shape: SelectionShape = { kind: 'ellipse', center: [10, 10], radiusX: 8, radiusY: 8, rotation: Math.PI / 2 };
    const [hx, hy] = handleAt(shape, 'radiusX');
    expect(hx).toBeCloseTo(10);
    expect(hy).toBeCloseTo(18);
  });
});
