import { ScatterplotLayer } from '@deck.gl/layers';
import type { ScatterplotLayerProps } from '@deck.gl/layers';
import type { DefaultProps } from '@deck.gl/core';

export type PointMarker = 'circle' | 'square' | 'hexagon';

// The coverage test each glyph swaps in for the base layer's circle. `unitPosition`
// spans the [-1, 1] quad; the expression is the point's "radius" in that space
// (== 1 on the glyph boundary), so it slots straight into the scatterplot fragment
// shader's `distToCenter <= outerRadiusPixels` test.
const MASK: Record<PointMarker, string> = {
  circle: 'length(unitPosition)',
  square: 'max(abs(unitPosition.x), abs(unitPosition.y))',
  hexagon: 'markerHexGauge(unitPosition)',
};

// Gauge of a pointy-top regular hexagon inscribed in the unit quad (vertices at
// y = +/-1, flats at x = +/-0.866): 1 on the boundary, linear from the centre.
const HEX_GLSL = `
float markerHexGauge(vec2 p) {
  p = abs(p);
  return max(p.x, 0.5 * p.x + 0.866025404 * p.y) / 0.866025404;
}
`;

const ANCHOR = 'float distToCenter = length(unitPosition) * outerRadiusPixels;';

export type MarkerScatterplotLayerProps<DataT = unknown> = ScatterplotLayerProps<DataT> & {
  markerShape?: PointMarker;
};

/** A ScatterplotLayer whose glyph is a circle (default), square, or hexagon. Only
 * the fragment shader's coverage test changes — the instanced quads, sizing, and
 * per-point colour are the base layer's, so 1M-point performance is unaffected.
 * The shape is baked into the shader at build time; callers vary the layer `id` by
 * shape so a change remounts cleanly (see buildSpotLayer). */
export class MarkerScatterplotLayer<DataT = any> extends ScatterplotLayer<
  DataT,
  Required<{ markerShape: PointMarker }>
> {
  static layerName = 'MarkerScatterplotLayer';
  static defaultProps = {
    ...ScatterplotLayer.defaultProps,
    markerShape: 'circle',
  } as DefaultProps<MarkerScatterplotLayerProps>;

  getShaders() {
    const shaders = super.getShaders();
    const shape = this.props.markerShape;
    if (shape === 'circle') return shaders;
    const fs: string = shaders.fs;
    if (!fs.includes(ANCHOR)) {
      throw new Error('MarkerScatterplotLayer: scatterplot fragment anchor not found (deck.gl shader changed)');
    }
    let patched = fs.replace(ANCHOR, `float distToCenter = (${MASK[shape]}) * outerRadiusPixels;`);
    if (shape === 'hexagon') patched = patched.replace('void main(void) {', `${HEX_GLSL}\nvoid main(void) {`);
    return { ...shaders, fs: patched };
  }
}
