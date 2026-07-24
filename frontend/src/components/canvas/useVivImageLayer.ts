import { useEffect, useMemo, useState } from 'react';
import type { Layer, OrthographicViewState } from '@deck.gl/core';
import { loadOmeZarr } from '@vivjs/loaders';
import { MultiscaleImageLayer } from '@vivjs/layers';
import { ColorPaletteExtension } from '@vivjs/extensions';
import type { ImageInfo } from '../../types';
import { MAX_VISIBLE_CHANNELS, type Channel } from './useImageChannels';
import { transparentBlackExtension } from './transparentBlackExtension';

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

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = Number.parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// The image must never occlude the points drawn after it: the merged point scatter writes
// gl_FragDepth to resolve overlaps and relies on the image writing no depth (see
// buildSpotLayer). deck.gl forwards `parameters` to a CompositeLayer's sublayers, so this
// reaches MultiscaleImageLayer's tiled XRLayers and its low-res background alike.
const IMAGE_PARAMS = { depthWriteEnabled: false, depthCompare: 'always' as const };

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
    };
    // Viv's published props type both requires `dtype` (read from loader[0] at runtime,
    // not props) and omits `colors` (forwarded to the ColorPaletteExtension); it types the
    // instance as `any`. Assert through `unknown` rather than widen every usage.
    const vivProps = props as unknown as ConstructorParameters<typeof MultiscaleImageLayer>[0];
    return [new MultiscaleImageLayer(vivProps) as unknown as Layer];
  }, [enabled, failed, loader, imageInfo, isRgb, activeSelections, channels, element, viewReady]);

  return { layers, active: enabled && !failed && loader !== null && layers.length > 0 };
}
