// Geometry helpers for the shape-annotation editor: building a shape's initial
// geometry from a drag/click interaction, computing its edit-handle positions,
// applying a handle drag back into geometry, and turning any shape kind into a
// flat outline for rendering (mirrors the polygon-approximation approach the
// backend uses for its `sdata.shapes["annotations"]` geometry column).
import type { ShapeGeometry, ShapeKind } from '../schemas/annotations';

type Point = [number, number];

const ELLIPSE_SEGMENTS = 64;

// ---- creation --------------------------------------------------------------

/** Build a shape's geometry from a drag's down-point and current point. Not used
 * for 'trapezoid', which is built one click at a time (see trapezoidFromClicks). */
export function geometryFromDrag(tool: Exclude<ShapeKind, 'trapezoid'>, p0: Point, p1: Point): ShapeGeometry {
  if (tool === 'line') {
    return { kind: 'line', vertices: [p0, p1] };
  }
  if (tool === 'ellipse') {
    return {
      kind: 'ellipse',
      center: p0,
      radiusX: Math.abs(p1[0] - p0[0]),
      radiusY: Math.abs(p1[1] - p0[1]),
      rotation: 0,
    };
  }
  // box: p0/p1 are opposite corners of an axis-aligned rectangle
  const [x0, y0] = p0;
  const [x1, y1] = p1;
  return { kind: 'box', vertices: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
}

export function trapezoidFromClicks(vertices: Point[]): ShapeGeometry | null {
  return vertices.length === 4 ? { kind: 'trapezoid', vertices: vertices as [Point, Point, Point, Point] } : null;
}

// ---- rendering outline ------------------------------------------------------

export function ellipseToPolygon(
  center: Point, radiusX: number, radiusY: number, rotation: number, segments = ELLIPSE_SEGMENTS
): Point[] {
  const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
  const pts: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (2 * Math.PI * i) / segments;
    const x = radiusX * Math.cos(t), y = radiusY * Math.sin(t);
    pts.push([x * cosR - y * sinR + center[0], x * sinR + y * cosR + center[1]]);
  }
  return pts;
}

/** Flat point list for rendering: 2 points (open path) for a line, a closed ring
 * for box/trapezoid, or a polygon approximation for an ellipse. */
export function shapeOutline(geometry: ShapeGeometry): Point[] {
  if (geometry.kind === 'ellipse') {
    return ellipseToPolygon(geometry.center, geometry.radiusX, geometry.radiusY, geometry.rotation);
  }
  return geometry.vertices as Point[];
}

// ---- edit handles ------------------------------------------------------------

export interface ShapeHandle {
  id: string;
  position: Point;
}

/** Handle positions for the selected shape's edit overlay. Vertex handles for
 * line/box/trapezoid (one per vertex, id = vertex index); center + two
 * axis-radius handles for an ellipse. Ellipse rotation isn't exposed as a drag
 * handle in v1 — the `rotation` field still round-trips through the schema for
 * shapes authored with one, it just defaults to 0 from this editor. */
export function shapeHandles(geometry: ShapeGeometry): ShapeHandle[] {
  if (geometry.kind === 'ellipse') {
    const { center, radiusX, radiusY } = geometry;
    return [
      { id: 'center', position: center },
      { id: 'radiusX', position: [center[0] + radiusX, center[1]] },
      { id: 'radiusY', position: [center[0], center[1] + radiusY] },
    ];
  }
  return geometry.vertices.map((v, i) => ({ id: String(i), position: v as Point }));
}

/** Apply a handle drag (identified by `shapeHandles`' handle id) to `newPos`,
 * returning updated geometry. */
export function applyHandleDrag(geometry: ShapeGeometry, handleId: string, newPos: Point): ShapeGeometry {
  if (geometry.kind === 'ellipse') {
    if (handleId === 'center') {
      const [dx, dy] = [newPos[0] - geometry.center[0], newPos[1] - geometry.center[1]];
      return { ...geometry, center: [geometry.center[0] + dx, geometry.center[1] + dy] };
    }
    if (handleId === 'radiusX') {
      return { ...geometry, radiusX: Math.abs(newPos[0] - geometry.center[0]) };
    }
    return { ...geometry, radiusY: Math.abs(newPos[1] - geometry.center[1]) };
  }
  const i = Number(handleId);
  if (geometry.kind === 'line') {
    const vertices = geometry.vertices.map((v, idx) => (idx === i ? newPos : v)) as [Point, Point];
    return { ...geometry, vertices };
  }
  const vertices = geometry.vertices.map((v, idx) => (idx === i ? newPos : v)) as [Point, Point, Point, Point];
  return { ...geometry, vertices };
}

// ---- arrowheads --------------------------------------------------------------

/** Triangle polygon for an arrowhead at `tip`, pointing away from `from`. */
export function arrowheadTriangle(from: Point, tip: Point, size: number): Point[] {
  const dx = tip[0] - from[0], dy = tip[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;   // unit vector along the line, toward tip
  const px = -uy, py = ux;               // perpendicular unit vector
  const backX = tip[0] - ux * size, backY = tip[1] - uy * size;
  return [
    tip,
    [backX + px * size * 0.5, backY + py * size * 0.5],
    [backX - px * size * 0.5, backY - py * size * 0.5],
  ];
}
