import { ScatterplotLayer, PointCloudLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { ScatterPositions } from './useArrowPositions';

interface SpotStyle {
  pointSize: number;
  opacity: number;
  is3d?: boolean;
}

// The points layer shared by the live spatial + embedding canvases and the
// read-only snapshot viewer. A ScatterplotLayer in 2D (radius scaled to the mean
// inter-point spacing so a given point_size looks the same across datasets) or a
// PointCloudLayer in 3D. Distinct ids per class: reusing one id across a
// Scatterplot/PointCloud swap makes deck.gl push the old layer's attributes onto
// the new class.
export function buildSpotLayer(
  positions: ScatterPositions,
  colors: Uint8Array,
  { pointSize, opacity, is3d }: SpotStyle,
): Layer {
  if (is3d) {
    return new PointCloudLayer({
      id: 'points-3d',
      data: {
        length: positions.numRows,
        attributes: {
          getPosition: { value: positions.positions, size: 3 },
          getColor: { value: colors, size: 4, normalized: true },
        },
      },
      pointSize: Math.max(1, pointSize),
      opacity,
      updateTriggers: { getColor: colors, getPosition: positions.positions },
    });
  }

  const b = positions.bounds;
  const area = Math.max(1, (b.d0max - b.d0min) * (b.d1max - b.d1min));
  const spacing = Math.sqrt(area / Math.max(1, positions.numRows));
  const worldRadius = (pointSize / 8) * spacing;
  return new ScatterplotLayer({
    id: 'points-2d',
    data: {
      length: positions.numRows,
      attributes: {
        getPosition: { value: positions.positions, size: 2 },
        getFillColor: { value: colors, size: 4, normalized: true },
      },
    },
    getRadius: worldRadius,
    radiusUnits: 'common',
    radiusMinPixels: 0.5,
    opacity,
    pickable: false,
    updateTriggers: { getFillColor: colors, getPosition: positions.positions, getRadius: worldRadius },
  });
}
