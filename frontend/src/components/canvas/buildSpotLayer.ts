import { PointCloudLayer } from '@deck.gl/layers';
import { LayerExtension } from '@deck.gl/core';
import type { Layer, BinaryAttribute } from '@deck.gl/core';
import type { ScatterPositions } from './useArrowPositions';
import { MarkerScatterplotLayer, type PointMarker } from './markerScatterplot';

interface SpotStyle {
  pointSize: number;
  opacity: number;
  is3d?: boolean;
  marker?: PointMarker;  // 2D glyph shape; defaults to circle (ignored in 3D)
}

// Mean inter-point spacing sqrt(area / n) — the characteristic cell diameter,
// used both to scale the point radius and (in useCanvasViewState) to decide when a
// cell is big enough on screen to fetch its polygon outline.
export function estimateMeanSpacing(positions: ScatterPositions): number {
  const b = positions.bounds;
  const area = Math.max(1, (b.d0max - b.d0min) * (b.d1max - b.d1min));
  return Math.sqrt(area / Math.max(1, positions.numRows));
}

// World-space radius for a given point_size, scaled to the mean inter-point
// spacing so a size looks the same across datasets.
export function pointWorldRadius(positions: ScatterPositions, pointSize: number): number {
  return (pointSize / 8) * estimateMeanSpacing(positions);
}

// Overlap-merge for the 2D scatter: one injected fragment line writes gl_FragDepth
// from the fragment's distance to its glyph center, so with the depth test on the
// nearest centroid wins each overlapping pixel. Drawn in two passes sharing the
// depth buffer so each pixel composites exactly once, independent of instance draw
// order — same-color overlaps keep a single point's color+alpha instead of stacking
// translucent layers (which darkens overlaps at opacity < 1), and touching cells of
// one color read as a gap-free region (the nearest centroid fills every covered pixel).
//   1. depth pre-pass — opacity 0 (fragments write depth but contribute no color,
//      since the glyph has no alpha discard), depthWrite on, compare 'less'.
//   2. color pass — depthWrite off, compare 'less-equal', so only the nearest
//      glyph's fragment survives.
// unitPosition is the quad-local coordinate in [-1, 1]; length(...) is the radial
// distance from center (clamped for square/hexagon corners past 1), a monotonic
// depth proxy independent of absolute world coordinates. The [0, ~0.49] scale keeps
// every fragment below the cleared depth value (1.0) and below the image layers
// (drawn first with depth writes off), so the depth is purely intra-scatter.
const MERGE_DEPTH_SCALE = 0.49;

class OverlapDepthExtension extends LayerExtension {
  static extensionName = 'OverlapDepthExtension';
  getShaders() {
    return {
      inject: {
        'fs:#main-end': `gl_FragDepth = clamp(length(unitPosition), 0.0, 1.0) * ${MERGE_DEPTH_SCALE.toFixed(2)};`,
      },
    };
  }
}

const overlapDepth = new OverlapDepthExtension();

// The points layer shared by the live spatial + embedding canvases and the
// read-only snapshot viewer. A two-pass MarkerScatterplotLayer in 2D (radius scaled
// to the mean inter-point spacing so a given point_size looks the same across
// datasets; overlaps merged rather than blended, see above) or a single
// PointCloudLayer in 3D (real depth already resolves overlaps). Distinct ids per
// class: reusing one id across a Scatterplot/PointCloud swap makes deck.gl push the
// old layer's attributes onto the new class.
export function buildSpotLayer(
  positions: ScatterPositions,
  colors: Uint8Array,
  { pointSize, opacity, is3d, marker = 'circle' }: SpotStyle,
): Layer[] {
  if (is3d) {
    return [new PointCloudLayer({
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
    })];
  }

  const worldRadius = pointWorldRadius(positions, pointSize);
  // getFillColor is a Uint8 buffer; ScatterplotLayer's instanceFillColors is a
  // 'unorm8' attribute, so it is normalized to 0..1 automatically.
  const attributes: Record<string, BinaryAttribute> = {
    getPosition: { value: positions.positions, size: 2 },
    getFillColor: { value: colors, size: 4 },
  };
  // Id carries the marker so a glyph change remounts with the reshaped shader
  // (the shape is baked in at build time; see MarkerScatterplotLayer).
  const shared = {
    markerShape: marker,
    data: { length: positions.numRows, attributes },
    getRadius: worldRadius,
    radiusUnits: 'common' as const,
    radiusMinPixels: 0.5,
    pickable: false,
    extensions: [overlapDepth],
    updateTriggers: { getFillColor: colors, getPosition: positions.positions, getRadius: worldRadius },
  };
  return [
    new MarkerScatterplotLayer({
      ...shared,
      id: `points-2d-${marker}-depth`,
      opacity: 0,  // depth pre-pass: writes the nearest-glyph depth, no color
      parameters: { depthWriteEnabled: true, depthCompare: 'less' },
    }),
    new MarkerScatterplotLayer({
      ...shared,
      id: `points-2d-${marker}`,
      opacity,  // color pass: only the fragment matching the pre-pass depth survives
      parameters: { depthWriteEnabled: false, depthCompare: 'less-equal' },
    }),
  ];
}
