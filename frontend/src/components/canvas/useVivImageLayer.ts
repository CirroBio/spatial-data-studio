import { useEffect, useMemo, useReducer, useState } from 'react';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Layer, OrthographicViewState } from '@deck.gl/core';
import { Matrix4 } from '@math.gl/core';
import { loadOmeZarr } from '@vivjs/loaders';
import { XRLayer } from '@vivjs/layers';
import { ColorPaletteExtension } from '@vivjs/extensions';
import type { ImageInfo } from '../../types';
import type { Channel } from './useImageChannels';
import { worldToPixel } from './imageAffine';

// Client-side GPU compositing of the tissue image via Viv, an alternative to the
// server-composited PNG BitmapLayers (useImageTiles). Enabled only when the backend
// manifest reports `client_compositing` (which already gates channel count and the
// presence of a served Zarr store), and disabled outright by the localStorage escape
// hatch below. Channel color / visibility / contrast are shader uniforms, so toggling
// them updates instantly with no chunk refetch.
//
// We do NOT use Viv's `MultiscaleImageLayer` (a deck.gl TileLayer whose tile-index math
// fetches zero tiles — silently — under our world-coordinate OrthographicView with a
// non-unit-scale `pixel_to_world` modelMatrix, e.g. Xenium ~0.2125 um/px). Instead we
// build our own tiled path: the same world-coordinate tile selection the PNG path uses
// (useImageTiles), rendering a Viv `XRLayer` per visible tile, over a coarse Viv
// `ImageLayer` base so the canvas is never blank while detail streams. Every XRLayer
// shares one level-0 pixel->world modelMatrix and expresses its bounds in level-0
// pixels, so the scaled/rotated affine positions each tile exactly as the working
// single ImageLayer did, matching the points.

// Max single-texture dimension we will upload for the base level; the finest pyramid
// level whose longest side is within this is chosen. luma/WebGL2 guarantees at least
// 2048 and virtually all GPUs do 4096+; Viv documents 4096 as the non-pyramidal ceiling.
const MAX_TEXTURE_PX = 4096;

// Dev/QA escape hatch: `localStorage.setItem('sds:disableClientCompositing', '1')`
// forces the PNG tile path even when the server offers client compositing.
const DISABLE_KEY = 'sds:disableClientCompositing';
function clientCompositingDisabled(): boolean {
  try {
    return localStorage.getItem(DISABLE_KEY) === '1';
  } catch {
    return false;
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = Number.parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// True-color 3-channel image: draw R/G/B straight through rather than tinting each
// channel with a palette color (mirrors backend imaging._is_rgb passthrough).
const RGB_COLORS: [number, number, number][] = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];

// The image must never occlude the points drawn after it: the merged point scatter
// writes gl_FragDepth to resolve overlaps and relies on the image writing no depth
// (see buildSpotLayer). Same no-depth parameters the PNG BitmapLayers use.
const IMAGE_PARAMS = { depthWriteEnabled: false, depthCompare: 'always' as const };

type Loader = Awaited<ReturnType<typeof loadOmeZarr>>['data'];
// A resolved tile / raster from a single-channel getTile: { data, width, height }.
type PixelData = Awaited<ReturnType<Loader[number]['getTile']>>;
// One decoded tile across all channels: the per-channel typed arrays XRLayer's
// `channelData` expects, plus the shared width/height.
interface ChannelRaster {
  data: PixelData['data'][];
  width: number;
  height: number;
}

// Module-level decoded-tile cache so pan/zoom reuses tiles and we can track exactly
// when each tile is ready. Keyed by (element, level, col, row) only — the raw pixels
// don't depend on color/contrast/visibility, which are XRLayer uniforms applied at
// construction, so layers rebuild cheaply each render from cached rasters.
const CACHE_MAX = 240;
const tileCache = new Map<string, ChannelRaster>();
const tilePending = new Set<string>();

function getTileData(
  key: string,
  fetchTile: () => Promise<ChannelRaster>,
  onLoad: () => void,
): ChannelRaster | null {
  const hit = tileCache.get(key);
  if (hit) {
    tileCache.delete(key);
    tileCache.set(key, hit); // LRU bump
    return hit;
  }
  if (!tilePending.has(key)) {
    tilePending.add(key);
    fetchTile()
      .then((raster) => {
        tilePending.delete(key);
        tileCache.set(key, raster);
        if (tileCache.size > CACHE_MAX) tileCache.delete(tileCache.keys().next().value as string);
        onLoad();
      })
      .catch(() => { tilePending.delete(key); });
  }
  return null;
}

interface Params {
  imageInfo: ImageInfo | null;
  element: string | null;
  channels: Channel[];
  viewState: OrthographicViewState | null;
  size: { width: number; height: number } | null;
  show: boolean;
}

/** Coarse Viv ImageLayer base plus per-tile Viv XRLayers for the current viewport,
 * GPU-compositing the tissue image from the SpatialData multiscale pyramid. `active`
 * is true once the pyramid has loaded without error, signalling the caller to suppress
 * the PNG tile path; while loading or after a failure it stays false so PNG covers. */
export function useVivImageLayer(
  { imageInfo, element, channels, viewState, size, show }: Params,
): { layers: Layer[]; active: boolean } {
  const enabled = show
    && !!element
    && !!imageInfo?.client_compositing
    && !!imageInfo.raster_base_url
    && !!imageInfo.zarr_group_path
    && !clientCompositingDisabled();

  // Absolute store URL: zarrita's FetchStore does `new URL(root)`, which rejects a
  // root-relative path, so resolve against the current origin (the dev proxy and prod
  // both serve /api on the same origin).
  const storeUrl = enabled
    ? new URL(`${imageInfo!.raster_base_url}/${imageInfo!.zarr_group_path}`, window.location.origin).href
    : null;

  const [loader, setLoader] = useState<Loader | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, bump] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    setLoader(null);
    setFailed(false);
    if (!storeUrl) return;
    let stale = false;
    loadOmeZarr(storeUrl, { type: 'multiscales' })
      .then(({ data }) => { if (!stale) setLoader(data); })
      .catch((e) => { if (!stale) { console.error('Viv loadOmeZarr failed', e); setFailed(true); } });
    return () => { stale = true; };
  }, [storeUrl]);

  const numChannels = imageInfo?.channels ?? 0;
  const isRgb = !!imageInfo?.is_rgb;

  // Stable across renders while the channel count holds; a fresh array each render would
  // reload the channel textures. Visibility/color/contrast are separate uniform props.
  const selections = useMemo(
    () => Array.from({ length: numChannels }, (_, c) => ({ c })),
    [numChannels],
  );

  const zoom = viewState ? (Array.isArray(viewState.zoom) ? viewState.zoom[0] : viewState.zoom) ?? 0 : 0;
  const target = viewState?.target;
  const tx = target ? target[0] : 0;
  const ty = target ? target[1] : 0;

  const layers = useMemo(() => {
    if (!enabled || failed || !loader || !imageInfo?.pixel_to_world || !imageInfo.levels.length) {
      return [];
    }
    const m = imageInfo.pixel_to_world;
    const levels = imageInfo.levels;
    const maxLevel = Math.min(levels.length, loader.length) - 1;
    const T = imageInfo.tile_size;
    const [W0, H0] = [levels[0].width, levels[0].height];

    // Fluorescence composites additively from black, so zero-intensity pixels are
    // opaque black and would hide the themed backdrop (PLOT_BACKGROUNDS) behind the
    // image's whole bounding box — making the light/dark background toggle look dead.
    // Map exact black to alpha 0 so empty areas show the backdrop. A true-color RGB
    // image keeps black (it is real data, e.g. an H&E stain), so it stays opaque.
    const useTransparentColor = !isRgb;

    const channelsVisible = isRgb
      ? selections.map(() => true)
      : selections.map((_, i) => channels[i]?.visible ?? true);
    const colors = isRgb
      ? selections.map((_, i) => RGB_COLORS[i] ?? [255, 255, 255])
      : selections.map((_, i) => hexToRgb(channels[i]?.color ?? '#ffffff'));
    const limits = imageInfo.contrast_limits ?? [];
    const contrastLimits = selections.map((_, i) => limits[i] ?? [0, 255]);

    // Level-0 pixel -> world affine [a,b,c,d,e,f], one Matrix4 shared by every tile:
    // maps [px,py,0,1] -> [wx,wy,0,1] (column-major). Tile bounds are in level-0 pixels.
    const [a, b, c, d, e, f] = m;
    const modelMatrix0 = new Matrix4([a, d, 0, 0, b, e, 0, 0, 0, 0, 1, 0, c, f, 0, 1]);

    const result: Layer[] = [];

    // Coarse whole-image base so the canvas is never blank while detail tiles load.
    // Finest pyramid level that fits a single texture (the coarsest always qualifies).
    // Rendered as an XRLayer (not Viv's ImageLayer) so it uses the SAME bounds/y
    // convention as the detail tiles: the coarse texture is stretched over the whole
    // image in level-0 pixels and positioned by the shared level-0 modelMatrix.
    let res = levels.findIndex((l) => l.width <= MAX_TEXTURE_PX && l.height <= MAX_TEXTURE_PX);
    if (res < 0) res = levels.length - 1;
    res = Math.min(res, loader.length - 1);
    const baseRaster = getTileData(
      `${element}|base|${res}`,
      () => Promise.all(
        selections.map((selection) => loader[res].getRaster({ selection })),
      ).then((chs) => ({ data: chs.map((t) => t.data), width: chs[0].width, height: chs[0].height })),
      bump,
    );
    if (baseRaster) {
      result.push(new XRLayer({
        id: `viv-image-base-${element}`,
        channelData: baseRaster,
        bounds: [0, H0, W0, 0],
        dtype: loader[res].dtype,
        selections,
        channelsVisible,
        colors,
        contrastLimits,
        modelMatrix: modelMatrix0,
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        parameters: IMAGE_PARAMS,
        extensions: [new ColorPaletteExtension()],
        transparentColor: [0, 0, 0],
        useTransparentColor,
        opacity: 1,
      }) as Layer);
    }

    // Detail tiles for the current viewport, only when finer than the base level.
    // Pick the coarsest level whose native resolution still matches the screen:
    // world units per screen pixel = 2^-zoom; per level-0 pixel = worldW / W0.
    const worldPerScreenPx = Math.pow(2, -zoom);
    const worldPerPx0 = Math.abs(imageInfo.bounds[2] - imageInfo.bounds[0]) / W0;
    let level = Math.floor(Math.log2(Math.max(worldPerScreenPx / worldPerPx0, 1e-9)));
    level = Math.max(0, Math.min(maxLevel, level));

    if (viewState && size && level < res) {
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

      const source = loader[level];
      const dtype = source.dtype;
      for (let row = row0; row <= row1; row++) {
        for (let col = col0; col <= col1; col++) {
          const key = `${element}|${level}|${col}|${row}`;
          const raster = getTileData(
            key,
            () => Promise.all(
              selections.map((selection) => source.getTile({ x: col, y: row, selection })),
            ).then((tiles) => ({
              data: tiles.map((t) => t.data),
              width: tiles[0].width,
              height: tiles[0].height,
            })),
            bump,
          );
          if (!raster) continue;
          // tile pixel rect at level L, scaled back to level-0 pixel space. XRLayer
          // bounds are axis-aligned [left, bottom, right, top] and Viv maps data row 0 to
          // `top` (bounds[3]). The app's world/OrthographicView is y-up (a cell at world
          // y=0 sits at screen bottom), so image row 0 (pixel py=0, world y=0 via the
          // affine) must also land at the bottom: put py0 (row-0 side) as bounds[3]=top and
          // py1 as bounds[1]=bottom — bounds [px0, py1, px1, py0], matching the PNG quad.
          const px0 = col * T * sx;
          const px1 = Math.min((col + 1) * T, WL) * sx;
          const py0 = row * T * sy;
          const py1 = Math.min((row + 1) * T, HL) * sy;
          result.push(new XRLayer({
            id: `viv-tile-${element}-${level}-${col}-${row}`,
            channelData: raster,
            bounds: [px0, py1, px1, py0],
            dtype,
            selections,
            channelsVisible,
            colors,
            contrastLimits,
            modelMatrix: modelMatrix0,
            coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
            parameters: IMAGE_PARAMS,
            extensions: [new ColorPaletteExtension()],
            transparentColor: [0, 0, 0],
            useTransparentColor,
            opacity: 1,
          }) as Layer);
        }
      }
    }

    return result;
    // bump/tick is a render trigger; tileCache reads are keyed by the deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, failed, loader, imageInfo, isRgb, selections, channels, element,
      viewState, size, zoom, tx, ty, size?.width, size?.height, tick]);

  return { layers, active: enabled && !failed && loader !== null };
}
