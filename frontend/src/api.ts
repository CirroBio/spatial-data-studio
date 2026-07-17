import * as arrow from 'apache-arrow';
import type {
  FunctionEntry,
  SessionSummary,
  SessionState,
  DisplaySpec,
  ImageInfo,
  UiFieldInfo,
} from './types';
import type { Snapshot } from './lib/snapshots';

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${path}: ${res.status} ${text}`);
  }
  return res;
}

export async function getFunctions(): Promise<{ functions: FunctionEntry[]; squidpy_version: string }> {
  const res = await apiFetch('/api/functions');
  return res.json() as Promise<{ functions: FunctionEntry[]; squidpy_version: string }>;
}

// 503s until the backend has finished building its squidpy function registry.
export async function getReadyz(): Promise<{ status: string; functions: number }> {
  const res = await apiFetch('/api/readyz');
  return res.json() as Promise<{ status: string; functions: number }>;
}

export async function getSessions(): Promise<{ sessions: SessionSummary[] }> {
  const res = await apiFetch('/api/sessions');
  return res.json() as Promise<{ sessions: SessionSummary[] }>;
}

export type NewSessionSource =
  | { kind: 'load'; path: string }
  | { kind: 'read'; namespace: string; function: string; params: Record<string, unknown> };

export async function createSession(params: { name?: string; source: NewSessionSource }): Promise<SessionSummary> {
  const res = await apiFetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json() as Promise<SessionSummary>;
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
  body: { polygons: number[][][]; coordinate_system?: string; name?: string }
): Promise<{ job_id: string }> {
  const res = await apiFetch(`/api/sessions/${id}/subset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ job_id: string }>;
}

export async function saveSnapshot(
  sessionId: string,
  opts?: { label?: string; viewport?: { target: number[]; zoom: number }; display_id?: string }
): Promise<{ name: string; url: string }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/snapshot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts ?? {}),
  });
  return res.json() as Promise<{ name: string; url: string }>;
}

export async function getSnapshots(): Promise<{ snapshots: Snapshot[] }> {
  const res = await apiFetch('/api/snapshots');
  return res.json() as Promise<{ snapshots: Snapshot[] }>;
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

export function getImageThumbnailUrl(sessionId: string, element: string, channels?: string): string {
  const q = channels !== undefined ? `?channels=${channels}` : '';
  return `/api/sessions/${sessionId}/image/${element}/thumbnail${q}`;
}

export function getImageTileUrl(
  sessionId: string, element: string, level: number, col: number, row: number, channels: string,
): string {
  return `/api/sessions/${sessionId}/image/${element}/tile/${level}/${col}/${row}?channels=${channels}`;
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

export async function getFieldData(sessionId: string, fieldPath: string): Promise<arrow.Table> {
  const res = await apiFetch(`/api/sessions/${sessionId}/data/${encodeURIComponent(fieldPath)}`);
  const buffer = await res.arrayBuffer();
  return arrow.tableFromIPC(buffer);
}

// ---- cell-segmentation display ----------------------------------------------
export interface CellFieldMeta {
  median_nn_world: number;
  n_cells: number;
  bounds: [number, number, number, number];  // [minx, miny, maxx, maxy]
}

// R (median nearest-neighbor distance, world units) + bounds for a coords field;
// drives the field disc radius and the field<->polygon zoom threshold.
export async function getCellField(sessionId: string, coords: string): Promise<CellFieldMeta> {
  const res = await apiFetch(`/api/sessions/${sessionId}/cell-field?coords=${encodeURIComponent(coords)}`);
  return res.json() as Promise<CellFieldMeta>;
}

// Viewport-bbox cell polygons as a GeoArrow Arrow-IPC table (geometry column +
// int32 cell_index). bbox is [minx, miny, maxx, maxy] in the coords world space.
export async function getShapesGeoArrow(
  sessionId: string,
  element: string,
  bbox: [number, number, number, number],
  limit?: number,
): Promise<arrow.Table> {
  const q = limit !== undefined ? `&limit=${limit}` : '';
  const res = await apiFetch(
    `/api/sessions/${sessionId}/shapes/${encodeURIComponent(element)}/geoarrow?bbox=${bbox.join(',')}${q}`,
  );
  const buffer = await res.arrayBuffer();
  return arrow.tableFromIPC(buffer);
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
    polygons: number[][][];
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

export async function promoteObsColumn(
  id: string,
  obs_column: string
): Promise<{ job_id: string }> {
  const res = await apiFetch(`/api/sessions/${id}/regions/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ obs_column }),
  });
  return res.json() as Promise<{ job_id: string }>;
}
