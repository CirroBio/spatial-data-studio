// types.ts — the app's own domain types: the function registry, sessions, jobs, the
// edit lock and the SSE payloads. The display model the canvas renders from
// (DisplaySpec, SessionFields, ImageInfo and friends) belongs to
// `@cirrobio/spatial-viewer` and is imported from there.
import type { DisplaySpec, FigureIndex, SessionFields } from '@cirrobio/spatial-viewer';

export type EffectClass = 'compute' | 'plot' | 'read' | 'extract';

/** What the main pane shows: the spatial canvas, the embedding scatter, the gallery of
 * saved plot figures, or the data-table inspector (backend only). */
export type MainView = 'canvas' | 'embedding' | 'plots' | 'tables';

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
  // Reader path params render a filesystem picker instead of the plain widget:
  // 'folder' | 'file' | 'either'. For a relative-file param, `bound_to` names the
  // primary-path param the picker roots against. null/absent for value params.
  path_kind?: 'folder' | 'file' | 'either' | null;
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
  read_only: boolean;  // session opened frozen (create_from_load read_only); every mutating route 403s
  error: string | null;  // failure message when status === 'errored'; null otherwise
}

// Live viewer presence + edit lock for one session (backend sessions/presence.py).
// `viewers` holds every attached viewer's display name (the holder included).
export interface SessionLock {
  client_id: string;
  name: string;
}

export interface SessionPresence {
  lock: SessionLock | null;
  viewers: string[];
}

// POST /api/presence response and the `presence.updated` SSE payload. Sessions with
// no viewers and no lock are omitted, so a missing entry means unlocked + unwatched.
export interface PresenceView {
  sessions: Record<string, SessionPresence>;
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
  // Which plots have a rendered figure to show, and how big each one is: the Plots view
  // and the save dialog's figures group read it. A `drawn` plot missing from it can
  // only be redrawn (a checkpoint saved without figures).
  figures: FigureIndex;
  data_versions: Record<string, number>;
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
    rss_mb: number;       // anonymous memory: API process + compute workers when containerized
    work_dir_mb: number;  // RAM-backed working set (0 unless WORK_DIR is tmpfs)
    rss_pct: number;      // effective memory (rss_mb + work_dir_mb) as % of the limit
    cpu_pct: number;      // summed across the API process + compute workers; 100% == one core
    cpu_count: number;    // cores the container may use (the cpu_pct denominator)
    rasters_mb: number;
  };
  per_session: Record<string, number>;
}

export interface MemoryWarningEvent {
  session_id?: string;
  message: string;
}
