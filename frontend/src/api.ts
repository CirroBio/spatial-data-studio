import * as arrow from 'apache-arrow';
import type {
  FunctionEntry,
  SessionSummary,
  SessionState,
  DisplaySpec,
  ImageInfo,
} from './types';

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
  body: { polygons: number[][][]; coordinate_system?: string; save_parent?: boolean; name?: string }
): Promise<{ job_id: string }> {
  const res = await apiFetch(`/api/sessions/${id}/subset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ job_id: string }>;
}

export async function saveSnapshot(sessionId: string, label?: string): Promise<{ name: string; url: string }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/snapshot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(label ? { label } : {}),
  });
  return res.json() as Promise<{ name: string; url: string }>;
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

// ---- AI chat (v3 Parts 5-8) -------------------------------------------------
export interface AiStatus { enabled: boolean; provider: string; model: string | null }

export async function getAiStatus(): Promise<AiStatus> {
  const res = await apiFetch('/api/ai/status');
  return res.json() as Promise<AiStatus>;
}

export async function sendChat(sessionId: string, message: string): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

export async function approveCall(
  sessionId: string,
  body: { call_id: string; action: 'approve' | 'edit' | 'deny'; params?: unknown; reason?: string }
): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}/chat/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function setChatAutoMode(sessionId: string, auto: boolean): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}/chat/auto-mode`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auto }),
  });
}

export async function getChat(
  sessionId: string
): Promise<{ transcript: { role: string; text: string }[]; auto_mode: boolean; context: string[] }> {
  const res = await apiFetch(`/api/sessions/${sessionId}/chat`);
  return res.json() as Promise<{ transcript: { role: string; text: string }[]; auto_mode: boolean; context: string[] }>;
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

export async function postDisplay(sessionId: string, display: Omit<DisplaySpec, 'id'>): Promise<DisplaySpec> {
  const res = await apiFetch(`/api/sessions/${sessionId}/displays`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(display),
  });
  return res.json() as Promise<DisplaySpec>;
}

export async function getImageInfo(sessionId: string, element: string): Promise<ImageInfo> {
  const res = await apiFetch(`/api/sessions/${sessionId}/image/${element}/info`);
  return res.json() as Promise<ImageInfo>;
}

export function getImageThumbnailUrl(sessionId: string, element: string): string {
  return `/api/sessions/${sessionId}/image/${element}/thumbnail`;
}

export async function getFieldData(sessionId: string, fieldPath: string): Promise<arrow.Table> {
  const res = await apiFetch(`/api/sessions/${sessionId}/data/${encodeURIComponent(fieldPath)}`);
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

export interface BundledRecipe {
  name: string;
  description: string;
  steps: { namespace: string; function: string; params: Record<string, unknown> }[];
}

export async function getBundledRecipes(): Promise<{ recipes: BundledRecipe[] }> {
  const res = await apiFetch('/api/recipes');
  return res.json() as Promise<{ recipes: BundledRecipe[] }>;
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
