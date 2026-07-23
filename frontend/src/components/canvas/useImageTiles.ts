import { useMemo, useReducer } from 'react';
import { BitmapLayer } from '@deck.gl/layers';
import type { Layer, OrthographicViewState } from '@deck.gl/core';
import type { ImageInfo } from '../../types';
import { getImageTileUrl, getImageThumbnailUrl } from '../../api';
import { quad } from './imageAffine';
import { selectTileRange } from './tileLevelOfDetail';
import { transparentBlackExtension } from './transparentBlackExtension';

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

    // The server composites fluorescence tiles additively from black (imaging.py
    // _composite), so a zero-intensity pixel is opaque black — without this it
    // would paint over the themed backdrop (PLOT_BACKGROUNDS) everywhere the image
    // has no signal, making the light/dark background toggle look dead inside the
    // image's bounds. True-color RGB (e.g. H&E) keeps black — it's real tissue.
    const imageExtensions = imageInfo.is_rgb ? [] : [transparentBlackExtension];

    // Always-present coarse base so the canvas is never blank while tiles load.
    const baseUrl = getImageThumbnailUrl(sessionId, element, visibleChannels);
    const baseImg = getImage(baseUrl, bump);
    if (baseImg) {
      layers.push(new BitmapLayer({
        id: `img-base-${element}-${visibleChannels}`,
        image: baseImg,
        bounds: quad(m, 0, 0, W0, H0),
        // The image never participates in depth: it must not occlude the cell
        // layers drawn after it (the merged cell scatter writes gl_FragDepth to
        // resolve overlaps, and cells must always sit above the tissue image).
        parameters: { depthWriteEnabled: false, depthCompare: 'always' },
        extensions: imageExtensions,
      }));
    } else {
      loading = true;
    }

    const { level, sx, sy, col0, col1, row0, row1 } =
      selectTileRange(imageInfo, size, zoom, tx, ty, maxLevel);

    // Only overlay detail tiles when they're finer than the base thumbnail.
    if (level < maxLevel) {
      const { width: WL, height: HL } = levels[level];

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
            parameters: { depthWriteEnabled: false, depthCompare: 'always' },
            extensions: imageExtensions,
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
