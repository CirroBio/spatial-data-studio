// A scale bar for spatial figures. Drawn only when the store says what its coordinates
// measure: a wrong scale bar is worse than none.
import type { AsyncReadable } from '@zarrita/storage';

// spatialdata-io readers whose global coordinate system is in microns. Checked on a
// Xenium store: its morphology image maps 0.2125 µm per pixel at full resolution,
// Xenium's documented pixel size.
const MICRON_READERS = new Set(['xenium', 'merscope']);

/** The spatialdata-io reader that wrote the store (`xenium`, `visium`, ...): recorded by
 * spatialdata-io in the root's attributes, or by Spatial Data Studio's workflow as the
 * first step of the store's history. Null when neither says. */
export async function storeReader(store: Required<AsyncReadable>): Promise<string | null> {
  const bytes = await store.get('/zarr.json');
  if (!bytes) return null;
  const attrs = (JSON.parse(new TextDecoder().decode(bytes)).attributes ?? {}) as {
    spatialdata_io_reader?: string;
    app_state?: { compute_history?: { namespace?: string; function?: string }[] };
  };
  const first = attrs.app_state?.compute_history?.[0];
  return attrs.spatialdata_io_reader ?? (first?.namespace === 'io' ? first.function ?? null : null);
}

/** The unit of the store's world coordinates, from the reader that wrote it. */
export const coordinateUnit = (reader: string | null): 'µm' | null => (reader && MICRON_READERS.has(reader) ? 'µm' : null);

export interface ScaleBar {
  /** Length of the bar as a fraction of the image's width. */
  fraction: number;
  label: string;
}

/** A round length (1, 2 or 5 × 10^n µm) near a fifth of the visible width. */
export function scaleBar(worldWidth: number): ScaleBar {
  const target = worldWidth / 5;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = [5, 2, 1].find((s) => s * magnitude <= target) ?? 1;
  const length = step * magnitude;
  const label = length >= 1000 ? `${length / 1000} mm` : `${length} µm`;
  return { fraction: length / worldWidth, label };
}
