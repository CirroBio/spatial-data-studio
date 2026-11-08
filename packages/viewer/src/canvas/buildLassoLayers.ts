import { PolygonLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer, LayerProps } from '@deck.gl/core';
import type { Matrix4 } from '@math.gl/core';

type Point = [number, number];

// The lasso selection overlay shared by the spatial and embedding canvases:
// committed rings as translucent filled polygons, the closeable in-progress ring
// as a 3px path, and its vertices as 4px dots, every outline over a dark halo. `color` is the themed selection RGB
// (see SELECTION_COLORS). The spatial canvas additionally passes its world->pixel
// modelMatrix and always-on-top depth parameters; the embedding canvas needs neither.
export function buildLassoLayers(
  polygons: Point[][],
  ring: Point[],
  color: [number, number, number],
  { idPrefix, modelMatrix, parameters }: {
    idPrefix: string;
    modelMatrix?: Matrix4;
    parameters?: LayerProps['parameters'];
  },
): Layer[] {
  const layers: Layer[] = [];
  // A dark halo under each outline, so it stays visible over points of any color.
  const outlines = [...polygons.map((p) => [...p, p[0]]), ...(ring.length >= 2 ? [ring] : [])];
  if (outlines.length) {
    layers.push(new PathLayer<Point[]>({
      id: `${idPrefix}-halo`, data: outlines, getPath: (d) => d,
      getColor: [0, 0, 0, 150], getWidth: 6, widthUnits: 'pixels', pickable: false,
      parameters, modelMatrix,
    }));
  }
  if (polygons.length) {
    layers.push(new PolygonLayer<Point[]>({
      id: `${idPrefix}-polygons`, data: polygons, getPolygon: (d) => d,
      filled: true, getFillColor: [...color, 50], stroked: true,
      getLineColor: [...color, 255], getLineWidth: 3, lineWidthUnits: 'pixels', pickable: false,
      parameters, modelMatrix,
    }));
  }
  if (ring.length >= 2) {
    layers.push(new PathLayer<Point[]>({
      id: `${idPrefix}-path`, data: [ring], getPath: (d) => d,
      getColor: [...color, 255], getWidth: 3, widthUnits: 'pixels', pickable: false,
      parameters, modelMatrix,
    }));
  }
  if (ring.length >= 1) {
    layers.push(new ScatterplotLayer<Point>({
      id: `${idPrefix}-verts`, data: ring, getPosition: (d) => d,
      getFillColor: [...color, 255], getRadius: 4, radiusUnits: 'pixels', pickable: false,
      parameters, modelMatrix,
    }));
  }
  return layers;
}
