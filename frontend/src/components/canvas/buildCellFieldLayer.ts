import { ScatterplotLayer } from '@deck.gl/layers';
import { LayerExtension } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import type { ScatterPositions } from './useArrowPositions';

// The zoomed-out cell representation: a distance-capped nearest-site fill. Each
// cell is a world-space disc of radius R (the median nearest-neighbor distance).
// A LayerExtension injects one fragment-shader line into ScatterplotLayer that
// writes gl_FragDepth from the fragment's distance to its disc center, so with the
// depth test on the nearest centroid wins each pixel in a single pass.
//
// unitPosition (from the base vertex shader) is the quad-local coordinate in
// [-1, 1], so length(unitPosition) is exactly distance / R already in [0, 1] —
// this sidesteps gl_FragDepth precision loss at large world extents (the depth we
// write never depends on absolute world coordinates). The base shader already
// discards fragments outside the disc (inCircle == 0).
//
// The depth is only used to resolve the nearest cell among overlapping discs
// (depthCompare 'less' → the fragment closest to its center wins each pixel). The
// image layers are drawn first with depth writes disabled, so they never occlude
// the field and this depth is purely intra-field. The [0, ~0.49] scale keeps every
// fragment strictly below the cleared depth-buffer value (1.0) so none is dropped
// by the depth test at a disc's outer edge.
const FIELD_DEPTH_SCALE = 0.49;

// The distance cap (disc radius) is the median nearest-neighbor distance times this
// factor. A factor of 1 (the bare nearest-neighbor distance) fills only toward each
// cell's single closest neighbor and leaves speckled gaps toward the 2nd/3rd-nearest;
// ~1.8 lets neighboring discs overlap enough to read as one continuous sheet while
// still leaving genuinely empty tissue (holes wider than a couple of cells) uncolored.
const FILL_RADIUS_FACTOR = 1.8;
// Floor the on-screen disc size so the field stays a smooth sheet even at the most
// zoomed-out view, where the world-space radius projects to barely a pixel.
const FIELD_MIN_PIXELS = 2;

class FieldDepthExtension extends LayerExtension {
  static extensionName = 'FieldDepthExtension';
  getShaders() {
    return {
      inject: {
        'fs:#main-end': `gl_FragDepth = clamp(length(unitPosition), 0.0, 1.0) * ${FIELD_DEPTH_SCALE.toFixed(2)};`,
      },
    };
  }
}

const fieldDepth = new FieldDepthExtension();

export function buildCellFieldLayer(
  positions: ScatterPositions,
  colors: Uint8Array,
  { radius, opacity }: { radius: number; opacity: number },
): Layer {
  return new ScatterplotLayer({
    id: 'cell-field',
    data: {
      length: positions.numRows,
      attributes: {
        getPosition: { value: positions.positions, size: 2 },
        getFillColor: { value: colors, size: 4, normalized: true },
      },
    },
    getRadius: radius * FILL_RADIUS_FACTOR,
    radiusUnits: 'common',
    radiusMinPixels: FIELD_MIN_PIXELS,
    stroked: false,
    filled: true,
    antialiasing: false,  // hard disc edge → clean nearest-site tessellation, no gaps
    opacity,
    pickable: false,
    parameters: { depthWriteEnabled: true, depthCompare: 'less' },
    extensions: [fieldDepth],
    updateTriggers: { getFillColor: colors, getPosition: positions.positions, getRadius: radius },
  });
}

// Cheap field-radius estimate for the backend-free snapshot viewer: the mean
// inter-point spacing sqrt(area / n), the same heuristic buildSpotLayer uses for
// point sizing. Approximates the median NN distance (identical up to a constant
// for a roughly uniform layout) without a spatial index.
export function estimateFieldRadius(positions: ScatterPositions): number {
  const b = positions.bounds;
  const area = Math.max(1, (b.d0max - b.d0min) * (b.d1max - b.d1min));
  return Math.sqrt(area / Math.max(1, positions.numRows));
}
