// Shape-annotation editor schema (arrows, lines, boxes, trapezoids, ellipses drawn
// directly on the canvas). Vertices/centers are in the same data/world coordinate
// space SpatialCanvas already hands to draw interactions (PickingInfo.coordinate).
// backend/app/schemas/annotations.py is the hand-kept pydantic counterpart —
// field names and enums must match exactly.
import { z } from 'zod';

const Point = z.tuple([z.number(), z.number()]);

export const StrokeStyle = z.object({
  color: z.string(),
  width: z.number().min(0),
  dash: z.enum(['solid', 'dashed', 'dotted']),
  // "arrow" is a line whose stroke has an arrowhead at one or both ends — there is
  // no separate 'arrow' shape kind, since its geometry is identical to 'line'.
  arrowStart: z.boolean(),
  arrowEnd: z.boolean(),
  // Arrowhead length/width in screen pixels (ignored unless arrowStart/arrowEnd).
  arrowSize: z.number().min(0),
  z: z.number().int(),
});
export type StrokeStyle = z.infer<typeof StrokeStyle>;

export const FillStyle = z.object({
  enabled: z.boolean(),
  color: z.string(),
  alpha: z.number().min(0).max(1),
  z: z.number().int(),
});
export type FillStyle = z.infer<typeof FillStyle>;

const LineGeometry = z.object({ kind: z.literal('line'), vertices: z.tuple([Point, Point]) });
const BoxGeometry = z.object({ kind: z.literal('box'), vertices: z.tuple([Point, Point, Point, Point]) });
const TrapezoidGeometry = z.object({ kind: z.literal('trapezoid'), vertices: z.tuple([Point, Point, Point, Point]) });
const EllipseGeometry = z.object({
  kind: z.literal('ellipse'),
  center: Point,
  radiusX: z.number().min(0),
  radiusY: z.number().min(0),
  rotation: z.number(),
});
// A text label anchored at a point, optionally rotated (radians, about the
// anchor). `stroke.color` is the text color and `stroke.z` its z-order; a text
// label has no interior to fill, no arrowheads, and no width/dash (those stroke
// fields still round-trip, they just don't render). `rotation` defaults to 0 so
// labels authored before rotation existed still parse.
const TextGeometry = z.object({
  kind: z.literal('text'),
  position: Point,
  text: z.string(),
  fontSize: z.number().min(1),
  rotation: z.number().default(0),
});

export const ShapeGeometry = z.discriminatedUnion('kind', [
  LineGeometry,
  BoxGeometry,
  TrapezoidGeometry,
  EllipseGeometry,
  TextGeometry,
]);
export type ShapeGeometry = z.infer<typeof ShapeGeometry>;
export type ShapeKind = ShapeGeometry['kind'];

export const ShapeAnnotation = z.object({
  id: z.string(),
  label: z.string().optional(),
  geometry: ShapeGeometry,
  stroke: StrokeStyle,
  // Omitted (ignored) for 'line' — a line has no interior to fill.
  fill: FillStyle.optional(),
});
export type ShapeAnnotation = z.infer<typeof ShapeAnnotation>;

export const SHAPE_KINDS: ShapeKind[] = ['line', 'box', 'trapezoid', 'ellipse', 'text'];

export const DEFAULT_TEXT_FONT_SIZE = 16;

/** Geometry for a new text label placed by a single click at `position`. */
export function textGeometryAt(position: [number, number]): ShapeGeometry {
  return { kind: 'text', position, text: 'Text', fontSize: DEFAULT_TEXT_FONT_SIZE, rotation: 0 };
}

export function defaultStroke(): StrokeStyle {
  return { color: '#3388ff', width: 2, dash: 'solid', arrowStart: false, arrowEnd: false, arrowSize: 10, z: 0 };
}

export function defaultFill(): FillStyle {
  return { enabled: true, color: '#3388ff', alpha: 0.25, z: 0 };
}
