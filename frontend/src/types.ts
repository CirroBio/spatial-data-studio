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
  json_schema: Record<string, unknown>;
  ui_schema: Record<string, UiFieldInfo>;
  partially_supported: boolean;
}

export interface SessionSummary {
  id: string;
  name: string;
  status: 'ready' | 'errored' | 'loading';
  resident_mb: number;
  parent_id: string | null;
  created_at: string;
}

export interface ObsField {
  name: string;
  kind: 'categorical' | 'numeric';
}

export interface SessionFields {
  obs: ObsField[];
  obsm: string[];
  var_names_count: number;
  obsp: string[];
  layers: string[];
  images: string[];
  shapes: string[];
}

export interface HistEntry {
  id: string;
  namespace: string;
  function: string;
  params: Record<string, unknown>;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  squidpy_version: string;
  started_at: string | null;
  finished_at: string | null;
  structural_diff?: Record<string, string[]>;
}

export interface PlotEntry {
  id: string;
  namespace: string;
  function: string;
  params: Record<string, unknown>;
  status: 'queued' | 'running' | 'drawn' | 'invalidated' | 'failed';
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
}

export interface Viewport {
  target: [number, number];
  zoom: number;
}

export interface DisplaySpec {
  id: string;
  type: 'spatial_canvas';
  encoding: DisplayEncoding;
  viewport: Viewport | null;
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

export interface ImageInfo {
  element: string;
  height: number;
  width: number;
  channels: number;
  channel_names: string[];
  bounds: [number, number, number, number];
}

// SSE event payloads

export interface JobQueuedEvent {
  session_id: string;
  job_id: string;
  descriptor: Record<string, unknown>;
  position: number;
}

export interface JobStartedEvent {
  session_id: string;
  job_id: string;
}

export interface JobCompletedEvent {
  session_id: string;
  job_id: string;
  kind: 'compute' | 'plot' | 'save' | 'subset' | 'annotate' | 'promote';
  structural_diff?: Record<string, string[]>;
  data_versions: Record<string, number>;
  plot_id?: string;
  child_id?: string;  // subset jobs: the new child session to switch to
}

export interface JobFailedEvent {
  session_id: string;
  job_id: string;
  error: string;
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

export interface ResourceSample {
  global: {
    rss_mb: number;
    rss_pct: number;
    cpu_pct: number;
  };
  per_session: Record<string, number>;
}

export interface MemoryWarningEvent {
  session_id?: string;
  message: string;
}
