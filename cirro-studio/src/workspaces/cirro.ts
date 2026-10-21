// Workspaces running the full Spatial Data Studio (this repo's Docker image) on a
// project's datasets: Cirro's environment for it, how the picked datasets are mounted,
// and Cirro's lifecycle around them. The Cirro app kit's docs/workspaces.md describes the
// lifecycle; Expression Studio's src/cirro/workspaces.ts follows the same pattern.
import { EntityType, SharingType, type MountedDataset, type Workspace, type WorkspaceComputeConfig, type WorkspaceEnvironment, type WorkspaceInput } from '@cirrobio/api-client';
import { APP_ID, APP_NAME } from '../app/appInfo';
import { addProvenanceNote } from '../cirro/provenance';
import { isApiError, type CirroSession } from '../cirro/session';
import type { WorkspaceRequest } from './request';

// Cirro's environment for the Studio. Cirro's own environments keep their IDs across
// tenants; the name is the fallback.
const STUDIO_ENVIRONMENT = { id: 'cirro-spatial-data-studio', name: 'Cirro/spatial-data-studio' };
// Workspaces carry no tags, so the app finds its own by this name prefix, and leaves a
// provenance note on each.
const WORKSPACE_PREFIX = `${APP_ID} / `;
export const AUTO_STOP_HOURS = 2;
// Where a mounted dataset appears in the Studio's dataset picker: the workspace mounts
// each under $HOME/datasets/<mount name>, and $HOME is the Studio's data folder.
export const MOUNT_FOLDER = 'datasets';
// Which folder holds which dataset, as JSON {datasetId: mount name}, so the Studio can
// open a saved version through the versions and the store beneath it (backend/app/config.py
// reads it; persistence/store.py opens a version through it).
export const DATASETS_VAR = 'SDS_CIRRO_DATASETS';
// Machine sizes offered, as multiples of the environment's default CPU and memory.
export const SIZES = [
  { id: 'standard', label: 'Standard', scale: 1 },
  { id: 'large', label: 'Large', scale: 2 },
  { id: 'xlarge', label: 'Extra large', scale: 4 },
] as const;
const DELETE_WAIT_MS = 600_000;
const DELETE_POLL_MS = 10_000;

// Cirro's statuses, read as plain strings. A stopped workspace reports COMPLETED or
// SUSPENDED, and can be started again, as can a FAILED one.
const BOOTING = new Set(['PENDING', 'STARTING', 'QUEUED']);
const STOPPED = new Set(['COMPLETED', 'SUSPENDED', 'FAILED', 'STOPPED']);
const DELETING = new Set(['DELETE', 'DELETING', 'DELETED']);
const statusOf = (w: Workspace): string => w.status;
export const isRunning = (w: Workspace) => statusOf(w) === 'RUNNING';
export const isBooting = (w: Workspace) => BOOTING.has(statusOf(w));
export const isStopping = (w: Workspace) => statusOf(w) === 'STOPPING';
export const isStopped = (w: Workspace) => STOPPED.has(statusOf(w));
export const isBeingDeleted = (w: Workspace) => DELETING.has(statusOf(w));
export const isOurs = (w: Workspace) => w.name.startsWith(WORKSPACE_PREFIX);
/** What the app calls one of its workspaces: its name without the app's prefix. */
export const labelOf = (w: Workspace) => (isOurs(w) ? w.name.slice(WORKSPACE_PREFIX.length) : w.name);

export function statusText(w: Workspace): string {
  if (isRunning(w)) {
    return w.autoStopTime ? `Running · stops at ${w.autoStopTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Running';
  }
  if (isBooting(w)) return 'Starting';
  if (isStopping(w)) return 'Stopping';
  if (isBeingDeleted(w)) return 'Deleting';
  return statusOf(w) === 'FAILED' ? 'Couldn\'t start' : 'Stopped';
}

/** The tenant's Spatial Data Studio environment, or null where Cirro doesn't offer it. */
export async function studioEnvironment(cirro: CirroSession): Promise<WorkspaceEnvironment | null> {
  const all = await cirro.data.workspaces.getWorkspaceEnvironments();
  return all.find((e) => e.id === STUDIO_ENVIRONMENT.id) ?? all.find((e) => e.name === STUDIO_ENVIRONMENT.name) ?? null;
}

export const listWorkspaces = (cirro: CirroSession, projectId: string) => cirro.data.workspaces.getWorkspaces({ projectId });

// Cirro accepts letters, digits, spaces and . & - @ ! # ' ( ) / in a workspace name.
export function workspaceName(labels: string[]): string {
  const what = labels.length > 1 ? `${labels[0]} and ${labels.length - 1} more` : labels[0];
  return (WORKSPACE_PREFIX + what.replace(/[^A-Za-z0-9 .&\-@!#'()/]+/g, '-')).slice(0, 120);
}

/** A folder name for each dataset: its name made safe in a path (no leading dot, which
 * would hide it), unique among the mounts. */
export function mountsFor(datasetIds: string[], nameOf: (datasetId: string) => string): MountedDataset[] {
  const used = new Set<string>();
  return datasetIds.map((datasetId) => {
    const base = nameOf(datasetId).replace(/[^\w.-]+/g, '_').replace(/^[_.]+|_+$/g, '').slice(0, 60) || datasetId;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    return { name, datasetId };
  });
}

export function computeFor(env: WorkspaceEnvironment, scale: number, mounts: MountedDataset[]): WorkspaceComputeConfig {
  const base = env.defaultComputeConfig;
  return {
    ...base,
    cpu: base.cpu && base.cpu * scale,
    memoryGiB: base.memoryGiB && base.memoryGiB * scale,
    environmentVariables: {
      ...base.environmentVariables,
      [DATASETS_VAR]: JSON.stringify(Object.fromEntries(mounts.map((m) => [m.datasetId, m.name]))),
    },
  };
}

function workspaceInput(env: WorkspaceEnvironment, requests: WorkspaceRequest[], nameOf: (datasetId: string) => string, scale: number): WorkspaceInput {
  const mounts = mountsFor([...new Set(requests.flatMap((r) => r.datasetIds))], nameOf);
  const labels = requests.map((r) => r.label);
  return {
    name: workspaceName(labels),
    description: `Started from ${APP_NAME} to open ${labels.join(', ')}.`,
    mountedDatasets: mounts,
    environmentId: env.id,
    computeConfig: computeFor(env, scale, mounts),
    sharingType: SharingType.Private,
    autoStopTimeout: AUTO_STOP_HOURS,
  };
}

/** Creates the workspace, which Cirro starts by itself; `noteProblem` says why its
 * provenance note is missing. */
export async function createStudioWorkspace(
  cirro: CirroSession, projectId: string, env: WorkspaceEnvironment, requests: WorkspaceRequest[],
  nameOf: (datasetId: string) => string, scale: number,
): Promise<{ id: string; noteProblem: string | null }> {
  const input = workspaceInput(env, requests, nameOf, scale);
  const { id } = await cirro.data.workspaces.createWorkspace({ projectId, workspaceInput: input });
  const noteProblem = await addProvenanceNote(cirro, projectId, { type: EntityType.Workspace, id }, {
    what: `A Spatial Data Studio workspace opening ${requests.map((r) => r.label).join(', ')}.`,
    inputs: input.mountedDatasets.flatMap((m) => (m.datasetId ? [{ name: nameOf(m.datasetId), id: m.datasetId }] : [])),
    parameters: { environment: env.id, cpu: input.computeConfig.cpu, memoryGiB: input.computeConfig.memoryGiB, autoStopHours: AUTO_STOP_HOURS },
  });
  return { id, noteProblem };
}

/** Gives a stopped workspace new datasets and size, then starts it again. Cirro changes a
 * workspace's datasets only while it's stopped; the files in its home folder stay. */
export async function changeStudioWorkspace(
  cirro: CirroSession, projectId: string, workspace: Workspace, env: WorkspaceEnvironment, requests: WorkspaceRequest[],
  nameOf: (datasetId: string) => string, scale: number,
): Promise<void> {
  await cirro.data.workspaces.updateWorkspace({ projectId, workspaceId: workspace.id, workspaceInput: workspaceInput(env, requests, nameOf, scale) });
  await cirro.data.workspaces.startWorkspace({ projectId, workspaceId: workspace.id });
}

// Cirro refuses createWorkspace (400) at the per-user limit: "You have reached your
// workspace quota for this project (5 out of 5)". Stopped workspaces count toward it.
const LIMIT_MESSAGE = /workspace quota\b.*?\((\d+) out of (\d+)\)/i;
export function workspaceLimit(e: unknown): { used: number; limit: number } | null {
  if (!isApiError(e) || e.errorCode !== 400) return null;
  const m = LIMIT_MESSAGE.exec([e.message, ...(e.errors ?? [])].join(' '));
  return m ? { used: Number(m[1]), limit: Number(m[2]) } : null;
}

/** The user's own workspaces, which count toward their limit, most recently started first. */
export const ownWorkspaces = (all: Workspace[], username: string) =>
  all.filter((w) => w.createdBy === username).sort((a, b) => +(b.startedAt ?? b.createdAt) - +(a.startedAt ?? a.createdAt));

/** Deletes a workspace and waits until it's gone: deletion runs in the background, and the
 * workspace counts toward the limit until then. */
export async function deleteWorkspace(cirro: CirroSession, projectId: string, workspaceId: string): Promise<void> {
  await cirro.data.workspaces.deleteWorkspace({ projectId, workspaceId });
  for (const started = Date.now(); Date.now() - started < DELETE_WAIT_MS;) {
    await new Promise((r) => setTimeout(r, DELETE_POLL_MS));
    const still = (await listWorkspaces(cirro, projectId)).find((w) => w.id === workspaceId);
    if (!still || statusOf(still) === 'DELETED') return;
  }
  throw new Error('Cirro is still deleting the workspace. Try again in a few minutes.');
}

/** Opens a workspace in a new tab. The tab opens during the click, since browsers block a
 * later one, and each open asks for a new connection URL, which works once and for a few
 * minutes. Resolves to that URL when the browser blocked the tab, to offer as a link. */
export async function openWorkspace(cirro: CirroSession, projectId: string, workspaceId: string): Promise<string | null> {
  const tab = window.open('', '_blank');
  try {
    const { connectionUrl } = await cirro.data.workspaces.connectWorkspace({ projectId, workspaceId });
    if (!tab) return connectionUrl;
    tab.opener = null;
    tab.location.href = connectionUrl;
    return null;
  } catch (e) {
    tab?.close();
    throw e;
  }
}
