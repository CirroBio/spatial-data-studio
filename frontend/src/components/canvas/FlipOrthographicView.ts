// A drop-in OrthographicView that adds a horizontal (flipX) axis flip alongside
// deck's native flipY. deck.gl's OrthographicViewport bakes the view matrix inside
// its constructor's super() call, so flipX can't be injected by subclassing it —
// this mirrors that viewport's math on the base Viewport and adds the one extra
// scale term. Keeping the flip at the camera level means picking, `info.coordinate`,
// pan, and fit all stay consistent without touching any layer or coordinate code.
//
// This is a faithful copy of @deck.gl/core's orthographic-viewport (deck pinned
// ^9.0.0; this math has been stable across 8→9). Re-check it against the upstream
// file on a deck major bump.
import { Viewport, OrthographicView } from '@deck.gl/core';
import type { OrthographicViewProps } from '@deck.gl/core';
import { Matrix4, clamp, vec2 } from '@math.gl/core';
import { pixelsToWorld } from '@math.gl/web-mercator';

type Padding = { left?: number; right?: number; top?: number; bottom?: number };
type DistanceScales = { unitsPerMeter: number[]; metersPerUnit: number[] };

interface FlipViewportOptions {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  target?: [number, number, number] | [number, number];
  zoom?: number | [number, number];
  zoomX?: number;
  zoomY?: number;
  padding?: Padding | null;
  near?: number;
  far?: number;
  flipX?: boolean;
  flipY?: boolean;
}

const viewMatrix = new Matrix4().lookAt({ eye: [0, 0, 1] });

function getProjectionMatrix({
  width, height, near, far, padding,
}: { width: number; height: number; near: number; far: number; padding: Padding | null }): Matrix4 {
  let left = -width / 2;
  let right = width / 2;
  let bottom = -height / 2;
  let top = height / 2;
  if (padding) {
    const { left: l = 0, right: r = 0, top: t = 0, bottom: b = 0 } = padding;
    const offsetX = clamp((l + width - r) / 2, 0, width) - width / 2;
    const offsetY = clamp((t + height - b) / 2, 0, height) - height / 2;
    left -= offsetX;
    right -= offsetX;
    bottom += offsetY;
    top += offsetY;
  }
  return new Matrix4().ortho({ left, right, bottom, top, near, far });
}

class FlipOrthographicViewport extends Viewport {
  static displayName = 'FlipOrthographicViewport';
  declare target: [number, number, number] | [number, number];
  declare zoomX: number;
  declare zoomY: number;
  declare flipY: boolean;

  constructor(props: FlipViewportOptions) {
    const {
      width, height, near = 0.1, far = 1000, zoom = 0, target = [0, 0, 0],
      padding = null, flipX = false, flipY = false,
    } = props;
    const zoomX = props.zoomX ?? (Array.isArray(zoom) ? zoom[0] : zoom);
    const zoomY = props.zoomY ?? (Array.isArray(zoom) ? zoom[1] : zoom);
    const zoom_ = Math.min(zoomX, zoomY);
    const scale = Math.pow(2, zoom_);
    let distanceScales: DistanceScales | undefined;
    if (zoomX !== zoomY) {
      const scaleX = Math.pow(2, zoomX);
      const scaleY = Math.pow(2, zoomY);
      distanceScales = {
        unitsPerMeter: [scaleX / scale, scaleY / scale, 1],
        metersPerUnit: [scale / scaleX, scale / scaleY, 1],
      };
    }
    super({
      ...props,
      longitude: undefined,
      position: target,
      viewMatrix: viewMatrix.clone().scale([
        scale * (flipX ? -1 : 1),
        scale * (flipY ? -1 : 1),
        scale,
      ]),
      projectionMatrix: getProjectionMatrix({
        width: width || 1,
        height: height || 1,
        padding,
        near,
        far,
      }),
      zoom: zoom_,
      distanceScales,
    });
    this.target = target;
    this.zoomX = zoomX;
    this.zoomY = zoomY;
    this.flipY = flipY;
  }

  projectFlat([X, Y]: number[]): [number, number] {
    const { unitsPerMeter } = this.distanceScales;
    return [X * unitsPerMeter[0], Y * unitsPerMeter[1]];
  }

  unprojectFlat([x, y]: number[]): [number, number] {
    const { metersPerUnit } = this.distanceScales;
    return [x * metersPerUnit[0], y * metersPerUnit[1]];
  }

  // Needed by OrthographicController (pan and zoom-about-cursor).
  panByPosition(coords: number[], pixel: number[]): { target: [number, number] } {
    const fromLocation = pixelsToWorld(pixel, this.pixelUnprojectionMatrix);
    const toLocation = this.projectFlat(coords);
    const translate = vec2.add([], toLocation, vec2.negate([], fromLocation));
    const newCenter = vec2.add([], this.center, translate);
    return { target: this.unprojectFlat(newCenter) };
  }
}

export class FlipOrthographicView extends OrthographicView {
  static displayName = 'FlipOrthographicView';
  constructor(props: OrthographicViewProps & { flipX?: boolean } = {}) {
    super(props);
  }
  getViewportType() {
    return FlipOrthographicViewport;
  }
}
