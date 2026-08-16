// Type-only: the apache-arrow runtime (a large dep) is dynamically imported in
// the two functions that decode Arrow IPC below, so it stays out of the initial
// bundle and loads with the canvas that needs it.
import type { Table } from 'apache-arrow';
import {
  ApiError,
  type DisplaySpec,
  type ElementInventory,
  type ImageInfo,
  type ShapeAnnotation,
  type Snapshot,
  type SnapshotFormat,
} from '@cirrobio/spatial-viewer';
import type {
  FunctionEntry,
  SessionSummary,
  SessionState,
  UiFieldInfo,
  HashCheck,
  PresenceView,
} from './types';
import { CLIENT_ID } from './lib/presence';

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  // Every request identifies this browser so the backend can tell the session's lock
  // holder from anyone else (backend deps.bind_client_id).
  const res = await fetch(path, {
    ...init,
    headers: { ...init?.headers, 'X-SDS-Client-Id': CLIENT_ID },
  });
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

// ---- viewer presence + session lock -----------------------------------------
// Heartbeat: says who we are and which session we're looking at, and returns the
// whole presence view (also broadcast as `presence.updated`). Attaching to an
// unlocked session takes its lock, so a lone viewer is protected without clicking.
export async function postPresence(
  sessionId: string | null,
  name: string,
  keepalive = false,
): Promise<PresenceView> {
  const res = await apiFetch('/api/presence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, name, session_id: sessionId }),
    keepalive,
  });
  return res.json() as Promise<PresenceView>;
}

// Take an unlocked session's edit lock (409 while someone else holds it).
export async function takeSessionLock(sessionId: string): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}/lock`, { method: 'POST' });
}

// Release the lock we hold so another viewer can take it (403 if we don't hold it).
export async function releaseSessionLock(sessionId: string): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}/lock`, { method: 'DELETE' });
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
  include_minimap?: boolean;  // draw the overview inset in the figure (spatial only)
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
// preview and the canvas minimap (the canvas itself composites client-side via Viv,
// not this endpoint). `channels` is `index:rrggbb` pairs; only listed channels show.
export function getImageThumbnailUrl(
  sessionId: string, element: string, channels?: string, maxPx?: number,
): string {
  const params = new URLSearchParams();
  if (channels !== undefined) params.set('channels', channels);
  if (maxPx !== undefined) params.set('max_px', String(maxPx));
  const q = params.size ? `?${params}` : '';
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
/** The five element facets of a SpatialData object, as keyed by `ElementInventory`
 * and by the save body's `include`. */
export type SdataFacet = keyof ElementInventory;

/** `ElementInventory` with the per-element checkpoint size estimate the save dialog
 * needs (`?sizes=1`). Declared here rather than on the library's `ElementInventory`:
 * the canvas has no use for a size, so widening a published type for one Studio
 * dialog would be the wrong direction. `null` means "not estimable" — see
 * `store.element_size_mb`. */
export type SizedElements = {
  [F in SdataFacet]: (ElementInventory[F][number] & { size_mb: number | null })[];
};

export async function getElements(sessionId: string): Promise<ElementInventory>;
export async function getElements(sessionId: string, opts: { sizes: true }): Promise<SizedElements>;
export async function getElements(
  sessionId: string, opts?: { sizes?: boolean },
): Promise<ElementInventory | SizedElements> {
  const query = opts?.sizes ? '?sizes=1' : '';
  const res = await apiFetch(`/api/sessions/${sessionId}/elements${query}`);
  return res.json() as Promise<ElementInventory | SizedElements>;
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
// Each browser logs into Cirro with its own identity (OAuth device code). The
// backend mints an unguessable token naming that credential; it is sent on every
// Cirro call below. Deliberately not CLIENT_ID, which is a plain (non-secret)
// localStorage value used for presence — anyone who learned it could otherwise
// upload as that user. Kept in localStorage so a reload stays connected.
const CIRRO_TOKEN_KEY = 'sds.cirro.token';

export function cirroToken(): string | null {
  return localStorage.getItem(CIRRO_TOKEN_KEY);
}

function setCirroToken(token: string | null) {
  if (token) localStorage.setItem(CIRRO_TOKEN_KEY, token);
  else localStorage.removeItem(CIRRO_TOKEN_KEY);
}

function cirroFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = cirroToken();
  return apiFetch(path, token
    ? { ...init, headers: { ...init?.headers, 'X-SDS-Cirro-Token': token } }
    : init);
}

export type CirroAuthState = 'disconnected' | 'pending' | 'connected' | 'failed';

export interface CirroAuth {
  state: CirroAuthState;
  domain: string | null;
  username: string | null;
  /** Present only while `state` is 'pending' — the URL the user opens to log in. */
  login_url: string | null;
  error: string | null;
  /** Prefill for the connect dialog's domain field (backend CIRRO_BASE_URL). */
  default_domain: string;
  /** Whether a built SPA is on disk to bundle into uploads (false in local dev). */
  viewer_bundled: boolean;
}

export interface CirroProject { id: string; name: string }

export interface CirroUpload {
  id: number;
  dataset_name: string;
  state: 'pending' | 'uploading' | 'completed' | 'failed';
  error: string | null;
}

export interface CirroUploads { uploads: CirroUpload[] }

export async function getCirroAuth(): Promise<CirroAuth> {
  const res = await cirroFetch('/api/cirro/auth');
  return res.json() as Promise<CirroAuth>;
}

/** Start a device-code login. Resolves as soon as Cirro issues the login URL; the
 *  state flips to 'connected' once the user finishes in their browser. */
export async function connectToCirro(domain: string): Promise<CirroAuth> {
  // Carries the current token, if any, so the backend replaces this browser's
  // credential instead of orphaning it when a login is retried.
  const res = await cirroFetch('/api/cirro/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain }),
  });
  const body = await res.json() as CirroAuth & { token: string };
  setCirroToken(body.token);
  return body;
}

export async function disconnectFromCirro(): Promise<void> {
  try {
    await cirroFetch('/api/cirro/auth', { method: 'DELETE' });
  } finally {
    setCirroToken(null);
  }
}

// Upload rows are scoped to the credential that started them — they name a Cirro
// project and dataset, so they are not served to every browser sharing the app.
export async function getCirroUploads(): Promise<CirroUploads> {
  const res = await cirroFetch('/api/cirro/uploads');
  return res.json() as Promise<CirroUploads>;
}

export async function dismissCirroUpload(id: number): Promise<CirroUploads> {
  const res = await cirroFetch(`/api/cirro/uploads/${id}`, { method: 'DELETE' });
  return res.json() as Promise<CirroUploads>;
}

export async function getCirroProjects(): Promise<{ projects: CirroProject[] }> {
  const res = await cirroFetch('/api/cirro/projects');
  return res.json() as Promise<{ projects: CirroProject[] }>;
}

export async function getCirroFolders(projectId: string): Promise<{ folders: string[] }> {
  const res = await cirroFetch(`/api/cirro/projects/${projectId}/folders`);
  return res.json() as Promise<{ folders: string[] }>;
}

export async function uploadToCirro(
  body: { project_id: string; dataset_name: string; description: string; session_paths: string[]; folder?: string }
): Promise<{ status: string; id: number }> {
  const res = await cirroFetch('/api/cirro/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ status: string; id: number }>;
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

/** `include` writes only the named elements: a facet left out keeps that facet whole,
 * a facet present keeps exactly the names listed, so `{ images: [] }` drops every
 * image. Omit it for the ordinary whole-object save. */
export async function saveSession(
  sessionId: string, path?: string, include?: Partial<Record<SdataFacet, string[]>>,
): Promise<{ job_id: string }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(path ? { path } : {}), ...(include ? { include } : {}) }),
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
