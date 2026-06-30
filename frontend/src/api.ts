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

export async function createSession(params: { name?: string; source: { kind: 'load'; path: string } }): Promise<SessionSummary> {
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
  kind: 'dir' | 'dataset';
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export async function browsePath(path?: string): Promise<FsListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : '';
  const res = await apiFetch(`/api/fs/browse${q}`);
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

export async function getSession(id: string): Promise<SessionState> {
  const res = await apiFetch(`/api/sessions/${id}`);
  return res.json() as Promise<SessionState>;
}

export async function deleteSession(id: string): Promise<void> {
  await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });
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

export function getFigureUrl(sessionId: string, plotId: string): string {
  return `/api/sessions/${sessionId}/plots/${plotId}/figure?fmt=svg`;
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

export async function getRecipe(sessionId: string): Promise<unknown> {
  const res = await apiFetch(`/api/sessions/${sessionId}/recipe`);
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
    coordinate_system?: string;
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
