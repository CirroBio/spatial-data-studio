// types.ts — all domain types for Spatial Data Studio

export type EffectClass = 'compute' | 'plot' | 'read' | 'extract';

export type UiWidget =
  | 'checkbox'
  | 'number'
  | 'text'
  | 'select'
  | 'multitext'
  | 'obs_key'
  | 'obs_categorical'
  | 'var_names'
  | 'layer_key'
  | 'obsm_key'
  | 'obsp_key'
  | 'library_id'
  | 'obs_value_map'
  | 'json';

// Per-field UI hints from the backend registry (CONTRACT.md): the widget to
// render, the dataset facet a picker binds to, and a docstring-derived tooltip.
export interface UiFieldInfo {
  widget: UiWidget;
  bound_to: string | null;
  tooltip: string;
}

export interface FunctionEntry {
  key: string;
  namespace: string;
  function: string;
  effect_class: EffectClass;
  summary: string;
  doc: string;
  label: string | null;       // human title for custom functions; null for library
  source: string;             // 'custom' or the library name (squidpy | scanpy | spatialdata_io)
  citation: string;           // reference for the method / library
  documentation: string;      // URL to the method's docs (library page or custom README section)
  json_schema: Record<string, unknown>;
  ui_schema: Record<string, UiFieldInfo>;
  partially_supported: boolean;
  // For `read` functions: whether the import picker accepts a folder, a file, or
  // either as the input path. null/undefined for non-readers.
  input_kind?: 'folder' | 'file' | 'either' | null;
}

export interface SessionSummary {
  id: string;
  name: string;
  status: 'ready' | 'errored' | 'loading';
  resident_mb: number;
  parent_id: string | null;
  created_at: string;
  saved: boolean;  // in-memory state matches the saved checkpoint (drives the unsaved-changes dot)
}

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

export interface HistEntry {
  id: string;
  namespace: string;
  function: string;
  params: Record<string, unknown>;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  library_versions: Record<string, string>;
  started_at: string | null;
  finished_at: string | null;
  structural_diff?: Record<string, string[]>;
}

export interface PlotEntry {
  id: string;
  namespace: string;
  function: string;
  params: Record<string, unknown>;
  status: 'pending' | 'queued' | 'running' | 'drawn' | 'invalidated' | 'failed';
  references: string[];
}

export interface ChannelState {
  visible: boolean;
  name: string;
  color?: string;
}

export interface DisplayEncoding {
  coords: string;
  color_by: string;
  image_layer: string | null;
  shapes_layer: string | null;
  point_size: number;
  opacity: number;
  colormap: string;
  channels?: Record<string, ChannelState>;  // per-channel on/off + rename (v3 Part 10)
  legend_visible?: boolean;  // cell-color legend (colorbar / category swatches); defaults on
  legend_title?: string;     // overrides the default title (color_by column, sans "obs:")
  show_points?: boolean;     // cells-layer visibility; defaults on
  show_image?: boolean;      // image-layer visibility; defaults to (image_layer != null)
  show_channel_legend?: boolean;  // image channel legend visibility; defaults on
  isolated_category?: string | null;  // isolate one category in the color-by legend (dims the rest)
  // How the Cells layer renders. Points always draw (styled by `point_size` +
  // `point_marker`, overlaps merged not blended), visible at every zoom. 'points'
  // (default) is points only; 'points+shapes' additionally overlays cell-boundary
  // fills from `shapes_layer` once zoomed in far enough that the viewport-culled set
  // fits. The legacy value 'shapes' is read as 'points+shapes'.
  render_mode?: 'points' | 'points+shapes' | 'shapes';
  point_marker?: 'circle' | 'square' | 'hexagon';  // point glyph shape; defaults to circle
  invert_x?: boolean;                   // mirror the plot horizontally; defaults off
  invert_y?: boolean;                   // mirror the plot vertically; defaults off
  background?: 'light' | 'dark';        // per-plot backdrop; unset follows the app theme
}

export interface Viewport {
  target: number[];
  zoom: number;
  rotationX?: number;      // embedding_canvas, 3D mode only
  rotationOrbit?: number;  // embedding_canvas, 3D mode only
}

export interface EmbeddingEncoding {
  obsm_key: string;
  x_component: number;
  y_component: number;
  z_component: number;  // used only when is_3d
  is_3d: boolean;
  color_by: string;
  point_size: number;
  opacity: number;
  colormap: string;
  legend_visible?: boolean;
  legend_title?: string;
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

export interface RegionCategory {
  label: string;
  color: string;
  n_cells: number;
}

export interface RegionSet {
  id: string;
  name: string;
  obs_column: string;
  categories: RegionCategory[];
}

export interface AppState {
  schema_version: number;
  compute_history: HistEntry[];
  plots: PlotEntry[];
  displays: DisplaySpec[];
  regions?: RegionSet[];
}

export interface QueueEntry {
  job_id: string;
  descriptor: Record<string, unknown>;
  status: string;
  position: number;
}

export interface SessionState {
  summary: SessionSummary;
  app_state: AppState;
  queue: QueueEntry[];
  fields: SessionFields;
  data_versions: Record<string, number>;
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
  // Client-side (Viv) GPU compositing fields — present only on the live
  // /image/{element}/info endpoint, never on a snapshot's embedded render.image
  // (hence optional here, where ImageInfo is shared with SnapshotRender). When
  // client_compositing is true the live canvas reads the element's Zarr store
  // directly at raster_base_url/zarr_group_path and composites channels on the GPU;
  // false keeps the server-composited PNG tile path.
  client_compositing?: boolean;
  raster_base_url?: string;   // "/api/sessions/{sid}/raster/{element}" (no trailing slash)
  zarr_group_path?: string;   // "images/{element}"
  contrast_limits?: [number, number][];  // per channel, order matches channel_names
  is_rgb?: boolean;           // true-color 3-channel image shown as-is, not tinted
}

// ---- Snapshots (read-only checkpoint views; see CONTRACT.md) ---------------
// A snapshot is a JSON config pointing at an immutable checkpoint .zarr.zip that
// the browser reads directly via zarrita. SnapshotViewer renders render.* against
// the shared canvas layers.
export interface SnapshotChannel {
  visible: boolean;
  color: string;           // "#rrggbb"
  contrast_limit: number;  // upper bound; JS clips value/limit to [0,1]
}

export interface SnapshotRender {
  coords: string;                             // "obsm:<key>"
  coords_transform?: number[];                // 6-float points->global affine applied to obsm:spatial
  color_by: string;                           // "obs:x" | "X:GENE" | "layers:l/gene" | ""
  image: ImageInfo | null;                    // the element's ImageInfo; null for embeddings / no image
  channels: Record<string, SnapshotChannel>;  // per-channel color/contrast, keyed by channel index string
  point_size: number;
  opacity: number;
  invert_x?: boolean;             // spatial view: mirror horizontally (schema >= 1.1.0; absent on older snapshots)
  invert_y?: boolean;             // spatial view: mirror vertically (schema >= 1.1.0)
  background?: 'light' | 'dark';  // per-plot backdrop (schema >= 1.1.0; defaults dark when absent)
}

export interface SnapshotConfig {
  schema_version: string;                     // semver, matches snapshot-viewer.json version
  kind: 'spatial' | 'embedding';
  label: string;
  created: string;
  data: string;                               // path to the .zarr.zip, relative to this config's URL
  checkpoint: { name: string };
  table: string;
  viewport: { target: number[]; zoom: number; rotationX?: number; rotationOrbit?: number };
  encoding: DisplayEncoding | EmbeddingEncoding;
  render: SnapshotRender;
}

// SSE event payloads

export interface JobQueuedEvent {
  session_id: string;
  job_id: string;
  descriptor: Record<string, unknown>;
  position: number;
  effect_class?: 'compute' | 'plot';  // absent for special (save/subset/…) jobs
}

export interface JobStartedEvent {
  session_id: string;
  job_id: string;
}

export interface JobCompletedEvent {
  session_id: string;
  job_id: string;
  kind: 'compute' | 'plot' | 'save' | 'subset' | 'annotate' | 'shape_annotate' | 'set_transform';
  structural_diff?: Record<string, string[]>;
  data_versions: Record<string, number>;
  plot_id?: string;
  child_id?: string;  // subset jobs: the new child session to switch to
}

export interface JobFailedEvent {
  session_id: string;
  job_id: string;
  kind: string;
  error: string;
  source?: string;
  timestamp?: string;
}

// A chunk of a running reader's log, streamed live so the import UI shows progress
// instead of a frozen spinner. Appended to the per-job live-log buffer.
export interface JobLogEvent {
  session_id: string;
  job_id: string;
  chunk: string;
}

export interface PlotDrawnEvent {
  session_id: string;
  plot_id: string;
}

export interface PlotInvalidatedEvent {
  session_id: string;
  plot_ids: string[];
}

export interface DisplayUpdatedEvent {
  session_id: string;
  display_id: string;
  spec: DisplaySpec;
}

export interface SessionCreatedEvent {
  session_id: string;
  summary: SessionSummary;
}

export interface SessionRemovedEvent {
  session_id: string;
  reason: 'closed' | 'subset';
}

// Result of verifying a hash-named checkpoint's content hash on load.
export interface HashCheck {
  ok: boolean;
  message: string;
}

// Progress from an asynchronous checkpoint load (Session._run_load), routed by the
// client-minted `load_id`. A milestone event carries `message` (+ `pct` for the
// byte-fraction extraction step); a live-log event carries `log` (a reader log chunk to
// append) with `message`/`pct` null; the single terminal event carries `done: true`
// with `status` and, on success, the `hash_check` (else `error`).
export interface SessionLoadingEvent {
  load_id: string;
  message: string | null;
  pct: number | null;
  log?: string | null;
  done?: boolean;
  status?: 'ready' | 'errored';
  hash_check?: HashCheck | null;
  error?: string;
}

export interface ResourceSample {
  global: {
    rss_mb: number;
    rss_pct: number;
    cpu_pct: number;
    rasters_mb: number;
  };
  per_session: Record<string, number>;
}

export interface MemoryWarningEvent {
  session_id?: string;
  message: string;
}
