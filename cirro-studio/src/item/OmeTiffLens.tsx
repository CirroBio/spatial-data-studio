// An OME-TIFF read in place by range requests (Viv's loader over geotiff) and drawn as a
// pyramid in the lens: the first channels tinted and composited, contrast taken from
// the coarsest level.
import { useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView, type Layer } from '@deck.gl/core';
import { getChannelStats, loadOmeTiff } from '@vivjs/loaders';
import { MultiscaleImageLayer } from '@vivjs/layers';
import { CHANNEL_COLORS, hexToRgb } from '@cirrobio/spatial-viewer';
import { useSize } from '../lib/useSize';

export const MAX_CHANNELS = 6;

export interface ImageChannel {
  name: string;
  visible: boolean;
  color: string;
  // Null until read; a channel is drawn only once it has them.
  limits: [number, number] | null;
}

type Loader = Awaited<ReturnType<typeof loadOmeTiff>>;
type Level = Loader['data'][number];

export interface OpenedImage {
  data: Level[];
  width: number;
  height: number;
  channels: ImageChannel[];
  isRgb: boolean;
}

// Only the channels shown first have their limits read before this resolves; the rest are
// left null for the caller to fill in with channelLimits once the image is up. Without an
// offsets table, a channel's IFD is found by walking the IFD chain from the first, one
// range read per channel, so reading every channel here would put that many reads in a
// row ahead of the first draw.
export async function openOmeTiff(url: string): Promise<OpenedImage> {
  const { data, metadata } = await loadOmeTiff(url);
  const pixels = metadata.Pixels;
  const names = pixels.Channels.map((c, i) => c.Name ?? `Channel ${i + 1}`);
  const isRgb = pixels.Interleaved || (pixels.Type === 'uint8' && names.length === 3);
  const shown = Math.min(names.length, isRgb ? 3 : 4);
  const channels = await Promise.all(names.map(async (name, c): Promise<ImageChannel> => {
    const color = isRgb ? ['#ff0000', '#00ff00', '#0000ff'][c] : CHANNEL_COLORS[c % CHANNEL_COLORS.length];
    const limits = c < shown ? await channelLimits(data, c) : null;
    return { name, visible: c < shown, color, limits };
  }));
  return { data, width: pixels.SizeX, height: pixels.SizeY, channels, isRgb };
}

/** A channel's contrast limits, taken from the coarsest level. */
export async function channelLimits(data: Level[], c: number): Promise<[number, number]> {
  const raster = await data[data.length - 1].getRaster({ selection: { c, t: 0, z: 0 } });
  const { contrastLimits } = getChannelStats(raster.data);
  return [contrastLimits[0], contrastLimits[1]];
}

export function OmeTiffLens({ image, channels }: { image: OpenedImage; channels: ImageChannel[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useSize(ref);
  const [viewState, setViewState] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (!size.width || viewState) return;
    const zoom = Math.log2(Math.min(size.width / image.width, size.height / image.height) * 0.95);
    setViewState({ target: [image.width / 2, image.height / 2, 0], zoom, minZoom: zoom - 2, maxZoom: 4 });
  }, [size, image, viewState]);
  // The layer is rebuilt when what it draws changes, not on every render. A channel switched
  // on before its limits are read joins it when they arrive.
  const shownKey = JSON.stringify(channels.map((c, i) => ({ ...c, c: i })).filter((c) => c.visible && c.limits).slice(0, MAX_CHANNELS));
  const layers = useMemo((): Layer[] => {
    const shown = JSON.parse(shownKey) as (ImageChannel & { c: number; limits: [number, number] })[];
    if (!shown.length) return [];
    const props = {
      id: 'ome-tiff',
      loader: image.data,
      selections: shown.map((c) => ({ c: c.c, t: 0, z: 0 })),
      channelsVisible: shown.map(() => true),
      colors: shown.map((c) => hexToRgb(c.color)),
      contrastLimits: shown.map((c) => c.limits),
    };
    // Viv types its props loosely (see packages/viewer/src/canvas/useVivImageLayer.ts).
    return [new MultiscaleImageLayer(props as unknown as ConstructorParameters<typeof MultiscaleImageLayer>[0]) as unknown as Layer];
  }, [image, shownKey]);
  return (
    <div className="lens-canvas" ref={ref}>
      {viewState && (
        <DeckGL views={new OrthographicView({ id: 'image', controller: true })} viewState={viewState as never}
          onViewStateChange={({ viewState: v }) => setViewState(v as Record<string, unknown>)} layers={layers} />
      )}
    </div>
  );
}
