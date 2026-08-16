// The values the canvases apply when an encoding field is absent, as named constants.
//
// Older checkpoints predate most of the optional `DisplayEncoding` fields, so the
// canvas reads each as `encoding.x ?? DEFAULT`. A host that authors a display (the
// Cirro dashboard's inspector) has to agree on those fallbacks or its controls read
// back the wrong state; exporting them is how it agrees instead of restating them.
//
// The required fields come from `manager.auto_displays` (backend/app/sessions/
// manager.py), which is what a session's first display is created with.

import type { DisplayEncoding, EmbeddingEncoding } from './types';

/** Point styling shared by both display kinds (manager.auto_displays). */
const POINT_DEFAULTS = {
  point_size: 4,
  opacity: 0.85,
  colormap: 'viridis',
} as const;

/**
 * Spatial-canvas encoding defaults. `show_image` is the one fallback that isn't a
 * constant — it defaults to "on when the display has an image element" — so it is
 * absent here; use `showImageDefault(encoding)`.
 */
export const SPATIAL_ENCODING_DEFAULTS = {
  ...POINT_DEFAULTS,
  shapes_layer: null,
  legend_visible: true,
  legend_title: '',
  show_points: true,
  show_channel_legend: true,
  show_minimap: true,
  render_mode: 'points',
  point_marker: 'circle',
  boundary_style: 'filled',
  boundary_line_width: 1,
  invert_x: false,
  invert_y: false,
  background: 'dark',
} as const satisfies Partial<DisplayEncoding>;

/** Embedding-canvas encoding defaults (manager.auto_displays). */
export const EMBEDDING_ENCODING_DEFAULTS = {
  ...POINT_DEFAULTS,
  x_component: 0,
  y_component: 1,
  z_component: 2,
  is_3d: false,
  legend_visible: true,
  legend_title: '',
} as const satisfies Partial<EmbeddingEncoding>;

/** Image-layer visibility: on unless the display has no image to show. */
export function showImageDefault(encoding: Pick<DisplayEncoding, 'image_layer'>): boolean {
  return encoding.image_layer !== null;
}
