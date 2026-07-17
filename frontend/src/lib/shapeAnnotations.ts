// Geometry helpers for the shape-annotation editor: building a shape's initial
// geometry from a drag/click interaction, computing its edit-handle positions,
// applying a handle drag back into geometry, and turning any shape kind into a
// flat outline for rendering (mirrors the polygon-approximation approach the
// backend uses for its `sdata.shapes["annotations"]` geometry column).
import type { ShapeGeometry, ShapeKind } from '../schemas/annotations';

type Point = [number, number];

const ELLIPSE_SEGMENTS = 64;

// Id of the synthetic rotate handle (distinct from the numeric vertex-handle ids
// and the ellipse's center/radius handles).
export const ROTATE_HANDLE_ID = 'rotate';
// How far past the shape's edge the rotate handle floats, as a fraction of the
// shape's radius — proportional so it stays a consistent visual distance at any zoom.
const ROTATE_HANDLE_GAP = 0.3;
// A text label has no world-space size (its glyphs are pixel-sized), so its rotate
// handle floats this many font-heights above the anchor, converted to world units
// via unitsPerPixel so it tracks the glyph at any zoom.
const TEXT_ROTATE_HANDLE_GAP = 1.2;

// ---- creation --------------------------------------------------------------

/** Build a shape's geometry from a drag's down-point and current point. Not used
 * for 'trapezoid' (built one click at a time, see trapezoidFromClicks) or 'text'
 * (placed by a single click, see textGeometryAt). */
export function geometryFromDrag(tool: Exclude<ShapeKind, 'trapezoid' | 'text'>, p0: Point, p1: Point): ShapeGeometry {
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
  if (geometry.kind === 'text') {
    return [geometry.position]; // no outline — text renders via its own TextLayer
  }
  return geometry.vertices as Point[];
}

// ---- centroid / rotation -----------------------------------------------------

function centroidOf(points: Point[]): Point {
  let sx = 0, sy = 0;
  for (const [x, y] of points) { sx += x; sy += y; }
  return [sx / points.length, sy / points.length];
}

/** Rotation pivot: an ellipse's center, a text label's anchor, or a
 * polygon/line's vertex centroid. */
export function shapeCentroid(geometry: ShapeGeometry): Point {
  if (geometry.kind === 'ellipse') return geometry.center;
  if (geometry.kind === 'text') return geometry.position;
  return centroidOf(geometry.vertices as Point[]);
}

function rotatePoint(p: Point, pivot: Point, angle: number): Point {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = p[0] - pivot[0], dy = p[1] - pivot[1];
  return [pivot[0] + dx * cos - dy * sin, pivot[1] + dx * sin + dy * cos];
}

/** World position of the rotate handle. It floats off the shape along an axis
 * that co-rotates with the geometry (an ellipse's own +Y axis; a polygon's edge
 * normal; a text label's own +Y, offset by font-height * unitsPerPixel) so
 * dragging it maps cleanly to an angle about the centroid. `unitsPerPixel` is
 * only consulted for text (whose size is in screen pixels); for the angle math
 * in applyHandleDrag its magnitude is irrelevant — only the direction matters —
 * so the default of 1 is safe there. */
function rotateHandlePosition(geometry: ShapeGeometry, unitsPerPixel = 1): Point {
  if (geometry.kind === 'text') {
    const { position, fontSize, rotation } = geometry;
    const offset = fontSize * TEXT_ROTATE_HANDLE_GAP * unitsPerPixel;
    return rotatePoint([position[0], position[1] + offset], position, rotation);
  }
  if (geometry.kind === 'ellipse') {
    const { center, radiusX, radiusY, rotation } = geometry;
    const local: Point = [0, radiusY + ROTATE_HANDLE_GAP * Math.max(radiusX, radiusY)];
    return rotatePoint([center[0] + local[0], center[1] + local[1]], center, rotation);
  }
  const verts = geometry.vertices as Point[];
  const c = centroidOf(verts);
  const [x0, y0] = verts[0], [x1, y1] = verts[1];
  const elen = Math.hypot(x1 - x0, y1 - y0) || 1;
  const perp: Point = [-(y1 - y0) / elen, (x1 - x0) / elen]; // unit normal to the first edge
  const spans = verts.map((v) => (v[0] - c[0]) * perp[0] + (v[1] - c[1]) * perp[1]);
  const maxSpan = Math.max(...spans), minSpan = Math.min(...spans);
  // Extend past whichever side reaches farther so the handle always sits outside.
  const dir: Point = -minSpan > maxSpan ? [-perp[0], -perp[1]] : perp;
  const extent = Math.max(maxSpan, -minSpan);
  const halfSpan = Math.max(...verts.map((v) => Math.hypot(v[0] - c[0], v[1] - c[1])));
  const offset = extent + ROTATE_HANDLE_GAP * halfSpan;
  return [c[0] + dir[0] * offset, c[1] + dir[1] * offset];
}

// ---- edit handles ------------------------------------------------------------

export interface ShapeHandle {
  id: string;
  position: Point;
}

/** Handle positions for the selected shape's edit overlay. Vertex handles for
 * line/box/trapezoid (one per vertex, id = vertex index); center + two
 * axis-radius handles for an ellipse. Line/box/trapezoid/ellipse also get a
 * rotate handle (id = ROTATE_HANDLE_ID) floating off the edge — dragging it
 * spins the whole shape about its centroid (ellipse via its `rotation` field,
 * polygons/lines by rotating their vertices). A text label gets a move handle at
 * its anchor (id 'center') plus a rotate handle. `unitsPerPixel` places the text
 * rotate handle a consistent screen distance above the glyph at any zoom. */
export function shapeHandles(geometry: ShapeGeometry, unitsPerPixel = 1): ShapeHandle[] {
  if (geometry.kind === 'text') {
    return [
      { id: 'center', position: geometry.position },
      { id: ROTATE_HANDLE_ID, position: rotateHandlePosition(geometry, unitsPerPixel) },
    ];
  }
  const base: ShapeHandle[] = geometry.kind === 'ellipse'
    ? [
        { id: 'center', position: geometry.center },
        { id: 'radiusX', position: [geometry.center[0] + geometry.radiusX, geometry.center[1]] },
        { id: 'radiusY', position: [geometry.center[0], geometry.center[1] + geometry.radiusY] },
      ]
    : geometry.vertices.map((v, i) => ({ id: String(i), position: v as Point }));
  return [...base, { id: ROTATE_HANDLE_ID, position: rotateHandlePosition(geometry) }];
}

/** Apply a handle drag (identified by `shapeHandles`' handle id) to `newPos`,
 * returning updated geometry. */
export function applyHandleDrag(geometry: ShapeGeometry, handleId: string, newPos: Point): ShapeGeometry {
  if (geometry.kind === 'text') {
    if (handleId === ROTATE_HANDLE_ID) {
      const pivot = geometry.position;
      const handle = rotateHandlePosition(geometry); // magnitude irrelevant; direction encodes the current angle
      const delta = Math.atan2(newPos[1] - pivot[1], newPos[0] - pivot[0])
        - Math.atan2(handle[1] - pivot[1], handle[0] - pivot[0]);
      return { ...geometry, rotation: geometry.rotation + delta };
    }
    return { ...geometry, position: newPos }; // 'center' move handle
  }
  if (handleId === ROTATE_HANDLE_ID) {
    const pivot = shapeCentroid(geometry);
    const handle = rotateHandlePosition(geometry);
    const delta = Math.atan2(newPos[1] - pivot[1], newPos[0] - pivot[0])
      - Math.atan2(handle[1] - pivot[1], handle[0] - pivot[0]);
    if (geometry.kind === 'ellipse') {
      return { ...geometry, rotation: geometry.rotation + delta };
    }
    const rotated = (geometry.vertices as Point[]).map((v) => rotatePoint(v, pivot, delta));
    if (geometry.kind === 'line') return { ...geometry, vertices: rotated as [Point, Point] };
    return { ...geometry, vertices: rotated as [Point, Point, Point, Point] };
  }
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
