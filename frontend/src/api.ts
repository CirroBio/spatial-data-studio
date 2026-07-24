// Type-only: the apache-arrow runtime (a large dep) is dynamically imported in
// the two functions that decode Arrow IPC below, so it stays out of the initial
// bundle and loads with the canvas that needs it.
import type { Table } from 'apache-arrow';
import type {
  FunctionEntry,
  SessionSummary,
  SessionState,
  DisplaySpec,
  ImageInfo,
  UiFieldInfo,
  HashCheck,
} from './types';
import type { Snapshot, SnapshotFormat } from './lib/snapshots';
import type { ShapeAnnotation } from './schemas/annotations';

// Carries the HTTP status so callers can distinguish a transient 503 (a read
// endpoint refusing while a compute/plot job holds the session write lock) from a
// real failure, and retry the former quietly.
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// A read endpoint fast-fails with 503 while a job holds the session write lock
// (backend: _read_locked / READ_LOCK_TIMEOUT_S) — most notably during the async
// checkpoint load that runs as a session's first job, which 503s every canvas read
// (coords, colors, image info, raster chunks) until it frees the lock. Retry with
// backoff so state converges once the lock frees, without surfacing a transient
// "busy" error. Non-503 errors propagate immediately. `signal` stops the retry loop
// promptly when the caller aborts (superseded fetch / unmount).
export async function fetchWhenIdle<T>(
  fn: () => Promise<T>,
  { tries = 6, delayMs = 2000, signal }: { tries?: number; delayMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      return await fn();
    } catch (err) {
      if (attempt < tries && err instanceof ApiError && err.status === 503 && !signal?.aborted) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
        });
        continue;
      }
      throw err;
    }
  }
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, `API ${path}: ${res.status} ${text}`);
  }
  return res;
}

export async function getFunctions(): Promise<{ functions: FunctionEntry[]; library_versions: Record<string, string> }> {
  const res = await apiFetch('/api/functions');
  return res.json() as Promise<{ functions: FunctionEntry[]; library_versions: Record<string, string> }>;
}

// 503s until the backend has finished building its function registry.
export async function getReadyz(): Promise<{ status: string; functions: number }> {
  const res = await apiFetch('/api/readyz');
  return res.json() as Promise<{ status: string; functions: number }>;
}

export async function getSessions(): Promise<{ sessions: SessionSummary[] }> {
  const res = await apiFetch('/api/sessions');
  return res.json() as Promise<{ sessions: SessionSummary[] }>;
}

// Polling fallback for the SSE stream (useSSE) when a fronting proxy rejects
// text/event-stream. Returns the same events off the backend ring; `after` is the
// last id the client processed (omit to establish a baseline without replay).
export interface PolledEvent {
  id: number;
  event: string;
  data: unknown;
}
export async function pollEvents(after?: number): Promise<{ last_id: number; events: PolledEvent[] }> {
  const q = after === undefined ? '' : `?after=${after}`;
  const res = await apiFetch(`/api/events/poll${q}`);
  return res.json() as Promise<{ last_id: number; events: PolledEvent[] }>;
}

export type NewSessionSource =
  | { kind: 'load'; path: string }
  | { kind: 'read'; namespace: string; function: string; params: Record<string, unknown> };

export async function createSession(
  params: { name?: string; source: NewSessionSource; load_id?: string },
): Promise<SessionSummary & { hash_check: HashCheck | null }> {
  const res = await apiFetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json() as Promise<SessionSummary & { hash_check: HashCheck | null }>;
}

export interface FsEntry {
  name: string;
  path: string;
  kind: 'dir' | 'dataset' | 'file';
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export interface DatasetEntry {
  name: string;
  path: string;
  mtime: number;  // file modification time (epoch seconds); saved-session save time
}

// All loadable datasets found by scanning folders under the server's data roots.
export async function getDatasets(): Promise<{ datasets: DatasetEntry[] }> {
  const res = await apiFetch('/api/fs/datasets');
  return res.json() as Promise<{ datasets: DatasetEntry[] }>;
}

export async function browsePath(path?: string, includeFiles = false): Promise<FsListing> {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (includeFiles) params.set('include_files', 'true');
  const q = params.toString();
  const res = await apiFetch(`/api/fs/browse${q ? `?${q}` : ''}`);
  return res.json() as Promise<FsListing>;
}

export async function subsetSession(
  id: string,
  body: { polygons?: number[][][]; cell_indices?: number[]; coordinate_system?: string; name?: string; invert?: boolean }
): Promise<{ job_id: string }> {
  const res = await apiFetch(`/api/sessions/${id}/subset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ job_id: string }>;
}

// The framing + output settings a snapshot render takes. Styling (colors, contrast,
// channels) is read server-side from the display's persisted encoding.
export interface SnapshotRenderSpec {
  viewport: { target: number[]; zoom: number };
  width_px: number;
  height_px: number;
  dpi: number;
  formats: SnapshotFormat[];
  label?: string;
  display_id?: string;
}

// Render and save a high-quality figure snapshot (vector PDF and/or raster PNG).
export async function saveSnapshot(
  sessionId: string, spec: SnapshotRenderSpec,
): Promise<{ name: string; formats: SnapshotFormat[]; rasterized_points: boolean }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/snapshot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  });
  return res.json() as Promise<{ name: string; formats: SnapshotFormat[]; rasterized_points: boolean }>;
}

// A low-cost PNG preview of the framing for the export modal. Returns a Blob so the
// caller can hand it straight to an object URL. `signal` supersedes a stale request.
export async function snapshotPreview(
  sessionId: string, spec: SnapshotRenderSpec, signal?: AbortSignal,
): Promise<Blob> {
  const res = await apiFetch(`/api/sessions/${sessionId}/snapshot/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec), signal,
  });
  return res.blob();
}

export async function getSnapshots(): Promise<{ snapshots: Snapshot[] }> {
  const res = await apiFetch('/api/snapshots');
  return res.json() as Promise<{ snapshots: Snapshot[] }>;
}

export async function deleteSnapshot(name: string): Promise<void> {
  await apiFetch(`/api/snapshots/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export function snapshotFileUrl(name: string, fmt: SnapshotFormat): string {
  return `/api/snapshots/${encodeURIComponent(name)}/file?fmt=${fmt}`;
}

export function snapshotThumbnailUrl(name: string): string {
  return `/api/snapshots/${encodeURIComponent(name)}/thumbnail`;
}

export async function getObsValues(
  id: string,
  column: string
): Promise<{ column: string; values: { value: string; count: number }[] }> {
  const res = await apiFetch(`/api/sessions/${id}/obs/${encodeURIComponent(column)}/values`);
  return res.json() as Promise<{ column: string; values: { value: string; count: number }[] }>;
}

export async function getSession(id: string): Promise<SessionState> {
  const res = await apiFetch(`/api/sessions/${id}`);
  return res.json() as Promise<SessionState>;
}

export async function deleteSession(id: string): Promise<void> {
  await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });
}

export async function deleteHistoryEntry(sessionId: string, entryId: string): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}/history/${entryId}`, { method: 'DELETE' });
}

export async function submitJob(
  sessionId: string,
  params: { namespace: string; function: string; params: Record<string, unknown> }
): Promise<{ job_id: string; status: string }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json() as Promise<{ job_id: string; status: string }>;
}

export async function getJobLog(sessionId: string, jobId: string): Promise<{ log: string; status: string }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/jobs/${jobId}/log`);
  return res.json() as Promise<{ log: string; status: string }>;
}

// Cancels a still-queued job; rejects if it's already running (non-interruptible) or finished.
export async function cancelJob(sessionId: string, jobId: string): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}/jobs/${jobId}`, { method: 'DELETE' });
}

export async function redrawPlot(sessionId: string, plotId: string): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}/plots/${plotId}/redraw`, { method: 'POST' });
}

export function getFigureUrl(sessionId: string, plotId: string, fmt: 'svg' | 'pdf' = 'svg'): string {
  return `/api/sessions/${sessionId}/plots/${plotId}/figure?fmt=${fmt}`;
}

export async function putDisplay(sessionId: string, display: DisplaySpec): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}/displays/${display.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(display),
  });
}

export async function addDisplay(sessionId: string, spec: Omit<DisplaySpec, 'id'>): Promise<DisplaySpec> {
  const res = await apiFetch(`/api/sessions/${sessionId}/displays`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  });
  return res.json() as Promise<DisplaySpec>;
}

export async function getImageInfo(sessionId: string, element: string): Promise<ImageInfo> {
  const res = await apiFetch(`/api/sessions/${sessionId}/image/${element}/info`);
  return res.json() as Promise<ImageInfo>;
}

// Server-rendered thumbnail of an image element, used by DataInspector's element
// preview (the canvas itself composites client-side via Viv, not this endpoint).
export function getImageThumbnailUrl(sessionId: string, element: string, channels?: string): string {
  const q = channels !== undefined ? `?channels=${channels}` : '';
  return `/api/sessions/${sessionId}/image/${element}/thumbnail${q}`;
}

export async function searchVarNames(
  sessionId: string,
  query: string,
  limit = 50
): Promise<string[]> {
  const q = `?q=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await apiFetch(`/api/sessions/${sessionId}/var-names${q}`);
  const body = (await res.json()) as { names: string[] };
  return body.names;
}

export async function getFieldData(sessionId: string, fieldPath: string): Promise<Table> {
  const res = await apiFetch(`/api/sessions/${sessionId}/data/${encodeURIComponent(fieldPath)}`);
  const buffer = await res.arrayBuffer();
  const { tableFromIPC } = await import('apache-arrow');
  return tableFromIPC(buffer);
}

// ---- cell-segmentation display ----------------------------------------------
// Viewport-bbox cell polygons as a GeoArrow Arrow-IPC table (geometry column +
// int32 cell_index). bbox is [minx, miny, maxx, maxy] in the coords world space.
// Returns an empty table when the viewport holds more than `limit` cells (the
// zoomed-in gate for the Points + Shapes overlay).
export async function getShapesGeoArrow(
  sessionId: string,
  element: string,
  bbox: [number, number, number, number],
  limit?: number,
): Promise<Table> {
  const q = limit !== undefined ? `&limit=${limit}` : '';
  const res = await apiFetch(
    `/api/sessions/${sessionId}/shapes/${encodeURIComponent(element)}/geoarrow?bbox=${bbox.join(',')}${q}`,
  );
  const buffer = await res.arrayBuffer();
  const { tableFromIPC } = await import('apache-arrow');
  return tableFromIPC(buffer);
}

// ---- data inspector ---------------------------------------------------------
export interface ElementInventory {
  tables: { name: string; n_obs: number; n_vars: number; active: boolean }[];
  shapes: { name: string; count: number; geometry: string[]; columns: string[] }[];
  points: { name: string; columns: string[] }[];
  images: { name: string }[];
  labels: { name: string }[];
}

export async function getElements(sessionId: string): Promise<ElementInventory> {
  const res = await apiFetch(`/api/sessions/${sessionId}/elements`);
  return res.json() as Promise<ElementInventory>;
}

export type TableCell = string | number | boolean | null;

export interface TablePreview {
  path: string;
  total_rows: number;
  offset: number;
  limit: number;
  index_name: string;
  index: string[];
  columns: { name: string; dtype: string }[];
  rows: TableCell[][];
}

export async function getTablePreview(
  sessionId: string,
  path: string,
  offset: number,
  limit: number
): Promise<TablePreview> {
  const q = `?path=${encodeURIComponent(path)}&offset=${offset}&limit=${limit}`;
  const res = await apiFetch(`/api/sessions/${sessionId}/table${q}`);
  return res.json() as Promise<TablePreview>;
}

// A recipe-level parameter declaration — same shape as a function's ParamSpec,
// with the default carried in schema.default.
export interface RecipeParam {
  name: string;
  schema: Record<string, unknown>;
  widget: string;
  bound_to: string | null;
  required: boolean;
  tooltip: string;
}

export interface BundledRecipe {
  name: string;
  description: string;
  steps: { namespace: string; function: string; params: Record<string, unknown> }[];
  params: RecipeParam[];
  // Derived from `params` so the gallery can render the same FunctionForm the picker uses.
  json_schema: Record<string, unknown>;
  ui_schema: Record<string, UiFieldInfo>;
}

export async function getBundledRecipes(): Promise<{ recipes: BundledRecipe[] }> {
  const res = await apiFetch('/api/recipes');
  return res.json() as Promise<{ recipes: BundledRecipe[] }>;
}

export interface RecipePreflight {
  produced: string[];
  unresolved: { step: string; param: string; ref: string; widget: string }[];
  unknown_functions: string[];
}

// Validate a recipe against the installed registry before running it: which
// functions are missing, and which referenced keys no earlier step produces.
// `params` + `param_values` are resolved server-side first, so referenced-key
// checks reflect the chosen values.
export async function preflightRecipe(
  sessionId: string,
  recipe: {
    steps: BundledRecipe['steps'];
    params?: RecipeParam[];
    param_values?: Record<string, unknown>;
  },
): Promise<RecipePreflight> {
  const res = await apiFetch(`/api/sessions/${sessionId}/recipe/preflight`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(recipe),
  });
  return res.json() as Promise<RecipePreflight>;
}

// ---- staged (PENDING) steps -------------------------------------------------
// Staged steps live in compute_history/plots with status "pending": visible and
// editable, but not submitted until run individually or via run-all.
export async function runPendingStep(sessionId: string, stepId: string): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}/pending/${stepId}/run`, { method: 'POST' });
}

export async function runAllPending(sessionId: string): Promise<{ queued: number }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/pending/run-all`, { method: 'POST' });
  return res.json() as Promise<{ queued: number }>;
}

export async function editPendingStep(
  sessionId: string,
  stepId: string,
  params: Record<string, unknown>,
): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}/pending/${stepId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params }),
  });
}

export async function getRecipe(sessionId: string): Promise<unknown> {
  const res = await apiFetch(`/api/sessions/${sessionId}/recipe`);
  return res.json();
}

export async function importRecipe(
  sessionId: string,
  recipe: unknown,
  mode: 'run' | 'stage' = 'run'
): Promise<unknown> {
  const body = { ...(recipe as Record<string, unknown>), mode };
  const res = await apiFetch(`/api/sessions/${sessionId}/recipe/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export interface ThirdPartyLicense {
  name: string;
  version: string;
  license: string;
}

export async function getThirdPartyLicenses(): Promise<{ python: ThirdPartyLicense[]; npm: ThirdPartyLicense[] }> {
  const res = await apiFetch('/api/about/licenses');
  return res.json() as Promise<{ python: ThirdPartyLicense[]; npm: ThirdPartyLicense[] }>;
}

// ---- Cirro upload -----------------------------------------------------------
export interface CirroStatus { enabled: boolean }
export interface CirroProject { id: string; name: string }

export interface CirroUploads { uploading: number; pending: number }

export async function getCirroStatus(): Promise<CirroStatus> {
  const res = await apiFetch('/api/cirro/status');
  return res.json() as Promise<CirroStatus>;
}

export async function getCirroUploads(): Promise<CirroUploads> {
  const res = await apiFetch('/api/cirro/uploads');
  return res.json() as Promise<CirroUploads>;
}

export async function getCirroProjects(): Promise<{ projects: CirroProject[] }> {
  const res = await apiFetch('/api/cirro/projects');
  return res.json() as Promise<{ projects: CirroProject[] }>;
}

export async function getCirroFolders(projectId: string): Promise<{ folders: string[] }> {
  const res = await apiFetch(`/api/cirro/projects/${projectId}/folders`);
  return res.json() as Promise<{ folders: string[] }>;
}

export async function uploadToCirro(
  body: { project_id: string; dataset_name: string; session_paths: string[]; snapshot_names: string[]; folder?: string }
): Promise<{ status: string }> {
  const res = await apiFetch('/api/cirro/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ status: string }>;
}

export async function getPointsTransform(
  sessionId: string,
): Promise<{ affine: number[]; element: string | null }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/points-transform`);
  return res.json() as Promise<{ affine: number[]; element: string | null }>;
}

export async function setPointsTransform(
  sessionId: string,
  affine: number[],
): Promise<{ job_id: string }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/points-transform`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ affine }),
  });
  return res.json() as Promise<{ job_id: string }>;
}

export async function saveSession(sessionId: string, path?: string): Promise<{ job_id: string }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(path ? { path } : {}),
  });
  return res.json() as Promise<{ job_id: string }>;
}

export async function annotateSession(
  id: string,
  body: {
    polygons?: number[][][];
    cell_indices?: number[];  // embedding-view selection (in place of a spatial lasso)
    region_set: string;
    category: string;
    color?: string;
  }
): Promise<{ job_id: string }> {
  const res = await apiFetch(`/api/sessions/${id}/annotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ job_id: string }>;
}

export async function listShapeAnnotations(sessionId: string): Promise<{ shapes: ShapeAnnotation[] }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/shape-annotations`);
  return res.json() as Promise<{ shapes: ShapeAnnotation[] }>;
}

export async function createShapeAnnotation(
  sessionId: string,
  shape: Omit<ShapeAnnotation, 'id'> & { id?: string }
): Promise<{ job_id: string }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/shape-annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(shape),
  });
  return res.json() as Promise<{ job_id: string }>;
}

export async function updateShapeAnnotation(
  sessionId: string,
  shapeId: string,
  shape: Omit<ShapeAnnotation, 'id'>
): Promise<{ job_id: string }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/shape-annotations/${shapeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(shape),
  });
  return res.json() as Promise<{ job_id: string }>;
}

export async function deleteShapeAnnotation(sessionId: string, shapeId: string): Promise<{ job_id: string }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/shape-annotations/${shapeId}`, { method: 'DELETE' });
  return res.json() as Promise<{ job_id: string }>;
}
