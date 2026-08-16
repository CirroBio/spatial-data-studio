import { useMemo } from 'react';
import type { SpatialDisplaySpec, ImageInfo } from '../types';
import { defaultChannelColor } from './colorUtils';

// Viv composites at most this many channels in one shader pass, so at most this many
// channels can be displayed at once. Images with more channels are shown as a
// user-chosen subset (the channel picker disables further toggles once this many are on).
export const MAX_VISIBLE_CHANNELS = 6;

// True-color RGB/H&E channels default to literal red/green/blue so the additive GPU
// composite reproduces the original image out of the box; the user can still recolor
// them like any fluorescence channel.
const RGB_DEFAULT_COLORS = ['#ff0000', '#00ff00', '#0000ff'];

export interface Channel {
  index: number;
  visible: boolean;
  name: string;
  color: string;
  contrastLimits: [number, number];  // effective [min,max]: user override, else server default
  contrastRange: [number, number];   // slider domain [min,max] (data range, widened to fit the default)
}

export type ChannelPatch = Partial<{ visible: boolean; name: string; color: string; contrastLimits: [number, number] }>;

interface Params {
  imageInfo: ImageInfo | null;
  display: SpatialDisplaySpec;
  // Shared persistence from useDisplayPersistence: `persistDisplay` does the optimistic
  // store write + one debounced PUT (of the live spec), and `currentSpec` reads the
  // latest stored spec. Routing channel edits through it (instead of a second debounce
  // timer here) means a color pick and a concurrent camera/opacity edit coalesce into one
  // write of the live spec, rather than racing timers where an older captured spec
  // reverts the new color; the same hook's flusher also covers channel edits on refetch.
  persistDisplay: (display: SpatialDisplaySpec) => void;
  currentSpec: () => SpatialDisplaySpec;
}

export function useImageChannels(
  { imageInfo, display, persistDisplay, currentSpec }: Params,
): {
  channels: Channel[];
  maxVisibleReached: boolean;
  setChannel: (index: number, patch: ChannelPatch) => void;
} {
  // Per-channel display state (v3 Part 10): persisted in the display encoding,
  // defaulting to the first MAX_VISIBLE_CHANNELS visible with raw channel names, the
  // palette default color, and the server's default contrast limits. The slider
  // domain is the data range widened to include the default (so the default always
  // sits inside it).
  const channels = useMemo(
    () => (imageInfo?.channel_names ?? []).map((cn, i): Channel => {
      const cs = display.encoding.channels?.[String(i)];
      const deflt = imageInfo?.contrast_limits?.[i] ?? [0, 255];
      const raw = imageInfo?.contrast_range?.[i] ?? deflt;
      return {
        index: i,
        visible: cs?.visible ?? i < MAX_VISIBLE_CHANNELS,
        name: cs?.name ?? cn,
        color: cs?.color ?? (imageInfo?.is_rgb ? RGB_DEFAULT_COLORS[i] ?? defaultChannelColor(i) : defaultChannelColor(i)),
        contrastLimits: cs?.contrast_limits ?? deflt,
        contrastRange: [Math.min(raw[0], deflt[0]), Math.max(raw[1], deflt[1])],
      };
    }),
    [imageInfo, display.encoding.channels],
  );
  const visibleCount = channels.filter((c) => c.visible).length;
  const maxVisibleReached = visibleCount >= MAX_VISIBLE_CHANNELS;

  function setChannel(index: number, patch: ChannelPatch) {
    const cur = channels[index];
    // Enforce the shader-pass cap: refuse to turn on a channel once the limit is
    // reached (the user must hide one first). Colour/name/contrast edits always apply.
    if (patch.visible === true && !cur.visible && maxVisibleReached) return;
    // Merge onto the latest stored spec, not the possibly-stale prop, so a color pick
    // never drops a camera/opacity edit that landed in the same window (and vice versa).
    const base = currentSpec();
    const prev = base.encoding.channels?.[String(index)];
    const next = { ...(base.encoding.channels ?? {}) };
    // Preserve an unset contrast_limits (= "use the server default") unless the user
    // edits it here, so a name/color/visibility change never pins the contrast.
    next[String(index)] = {
      visible: patch.visible ?? cur.visible,
      name: patch.name ?? cur.name,
      color: patch.color ?? cur.color,
      contrast_limits: patch.contrastLimits ?? prev?.contrast_limits,
    };
    persistDisplay({ ...base, encoding: { ...base.encoding, channels: next } });
  }

  return { channels, maxVisibleReached, setChannel };
}
