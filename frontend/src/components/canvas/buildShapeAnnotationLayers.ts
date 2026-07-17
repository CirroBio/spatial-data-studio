import { PolygonLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import type { PathStyleExtensionProps } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import type { ShapeAnnotation, ShapeGeometry } from '../../schemas/annotations';
import { shapeOutline, shapeHandles, arrowheadTriangle } from '../../lib/shapeAnnotations';

type Point = [number, number];

// UI overlays must render on top regardless of the cell-field layer's depth trick
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
 * debounced API round trip. Rendered whenever shapes exist, independent of
 * whether the Annotations tab (and its edit interactions) is active. */
export function buildShapeAnnotationLayers(
  shapes: ShapeAnnotation[],
  overrides: Record<string, ShapeGeometry> = {},
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

  layers.push(new PathLayer<typeof resolved[number], PathStyleExtensionProps<typeof resolved[number]>>({
    id: 'shape-stroke',
    data: resolved,
    getPath: (d) => (d.geometry.kind === 'line' ? shapeOutline(d.geometry) : [...shapeOutline(d.geometry), shapeOutline(d.geometry)[0]]),
    getColor: (d) => [...hexToRgb(d.stroke.color), 255],
    getWidth: (d) => d.stroke.width,
    getDashArray: (d) => dashArray(d.stroke.dash),
    widthUnits: 'pixels',
    pickable: true,
    parameters: OVERLAY_PARAMS,
    extensions: [new PathStyleExtension({ dash: true })],
  }));

  const arrowheads: { id: string; points: Point[] }[] = [];
  const arrowSize = 10;
  for (const s of resolved) {
    if (s.geometry.kind !== 'line') continue;
    const [v0, v1] = s.geometry.vertices;
    if (s.stroke.arrowEnd) arrowheads.push({ id: `${s.id}-end`, points: arrowheadTriangle(v0, v1, arrowSize) });
    if (s.stroke.arrowStart) arrowheads.push({ id: `${s.id}-start`, points: arrowheadTriangle(v1, v0, arrowSize) });
  }
  if (arrowheads.length) {
    layers.push(new PolygonLayer<typeof arrowheads[number]>({
      id: 'shape-arrowheads',
      data: arrowheads,
      getPolygon: (d) => d.points,
      getFillColor: [80, 80, 80, 255],
      filled: true,
      stroked: false,
      pickable: false,
      parameters: OVERLAY_PARAMS,
    }));
  }

  return layers;
}

/** Edit-handle overlay for the selected shape, shown only while the shape
 * annotation editor is active. */
export function buildShapeHandleLayer(geometry: ShapeGeometry): Layer {
  const handles = shapeHandles(geometry);
  return new ScatterplotLayer<typeof handles[number]>({
    id: 'shape-handles',
    data: handles,
    getPosition: (d) => d.position,
    getFillColor: [255, 255, 255, 255],
    getLineColor: [51, 136, 255, 255],
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 2,
    getRadius: 5,
    radiusUnits: 'pixels',
    pickable: true,
    parameters: OVERLAY_PARAMS,
  });
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
