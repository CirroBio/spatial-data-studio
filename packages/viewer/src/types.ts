// The display model the canvases render from, and the dataset inventory they
// enumerate. This is the half of Spatial Data Studio's `types.ts` a host has to speak
// to drive the canvas; the app-only types (sessions, jobs, SSE payloads, regions)
// stay in `frontend/src/types.ts`.

export interface ObsField {
  name: string;
  kind: 'categorical' | 'numeric';
}

export interface ObsmField {
  name: string;
  n_components: number;
}

export interface ImageDims {
  name: string;
  width: number;
  height: number;
}

export interface SessionFields {
  obs: ObsField[];
  obsm: ObsmField[];
  n_obs: number;
  var_names_count: number;
  obsp: string[];
  layers: string[];
  images: string[];
  image_dims: ImageDims[];
  shapes: string[];
}

/** The formats a rendered plot figure comes in: SVG is what the app displays, PDF the
 * publication export, PNG the raster fallback. */
export type FigureFormat = 'svg' | 'pdf' | 'png';

export const FIGURE_MEDIA_TYPES: Record<FigureFormat, string> = {
  svg: 'image/svg+xml', pdf: 'application/pdf', png: 'image/png',
};

/** Which figures are available to render, by plot id and format, with each one's byte
 * length: `GET /api/sessions/{id}`'s `figures` for a live session, the checkpoint's
 * `viewer/figures` listing for a saved one. A plot absent from it has no figure to
 * show — it was never drawn, or was saved without one. */
export type FigureIndex = Record<string, Partial<Record<FigureFormat, number>>>;

export interface ChannelState {
  visible: boolean;
  name: string;
  color?: string;
  contrast_limits?: [number, number];  // per-channel [min,max] override; unset = server default
}

export interface DisplayEncoding {
  coords: string;
  // Null when the dataset offered nothing to colour by — `manager.auto_displays`
  // leaves it unset unless it finds a categorical obs column.
  color_by: string | null;
  image_layer: string | null;
  shapes_layer: string | null;
  point_size: number;
  opacity: number;
  colormap: string;
  channels?: Record<string, ChannelState>;  // per-channel on/off + rename (v3 Part 10)
  legend_visible?: boolean;  // cell-color legend (colorbar / category swatches); defaults on
  legend_title?: string;     // overrides the default title (color_by column, sans "obs:")
  // Multiplies every legend's type and swatch size (1 = as drawn until now). For a
  // legend that has to stay readable in a dashboard tile a few hundred pixels wide, or
  // in a figure printed at a fraction of screen size.
  legend_scale?: number;
  // Freezes the camera: no zoom, no pan, no rotate. A dashboard tile framed on one
  // field of view stays on it, however the viewer's mouse wanders.
  lock_view?: boolean;
  show_points?: boolean;     // cells-layer visibility; defaults on
  show_image?: boolean;      // image-layer visibility; defaults to (image_layer != null)
  show_channel_legend?: boolean;  // image channel legend visibility; defaults on
  show_minimap?: boolean;    // overview inset (minimap) in the canvas' top left; defaults on
  isolated_category?: string | null;  // isolate one category in the color-by legend (dims the rest)
  // Per-category color overrides for a categorical color-by, keyed by the color_by
  // path (obs:<col>, X:<gene>, ...) then by category level -> `#rrggbb`. Levels
  // without an entry fall back to the default categorical palette.
  category_colors?: Record<string, Record<string, string>>;
  // How the Cells layer renders. Points always draw (styled by `point_size` +
  // `point_marker`, overlaps merged not blended), visible at every zoom. 'points'
  // (default) is points only; 'points+shapes' additionally overlays cell-boundary
  // fills from `shapes_layer` once zoomed in far enough that the viewport-culled set
  // fits. The legacy value 'shapes' is read as 'points+shapes'.
  render_mode?: 'points' | 'points+shapes' | 'shapes';
  // Cell-boundary overlay style (render_mode 'points+shapes'). 'filled' (default)
  // fills each polygon with the cell's color; 'outline' draws only the boundary
  // stroke at `boundary_line_width` screen pixels.
  boundary_style?: 'filled' | 'outline';
  boundary_line_width?: number;         // outline stroke width in pixels; defaults to 1
  point_marker?: 'circle' | 'square' | 'hexagon';  // point glyph shape; defaults to circle
  invert_x?: boolean;                   // mirror the plot horizontally; defaults off
  invert_y?: boolean;                   // mirror the plot vertically; defaults off
  background?: 'light' | 'dark';        // per-plot backdrop, independent of the app theme; defaults to dark
}

export interface Viewport {
  target: number[];
  zoom: number;
  rotationX?: number;      // embedding_canvas, 3D mode only
  rotationOrbit?: number;  // embedding_canvas, 3D mode only
}

export interface EmbeddingEncoding {
  legend_scale?: number;   // see DisplayEncoding.legend_scale
  lock_view?: boolean;     // see DisplayEncoding.lock_view
  obsm_key: string;
  x_component: number;
  y_component: number;
  z_component: number;  // used only when is_3d
  is_3d: boolean;
  color_by: string | null;
  point_size: number;
  opacity: number;
  colormap: string;
  legend_visible?: boolean;
  legend_title?: string;
  // Per-category color overrides for a categorical color-by, keyed by color_by path
  // then category level -> `#rrggbb`. Same shape/semantics as on DisplayEncoding.
  category_colors?: Record<string, Record<string, string>>;
}

export interface SpatialDisplaySpec {
  id: string;
  type: 'spatial_canvas';
  encoding: DisplayEncoding;
  viewport: Viewport | null;
}

export interface EmbeddingDisplaySpec {
  id: string;
  type: 'embedding_canvas';
  encoding: EmbeddingEncoding;
  viewport: Viewport | null;
}

export type DisplaySpec = SpatialDisplaySpec | EmbeddingDisplaySpec;

export function isSpatialDisplay(d: DisplaySpec): d is SpatialDisplaySpec {
  return d.type === 'spatial_canvas';
}

export function isEmbeddingDisplay(d: DisplaySpec): d is EmbeddingDisplaySpec {
  return d.type === 'embedding_canvas';
}

export interface ImageLevel {
  level: number;
  width: number;
  height: number;
}

export interface ImageInfo {
  element: string;
  height: number;
  width: number;
  channels: number;
  channel_names: string[];
  bounds: [number, number, number, number];
  // Affine [a,b,c,d,e,f] mapping level-0 pixel (px,py) -> world (spot space):
  // world_x = a*px + b*py + c, world_y = d*px + e*py + f. Encodes any rotation
  // or axis-swap from image alignment (e.g. an aligned H&E).
  pixel_to_world: [number, number, number, number, number, number];
  levels: ImageLevel[];
  tile_size: number;
  // Client-side (Viv) GPU compositing fields. When client_compositing is true the
  // live canvas reads the element's Zarr store directly at
  // raster_base_url/zarr_group_path and composites channels on the GPU; false
  // keeps the server-composited PNG/WebP tile path.
  client_compositing?: boolean;
  raster_base_url?: string;   // "/api/sessions/{sid}/raster/{element}" (no trailing slash)
  zarr_group_path?: string;   // "images/{element}"
  contrast_limits?: [number, number][];  // per channel default [min,max], order matches channel_names
  contrast_range?: [number, number][];   // per channel [min,max] data range — the domain for contrast sliders
  is_rgb?: boolean;           // true-color 3-channel image shown as-is, not tinted
}
