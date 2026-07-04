import { useMemo, useReducer } from 'react';
import { BitmapLayer } from '@deck.gl/layers';
import type { Layer, OrthographicViewState } from '@deck.gl/core';
import type { ImageInfo } from '../../types';
import { getImageTileUrl, getImageThumbnailUrl } from '../../api';

// Level-0 pixel (px, py) -> world, using the 6-float affine from image_info.
type Affine = ImageInfo['pixel_to_world'];
const wx = (m: Affine, px: number, py: number) => m[0] * px + m[1] * py + m[2];
const wy = (m: Affine, px: number, py: number) => m[3] * px + m[4] * py + m[5];

// Inverse affine: world (x, y) -> level-0 pixel (px, py).
function worldToPixel(m: Affine, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d || 1e-9;
  const dx = x - c;
  const dy = y - f;
  return [(e * dx - b * dy) / det, (-d * dx + a * dy) / det];
}

// BitmapLayer quad bounds map to the image's texture corners in the order
// [bottom-left, top-left, top-right, bottom-right]; "top" is image row 0.
type Corner = [number, number];
function quad(m: Affine, px0: number, py0: number, px1: number, py1: number):
  [Corner, Corner, Corner, Corner] {
  return [
    [wx(m, px0, py1), wy(m, px0, py1)], // bottom-left  (col0, rowN)
    [wx(m, px0, py0), wy(m, px0, py0)], // top-left     (col0, row0)
    [wx(m, px1, py0), wy(m, px1, py0)], // top-right    (colN, row0)
    [wx(m, px1, py1), wy(m, px1, py1)], // bottom-right (colN, rowN)
  ];
}

// Module-level decoded-image cache so pan/zoom reuses tiles and we can track
// exactly when each tile is ready (deck.gl accepts a decoded Image directly).
const CACHE_MAX = 240;
const imgCache = new Map<string, HTMLImageElement>();
const imgPending = new Set<string>();

function getImage(url: string, onLoad: () => void): HTMLImageElement | null {
  const hit = imgCache.get(url);
  if (hit) {
    imgCache.delete(url);
    imgCache.set(url, hit); // LRU bump
    return hit;
  }
  if (!imgPending.has(url)) {
    imgPending.add(url);
    const img = new Image();
    img.onload = () => {
      imgPending.delete(url);
      imgCache.set(url, img);
      if (imgCache.size > CACHE_MAX) imgCache.delete(imgCache.keys().next().value as string);
      onLoad();
    };
    img.onerror = () => { imgPending.delete(url); };
    img.src = url;
  }
  return null;
}

interface Params {
  imageInfo: ImageInfo | null;
  sessionId: string;
  element: string | null;
  viewState: OrthographicViewState | null;
  size: { width: number; height: number } | null;
  visibleChannels: string;
  show: boolean;
}

/** Coarse whole-image base layer plus level-of-detail tiles for the current
 * viewport, drawn from the SpatialData multiscale pyramid. Returns deck.gl
 * layers and a `loading` flag that's true while any visible tile is still
 * fetching. */
export function useImageTiles(
  { imageInfo, sessionId, element, viewState, size, visibleChannels, show }: Params,
): { layers: Layer[]; loading: boolean } {
  const [tick, bump] = useReducer((x: number) => x + 1, 0);
  const zoom = viewState ? (Array.isArray(viewState.zoom) ? viewState.zoom[0] : viewState.zoom) ?? 0 : 0;
  const target = viewState?.target;
  const tx = target ? target[0] : 0;
  const ty = target ? target[1] : 0;

  return useMemo(() => {
    if (!show || !imageInfo || !element || !viewState || !size || !imageInfo.levels.length) {
      return { layers: [], loading: false };
    }
    const m = imageInfo.pixel_to_world;
    const levels = imageInfo.levels;
    const maxLevel = levels.length - 1;
    const T = imageInfo.tile_size;
    const [W0, H0] = [levels[0].width, levels[0].height];

    const layers: Layer[] = [];
    let loading = false;

    // Always-present coarse base so the canvas is never blank while tiles load.
    const baseUrl = getImageThumbnailUrl(sessionId, element, visibleChannels);
    const baseImg = getImage(baseUrl, bump);
    if (baseImg) {
      layers.push(new BitmapLayer({
        id: `img-base-${element}-${visibleChannels}`,
        image: baseImg,
        bounds: quad(m, 0, 0, W0, H0),
      }));
    } else {
      loading = true;
    }

    // Pick the coarsest level whose native resolution still matches the screen:
    // world units per screen pixel = 2^-zoom; per level-0 pixel = worldW / W0.
    const worldPerScreenPx = Math.pow(2, -zoom);
    const worldPerPx0 = Math.abs(imageInfo.bounds[2] - imageInfo.bounds[0]) / W0;
    let level = Math.floor(Math.log2(Math.max(worldPerScreenPx / worldPerPx0, 1e-9)));
    level = Math.max(0, Math.min(maxLevel, level));

    // Only overlay detail tiles when they're finer than the base thumbnail.
    if (level < maxLevel) {
      const { width: WL, height: HL } = levels[level];
      const sx = W0 / WL;
      const sy = H0 / HL;

      // Viewport world rect -> level-0 pixel bbox (inverse affine on 4 corners,
      // so rotated images still map correctly).
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

      for (let row = row0; row <= row1; row++) {
        for (let col = col0; col <= col1; col++) {
          const url = getImageTileUrl(sessionId, element, level, col, row, visibleChannels);
          const img = getImage(url, bump);
          if (!img) { loading = true; continue; }
          // tile pixel rect at level L, scaled back to level-0 pixel space.
          const px0 = col * T * sx;
          const px1 = Math.min((col + 1) * T, WL) * sx;
          const py0 = row * T * sy;
          const py1 = Math.min((row + 1) * T, HL) * sy;
          layers.push(new BitmapLayer({
            id: `img-tile-${element}-${level}-${col}-${row}-${visibleChannels}`,
            image: img,
            bounds: quad(m, px0, py0, px1, py1),
          }));
        }
      }
    }

    return { layers, loading };
    // bump is a render trigger; imgCache reads are keyed by the URL deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageInfo, sessionId, element, visibleChannels, show, zoom, tx, ty,
      size?.width, size?.height, tick]);
}
