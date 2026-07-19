import { useEffect, useMemo, useState } from 'react';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { Matrix4 } from '@math.gl/core';
import { loadOmeZarr } from '@vivjs/loaders';
import { ImageLayer } from '@vivjs/layers';
import type { ImageInfo } from '../../types';
import type { Channel } from './useImageChannels';

// Client-side GPU compositing of the tissue image via Viv, an alternative to the
// server-composited PNG BitmapLayers (useImageTiles). Enabled only when the backend
// manifest reports `client_compositing` (which already gates channel count and the
// presence of a served Zarr store), and disabled outright by the localStorage escape
// hatch below. Channel color / visibility / contrast are shader uniforms, so toggling
// them updates instantly with no chunk refetch.
//
// We render Viv's single-scale `ImageLayer` (one XRLayer quad), NOT `MultiscaleImageLayer`.
// MultiscaleImageLayer wraps a deck.gl TileLayer whose tile-index computation fetches zero
// tiles — silently, no error — when the image's `pixel_to_world` affine carries a non-unit
// scale (Xenium is ~0.2125 um/px), so it never renders. A single XRLayer has no tile-index
// math, so the scaled modelMatrix just positions/scales the quad and it renders correctly.
// The tradeoff: one XRLayer loads a whole pyramid level into a single GPU texture, so we
// pick the finest level that fits MAX_TEXTURE_PX; deep zoom into a very large image shows
// that level rather than streaming full-resolution tiles (the PNG path still tiles full
// detail). Positioning uses the same `pixel_to_world` affine the PNG quad uses, adjusted
// for the chosen level's downscale, so the image aligns with the points identically.

// Max single-texture dimension we will upload; the finest pyramid level whose longest side
// is within this is chosen. luma/WebGL2 guarantees at least 2048 and virtually all GPUs do
// 4096+; Viv itself documents 4096 as the non-pyramidal ceiling.
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
// (see buildSpotLayer). Forward the same no-depth parameters the PNG BitmapLayers use;
// Viv's ImageLayer spreads its props into the XRLayer it renders.
const IMAGE_PARAMS = { depthWriteEnabled: false, depthCompare: 'always' as const };

type Loader = Awaited<ReturnType<typeof loadOmeZarr>>['data'];

interface Params {
  imageInfo: ImageInfo | null;
  element: string | null;
  channels: Channel[];
  show: boolean;
}

// Viv's exported layer prop types are loose (loader: any[]); reference the constructor's
// real parameter type and widen through it so the pseudo-color palette (`colors`, injected
// by the default ColorPaletteExtension) can be passed without `any`.
type VivImageLayerProps = ConstructorParameters<typeof ImageLayer>[0];

/** The Viv ImageLayer for the tissue image, or null. `active` is true only once the
 * pyramid has loaded without error, and signals the caller to suppress the PNG tile
 * path; while loading or after a failure it stays false so PNG covers. */
export function useVivImageLayer(
  { imageInfo, element, channels, show }: Params,
): { layer: Layer | null; active: boolean } {
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

  const layer = useMemo(() => {
    if (!enabled || failed || !loader || !imageInfo?.pixel_to_world || !imageInfo.levels.length) {
      return null;
    }

    // Finest pyramid level that fits a single texture. The normalized rasters are capped
    // at RASTER_BASE_PX (<= MAX_TEXTURE_PX), so the coarsest level always qualifies.
    const levels = imageInfo.levels;
    let res = levels.findIndex((l) => l.width <= MAX_TEXTURE_PX && l.height <= MAX_TEXTURE_PX);
    if (res < 0) res = levels.length - 1;
    res = Math.min(res, loader.length - 1);

    // Affine [a,b,c,d,e,f]: world = A * (level0-pixel). Chosen level `res` pixels map to
    // level-0 pixels by the exact per-axis ratio (sx,sy), so the level->world matrix folds
    // that ratio into the linear part: world = A * (S * level-res-pixel).
    const [a, b, c, d, e, f] = imageInfo.pixel_to_world;
    const sx = levels[0].width / levels[res].width;
    const sy = levels[0].height / levels[res].height;
    const modelMatrix = new Matrix4([
      a * sx, d * sx, 0, 0,
      b * sy, e * sy, 0, 0,
      0, 0, 1, 0,
      c, f, 0, 1,
    ]);

    const channelsVisible = isRgb
      ? selections.map(() => true)
      : selections.map((_, i) => channels[i]?.visible ?? true);
    const colors = isRgb
      ? selections.map((_, i) => RGB_COLORS[i] ?? [255, 255, 255])
      : selections.map((_, i) => hexToRgb(channels[i]?.color ?? '#ffffff'));
    // Manifest contrast per channel; pad defensively if it is short.
    const limits = imageInfo.contrast_limits ?? [];
    const contrastLimits = selections.map((_, i) => limits[i] ?? [0, 255]);

    const props = {
      id: `viv-image-${element}`,
      loader: loader[res],
      selections,
      channelsVisible,
      colors,
      contrastLimits,
      modelMatrix,
      opacity: 1,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      parameters: IMAGE_PARAMS,
      onError: (e: unknown) => { console.error('Viv image error', e); setFailed(true); },
    } as unknown as VivImageLayerProps;
    return new ImageLayer(props) as Layer;
  }, [enabled, failed, loader, imageInfo, isRgb, selections, channels, element]);

  return { layer, active: enabled && !failed && layer !== null };
}
