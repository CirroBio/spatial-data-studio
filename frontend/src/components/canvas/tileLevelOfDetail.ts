import type { ImageInfo } from '../../types';
import { worldToPixel } from './imageAffine';

export interface TileRange {
  level: number;
  // Level-L pixel-per-level-0-pixel scale factors (W0/WL, H0/HL), which callers
  // need alongside the range to convert tile indices back to level-0 pixel rects.
  sx: number;
  sy: number;
  col0: number;
  col1: number;
  row0: number;
  row1: number;
}

// Shared by the PNG tile path (useImageTiles) and the Viv GPU-compositing path
// (useVivImageLayer): picks the coarsest pyramid level whose native resolution
// still matches the screen, then the range of that level's tiles covering the
// viewport (with a one-tile margin). `maxLevel` is a caller-supplied clamp since
// the two callers cap it differently (PNG: levels.length-1; Viv: also bounded by
// how many pyramid levels the Viv loader itself resolved).
export function selectTileRange(
  imageInfo: ImageInfo,
  size: { width: number; height: number },
  zoom: number,
  tx: number,
  ty: number,
  maxLevel: number,
): TileRange {
  const m = imageInfo.pixel_to_world;
  const levels = imageInfo.levels;
  const T = imageInfo.tile_size;
  const [W0, H0] = [levels[0].width, levels[0].height];

  // world units per screen pixel = 2^-zoom; per level-0 pixel = worldW / W0.
  const worldPerScreenPx = Math.pow(2, -zoom);
  const worldPerPx0 = Math.abs(imageInfo.bounds[2] - imageInfo.bounds[0]) / W0;
  let level = Math.floor(Math.log2(Math.max(worldPerScreenPx / worldPerPx0, 1e-9)));
  level = Math.max(0, Math.min(maxLevel, level));

  const { width: WL, height: HL } = levels[level];
  const sx = W0 / WL;
  const sy = H0 / HL;

  // Viewport world rect -> level-0 pixel bbox (inverse affine on 4 corners, so
  // rotated images still map correctly).
  const hw = (size.width / 2) * worldPerScreenPx;
  const hh = (size.height / 2) * worldPerScreenPx;
  const corners: [number, number][] = [
    [tx - hw, ty - hh], [tx + hw, ty - hh], [tx + hw, ty + hh], [tx - hw, ty + hh],
  ];
  let pxMin = Infinity, pyMin = Infinity, pxMax = -Infinity, pyMax = -Infinity;
  for (const [cx, cy] of corners) {
    const [px, py] = worldToPixel(m, cx, cy);
    pxMin = Math.min(pxMin, px); pxMax = Math.max(pxMax, px);
    pyMin = Math.min(pyMin, py); pyMax = Math.max(pyMax, py);
  }
  // level-0 pixels -> level-L tile indices, with a one-tile margin.
  const col0 = Math.max(0, Math.floor(pxMin / sx / T) - 1);
  const col1 = Math.min(Math.ceil(WL / T) - 1, Math.floor(pxMax / sx / T) + 1);
  const row0 = Math.max(0, Math.floor(pyMin / sy / T) - 1);
  const row1 = Math.min(Math.ceil(HL / T) - 1, Math.floor(pyMax / sy / T) + 1);

  return { level, sx, sy, col0, col1, row0, row1 };
}
