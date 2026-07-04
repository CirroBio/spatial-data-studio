import { useMemo } from 'react';
import type { SpatialDisplaySpec, ImageInfo } from '../../types';
import { putDisplay } from '../../api';
import { defaultChannelColor } from './colorUtils';

export interface Channel {
  index: number;
  visible: boolean;
  name: string;
  color: string;
}

interface Params {
  imageInfo: ImageInfo | null;
  display: SpatialDisplaySpec;
  sessionId: string;
  updateDisplay: (display: SpatialDisplaySpec) => void;
}

export function useImageChannels(
  { imageInfo, display, sessionId, updateDisplay }: Params,
): {
  channels: Channel[];
  visibleChannels: string;
  setChannel: (index: number, patch: Partial<{ visible: boolean; name: string; color: string }>) => void;
} {
  // Per-channel display state (v3 Part 10): persisted in the display encoding,
  // defaulting to all-visible with the raw channel names from image_info.
  const channels = useMemo(
    () => (imageInfo?.channel_names ?? []).map((cn, i) => ({
      index: i,
      visible: display.encoding.channels?.[String(i)]?.visible ?? true,
      name: display.encoding.channels?.[String(i)]?.name ?? cn,
      color: display.encoding.channels?.[String(i)]?.color ?? defaultChannelColor(i),
    })),
    [imageInfo, display.encoding.channels],
  );
  const visibleChannels = channels
    .filter((c) => c.visible)
    .map((c) => `${c.index}:${c.color.replace('#', '')}`)
    .join(',');

  function setChannel(index: number, patch: Partial<{ visible: boolean; name: string; color: string }>) {
    const cur = channels[index];
    const next = { ...(display.encoding.channels ?? {}) };
    next[String(index)] = { visible: cur.visible, name: cur.name, color: cur.color, ...patch };
    const spec = { ...display, encoding: { ...display.encoding, channels: next } };
    updateDisplay(spec);                       // optimistic local update
    putDisplay(sessionId, spec).catch(console.error);
  }

  return { channels, visibleChannels, setChannel };
}
