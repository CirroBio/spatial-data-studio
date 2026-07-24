import { useEffect, useMemo, useState } from 'react';
import type { Layer, OrthographicViewState } from '@deck.gl/core';
import { loadOmeZarr } from '@vivjs/loaders';
import { MultiscaleImageLayer } from '@vivjs/layers';
import { ColorPaletteExtension } from '@vivjs/extensions';
import type { ImageInfo } from '../../types';
import { MAX_VISIBLE_CHANNELS, type Channel } from './useImageChannels';
import { transparentBlackExtension } from './transparentBlackExtension';
import { useImageTilePrefetch } from './useImageTilePrefetch';
import { hexToRgb } from './colorUtils';

// Client-side GPU compositing of the tissue image via Viv's own `MultiscaleImageLayer`
// — the sole canvas image path. When an image is shown, the canvas view is in the
// image's own pixel coordinate space (SpatialCanvas gives the cell points a world->pixel
// modelMatrix; the image needs none), so MultiscaleImageLayer's deck.gl TileLayer selects
// and streams pyramid tiles natively — no hand-rolled per-tile scheme, no coarse-base
// bookkeeping (deck keeps the best-available parent tile visible and drops it as finer
// tiles arrive). Channel color/visibility/contrast are shader uniforms (instant, no
// refetch). Disabled by the localStorage escape hatch below (turns the canvas image off;
// there is no server-composited fallback).

const DISABLE_KEY = 'sds:disableClientCompositing';
function clientCompositingDisabled(): boolean {
  try {
    return localStorage.getItem(DISABLE_KEY) === '1';
  } catch {
    return false;
  }
}

// The image must never occlude the points drawn after it: the merged point scatter writes
// gl_FragDepth to resolve overlaps and relies on the image writing no depth (see
// buildSpotLayer). deck.gl forwards `parameters` to a CompositeLayer's sublayers, so this
// reaches MultiscaleImageLayer's tiled XRLayers and its low-res background alike.
const IMAGE_PARAMS = { depthWriteEnabled: false, depthCompare: 'always' as const };

// Tile-streaming smoothness (forwarded to the deck.gl TileLayer inside Viv's
// MultiscaleImageLayer — MultiscaleImageLayerBase extends TileLayer and Viv passes
// `this.props` straight through). Two levers:
//  - maxCacheSize: deck defaults to 5x the current viewport's tiles, so panning/zooming
//    back to a spot just visited re-fetches evicted tiles (visible flicker). We instead
//    size the cache from a fixed memory budget so previously seen tiles stay resident.
//    Bounding by *count* alone is unsafe: a tile holds one typed array per active channel,
//    so a fixed count would swing from ~256MB (1ch) to ~1.5GB (6ch). Bounding by bytes
//    (maxCacheByteSize) is unusable here — Viv's tile content is a plain object with no
//    `byteLength`, which deck logs as an error and mismeasures — so we derive the count
//    from the budget and the actual per-tile size.
//  - debounceTime: deck fires tile requests for every pyramid level the camera sweeps
//    through during a continuous zoom/pan (and the animated zoom-button ease), then drops
//    them as the camera keeps moving. Debouncing collapses those into one request at the
//    settled viewport, killing most mid-gesture flicker at the cost of a small settle delay.
const TILE_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;
const TILE_REQUEST_DEBOUNCE_MS = 150;

// Viv dtypes are the fixed set Uint/Int 8|16|32 and Float 32|64 — the trailing bit width
// is the byte count. Falls back to 2 (Uint16, the common microscopy case).
function bytesPerSample(dtype: string): number {
  const bits = Number.parseInt(dtype.replace(/\D/g, ''), 10);
  return Number.isFinite(bits) && bits > 0 ? bits / 8 : 2;
}

type Loader = Awaited<ReturnType<typeof loadOmeZarr>>['data'];

interface Params {
  imageInfo: ImageInfo | null;
  element: string | null;
  channels: Channel[];
  viewState: OrthographicViewState | null;
  size: { width: number; height: number } | null;
  show: boolean;
}

/** GPU-composites the tissue image from the SpatialData multiscale pyramid via Viv's
 * `MultiscaleImageLayer`. `active` is true once the pyramid loader is ready (the layer
 * renders its own low-res background immediately and streams detail tiles as deck's
 * TileLayer selects them). While loading or after a failure it is false and the canvas
 * simply shows no image. See DESIGN.md 9.4. */
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

  const allSelections = useMemo(
    () => Array.from({ length: numChannels }, (_, c) => ({ c })),
    [numChannels],
  );

  // Viv composites at most MAX_VISIBLE_CHANNELS in one shader pass. At/below that count
  // we pass every channel and toggle visibility via the channelsVisible uniform (instant,
  // no refetch); above it we pass only the (<= MAX) visible channels. Memoized on its own
  // so a pan/zoom never mints a new `selections` array — a changed selections reference
  // makes Viv treat it as a channel-set change and refetch tiles (only the visible set,
  // not the camera, should trigger that).
  const activeSelections = useMemo(
    () => (numChannels <= MAX_VISIBLE_CHANNELS
      ? allSelections
      : allSelections.filter((s) => channels[s.c]?.visible).slice(0, MAX_VISIBLE_CHANNELS)),
    [allSelections, numChannels, channels],
  );

  // Presence-only gate: the layer needs the view *framed* before fetching (so image
  // chunks don't monopolize the browser's per-host connections and starve the coords
  // read), but MultiscaleImageLayer's TileLayer reads the live viewport from deck's
  // render context, not props — so depend on a boolean, never the viewState object,
  // or the layer (and its channel arrays) would be rebuilt on every camera move.
  const viewReady = !!viewState && !!size;

  // Idle look-ahead prefetch: warm the tiles a zoom-in/pan is about to need while the
  // camera is still. Keyed on the camera (not the layer memo), so it never rebuilds the
  // image layer. See useImageTilePrefetch.
  useImageTilePrefetch({
    loader,
    selections: activeSelections,
    viewState,
    size,
    enabled: enabled && !failed,
    resetKey: storeUrl,
  });

  const layers = useMemo(() => {
    if (!enabled || failed || !loader || !viewReady) return [] as Layer[];

    // Color/visibility come from the (editable) channel state for every image, RGB
    // included: an H&E's channels default to red/green/blue (useImageChannels), so the
    // additive tint reproduces true color out of the box, but the user can now recolor,
    // hide, or contrast-adjust them like any fluorescence channel.
    const channelsVisible = activeSelections.map((s) => channels[s.c]?.visible ?? true);
    const colors = activeSelections.map((s) => hexToRgb(channels[s.c]?.color ?? '#ffffff'));
    // Per-channel [min,max]: the channel's effective contrastLimits (user override or
    // the server default, resolved in useImageChannels), falling back to the raw
    // server default then [0,255] for any channel not in the derived list.
    const limits = imageInfo?.contrast_limits ?? [];
    const contrastLimits = activeSelections.map((s) => channels[s.c]?.contrastLimits ?? limits[s.c] ?? [0, 255]);

    // Fluorescence composites additively from black; zero-intensity pixels are opaque black
    // and would hide the themed backdrop. transparentBlackExtension maps exact black to
    // alpha 0 so empty areas show the backdrop, forwarded to the tile sublayers via deck's
    // `extensions` prop (Viv's own transparentColor prop is not forwarded through
    // MultiscaleImageLayer's TileLayer). A true-color RGB image keeps black (real data).
    const imageExtensions = isRgb
      ? [new ColorPaletteExtension()]
      : [new ColorPaletteExtension(), transparentBlackExtension];

    // Size the tile cache from the byte budget and the actual per-tile footprint
    // (tileSize^2 * bytesPerSample * one array per active channel). Floor at 64 tiles so a
    // heavy multi-channel image still caches more than a single viewport; the layer already
    // caps active channels at MAX_VISIBLE_CHANNELS, so the footprint is bounded.
    const { tileSize, dtype } = loader[0];
    const perTileBytes = tileSize * tileSize * bytesPerSample(dtype) * activeSelections.length;
    const maxCacheSize = Math.max(64, Math.floor(TILE_CACHE_BUDGET_BYTES / Math.max(1, perTileBytes)));

    // No modelMatrix: the canvas view is already in this image's pixel space (see
    // SpatialCanvas), so the image sits at its own extent [0,0,W,H] and deck's TileLayer
    // selects tiles natively — the case Viv is designed for.
    const props = {
      id: `viv-image-${element}`,
      loader,
      selections: activeSelections,
      channelsVisible,
      colors,
      contrastLimits,
      parameters: IMAGE_PARAMS,
      extensions: imageExtensions,
      // Forwarded through to the deck.gl TileLayer (see the notes above the constants).
      maxCacheSize,
      debounceTime: TILE_REQUEST_DEBOUNCE_MS,
      // Refinement strategy per opacity, like Viv does — but keyed on whether the tiles are
      // actually opaque, which for us is `isRgb`, NOT deck's `opacity` prop (always 1 here).
      // 'best-available' keeps a coarse ancestor tile visible while a finer one loads; for
      // opaque RGB that just overpaints, but fluorescence tiles are semi-transparent
      // (transparentBlackExtension maps black->alpha 0 and channels composite additively), so
      // an ancestor and its finer tile briefly overlapping during a zoom SUM — the tile flashes
      // lighter, then settles darker when the ancestor drops. 'no-overlap' never draws
      // overlapping levels, killing that flash; the coarse base ImageLayer still fills
      // not-yet-loaded regions, so there's no blanking. (Viv itself switches to 'no-overlap'
      // for opacity < 1 for exactly this reason.)
      refinementStrategy: isRgb ? 'best-available' : 'no-overlap',
    };
    // Viv's published props type both requires `dtype` (read from loader[0] at runtime,
    // not props) and omits `colors` (forwarded to the ColorPaletteExtension); it types the
    // instance as `any`. Assert through `unknown` rather than widen every usage.
    const vivProps = props as unknown as ConstructorParameters<typeof MultiscaleImageLayer>[0];
    return [new MultiscaleImageLayer(vivProps) as unknown as Layer];
  }, [enabled, failed, loader, imageInfo, isRgb, activeSelections, channels, element, viewReady]);

  return { layers, active: enabled && !failed && loader !== null && layers.length > 0 };
}
