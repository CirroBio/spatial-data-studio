import { PolygonLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import type { PathStyleExtensionProps } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import type { ShapeAnnotation, ShapeGeometry } from '../../schemas/annotations';
import { shapeOutline, shapeHandles, shapeCentroid, arrowheadTriangle, ROTATE_HANDLE_ID } from '../../lib/shapeAnnotations';

type Point = [number, number];

// UI overlays must render on top regardless of the cell scatter's depth trick
// (same OVERLAY_PARAMS used by the lasso selection layers in SpatialCanvas).
const OVERLAY_PARAMS = { depthCompare: 'always' as const, depthWriteEnabled: false };

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function dashArray(dash: ShapeAnnotation['stroke']['dash']): [number, number] {
  if (dash === 'dashed') return [4, 3];
  if (dash === 'dotted') return [1, 2];
  return [0, 0];
}

/** Persisted shape-annotation render layers: fill polygons, stroke paths, and
 * arrowhead markers. `overrides` swaps in a live-drag geometry for the shape
 * currently being edited so dragging a handle previews without waiting on the
 * debounced API round trip. `unitsPerPixel` (world units per screen pixel at the
 * current zoom) converts each arrow's pixel size into the world-space triangle
 * geometry, so the arrowhead stays a constant on-screen size like the stroke
 * width. Rendered whenever shapes exist, independent of whether the Annotations
 * tab (and its edit interactions) is active. */
export function buildShapeAnnotationLayers(
  shapes: ShapeAnnotation[],
  overrides: Record<string, ShapeGeometry> = {},
  unitsPerPixel = 1,
): Layer[] {
  if (!shapes.length) return [];

  const resolved = shapes.map((s) => ({ ...s, geometry: overrides[s.id] ?? s.geometry }));
  const filled = resolved.filter((s) => s.fill?.enabled);
  const layers: Layer[] = [];

  if (filled.length) {
    layers.push(new PolygonLayer<typeof filled[number]>({
      id: 'shape-fill',
      data: filled,
      getPolygon: (d) => shapeOutline(d.geometry),
      getFillColor: (d) => [...hexToRgb(d.fill!.color), Math.round(d.fill!.alpha * 255)],
      filled: true,
      stroked: false,
      pickable: true,
      parameters: OVERLAY_PARAMS,
    }));
  }

  // A text label has no stroked outline (it renders via its own TextLayer below).
  const stroked = resolved.filter((s) => s.geometry.kind !== 'text');
  layers.push(new PathLayer<typeof stroked[number], PathStyleExtensionProps<typeof stroked[number]>>({
    id: 'shape-stroke',
    data: stroked,
    getPath: (d) => (d.geometry.kind === 'line' ? shapeOutline(d.geometry) : [...shapeOutline(d.geometry), shapeOutline(d.geometry)[0]]),
    getColor: (d) => [...hexToRgb(d.stroke.color), 255],
    getWidth: (d) => d.stroke.width,
    getDashArray: (d) => dashArray(d.stroke.dash),
    widthUnits: 'pixels',
    pickable: true,
    parameters: OVERLAY_PARAMS,
    extensions: [new PathStyleExtension({ dash: true })],
  }));

  const arrowheads: { id: string; points: Point[]; color: [number, number, number] }[] = [];
  for (const s of resolved) {
    if (s.geometry.kind !== 'line') continue;
    const [v0, v1] = s.geometry.vertices;
    const size = s.stroke.arrowSize * unitsPerPixel;
    const color = hexToRgb(s.stroke.color);
    if (s.stroke.arrowEnd) arrowheads.push({ id: `${s.id}-end`, points: arrowheadTriangle(v0, v1, size), color });
    if (s.stroke.arrowStart) arrowheads.push({ id: `${s.id}-start`, points: arrowheadTriangle(v1, v0, size), color });
  }
  if (arrowheads.length) {
    layers.push(new PolygonLayer<typeof arrowheads[number]>({
      id: 'shape-arrowheads',
      data: arrowheads,
      getPolygon: (d) => d.points,
      getFillColor: (d) => [...d.color, 255],
      filled: true,
      stroked: false,
      pickable: false,
      parameters: OVERLAY_PARAMS,
    }));
  }

  const texts = resolved.filter((s) => s.geometry.kind === 'text');
  if (texts.length) {
    layers.push(new TextLayer<typeof texts[number]>({
      id: 'shape-text',
      data: texts,
      getPosition: (d) => (d.geometry.kind === 'text' ? d.geometry.position : [0, 0]),
      getText: (d) => (d.geometry.kind === 'text' ? d.geometry.text : ''),
      getSize: (d) => (d.geometry.kind === 'text' ? d.geometry.fontSize : 16),
      // Stored rotation is radians CW about the anchor (world/screen y is down here);
      // TextLayer getAngle is degrees CCW, hence the negation.
      getAngle: (d) => (d.geometry.kind === 'text' ? -(d.geometry.rotation * 180) / Math.PI : 0),
      getColor: (d) => [...hexToRgb(d.stroke.color), 255],
      // World-space size (fontSize is stored in world units): the label keeps a
      // constant span relative to the image and scales with zoom, unlike the
      // pixel-constant stroke/arrowheads above.
      sizeUnits: 'common',
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
      characterSet: 'auto', // render whatever characters the user typed
      pickable: true,
      parameters: OVERLAY_PARAMS,
    }));
  }

  return layers;
}

/** Edit-handle overlay for the selected shape, shown only while the shape
 * annotation editor is active: a connector arm from the centroid out to the
 * green rotate handle, then the round vertex/radius/rotate handles on top. */
export function buildShapeHandleLayer(geometry: ShapeGeometry): Layer[] {
  const handles = shapeHandles(geometry);
  if (!handles.length) return [];
  const layers: Layer[] = [];

  const rotateHandle = handles.find((h) => h.id === ROTATE_HANDLE_ID);
  if (rotateHandle) {
    layers.push(new PathLayer<Point[]>({
      id: 'shape-handle-rotate-arm',
      data: [[shapeCentroid(geometry), rotateHandle.position]],
      getPath: (d) => d,
      getColor: [56, 178, 88, 200],
      getWidth: 1.5,
      widthUnits: 'pixels',
      pickable: false,
      parameters: OVERLAY_PARAMS,
    }));
  }

  layers.push(new ScatterplotLayer<typeof handles[number]>({
    id: 'shape-handles',
    data: handles,
    getPosition: (d) => d.position,
    getFillColor: (d) => (d.id === ROTATE_HANDLE_ID ? [56, 178, 88, 255] : [255, 255, 255, 255]),
    getLineColor: [51, 136, 255, 255],
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 2,
    getRadius: 5,
    radiusUnits: 'pixels',
    pickable: true,
    parameters: OVERLAY_PARAMS,
  }));

  return layers;
}

/** Live preview layers for an in-progress drag (creating a shape, or dragging an
 * existing shape's handle) — rendered from local component state, never
 * persisted directly. */
export function buildDragPreviewLayers(geometry: ShapeGeometry): Layer[] {
  const outline = shapeOutline(geometry);
  const closed = geometry.kind === 'line' ? outline : [...outline, outline[0]];
  return [
    new PathLayer<Point[]>({
      id: 'shape-drag-preview',
      data: [closed],
      getPath: (d) => d,
      getColor: [51, 136, 255, 220],
      getWidth: 2,
      widthUnits: 'pixels',
      parameters: OVERLAY_PARAMS,
    }),
  ];
}
