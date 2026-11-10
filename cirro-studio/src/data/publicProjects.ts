// Public projects: projects anyone can read, each with its own ID and name. One is a
// Cirro publication, or a folder of checkpoints listed by its index.json. Which ones the
// app lists is the visitor's own choice, kept in this browser: it starts with this app's
// publication, and Settings adds or drops any of them.
import { useSyncExternalStore } from 'react';
import { storeName } from '@cirrobio/spatial-viewer';
import { appKey } from '../app/appInfo';

// This app's own publication (Cirro-publish-data-objects, SPEC.md "Publication layout").
export const DEFAULT_PUBLIC_PROJECT = 'https://published.cirrodata.io/published/spatial-data-studio';

const STORAGE_KEY = appKey('public-projects');
// A saved list names the default as this, not by its address, so a move of the default
// (a new bucket) reaches every browser's list with nothing to rewrite.
const DEFAULT_ENTRY = 'default';
// A publication's root is an https address; plain http only for one on this machine.
const ROOT_URL = /^(https:\/\/[^/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/[^?#]*)?$/;

export interface PublicProjectInfo {
  // A store opened by its address alone is a project of that one store.
  kind: 'publication' | 'index' | 'store';
  url: string;
  id: string;
  name: string;
  description: string;
}

export type PublicProjectEntry = { url: string; isDefault: boolean } & (
  | { status: 'loading' }
  | { status: 'ready'; project: PublicProjectInfo }
  | { status: 'error'; error: string }
);

/** A public project's root as typed or pasted: its catalog.json or index.json, or a
 * trailing slash, is dropped. */
export function publicationRoot(text: string): string {
  const url = text.trim().replace(/\/(catalog|index)\.json$/i, '').replace(/\/+$/, '');
  if (!ROOT_URL.test(url)) throw new Error('A public project is the https address of a Cirro publication, or of a folder with an index.json.');
  return url;
}

// A folder or a store has no ID of its own: its address stands for one, hashed short (FNV-1a).
function addressId(prefix: string, url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) h = Math.imul(h ^ url.charCodeAt(i), 0x01000193);
  return `${prefix}-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

// The one dataset a store opened by its address is listed as.
const OPENED_DATASET = 'store';

export interface OpenedStoreProject {
  project: PublicProjectInfo;
  datasetId: string;
  // The store's file name, which is the dataset's one path.
  path: string;
}

/** A store opened by its address alone, as a read-only project of that one store. The
 * address may carry a query (a presigned URL's signature); the project is known by the
 * address without it, so a link signed afresh finds the versions saved on it here. */
export function openedStoreProject(address: string): OpenedStoreProject {
  const url = URL.canParse(address) ? new URL(address) : null;
  const bare = url && `${url.origin}${url.pathname}`;
  if (!url || !bare || !ROOT_URL.test(bare) || !/\.zarr\.zip$/i.test(url.pathname)) {
    throw new Error('The link should name the https address of a .zarr.zip file, URL-encoded, after open=.');
  }
  const file = url.pathname.split('/').pop()!;
  let path = file;
  try {
    path = decodeURIComponent(file);
  } catch {
    // A stray % that encodes nothing: the name as written.
  }
  // storeName decodes, so it is given the segment as written; `path` is decoded already.
  return {
    project: { kind: 'store', url: url.href, id: addressId('store', bare), name: storeName(file), description: '' },
    datasetId: OPENED_DATASET,
    path,
  };
}

function readUrls(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (Array.isArray(saved) && saved.every((u) => typeof u === 'string')) {
      return saved.map((u) => (u === DEFAULT_ENTRY ? DEFAULT_PUBLIC_PROJECT : u));
    }
  } catch {
    // Storage refused or held something else: start from the default list.
  }
  return [DEFAULT_PUBLIC_PROJECT];
}

// Each publication's project, read once per page.
const described = new Map<string, Promise<PublicProjectInfo>>();

function describe(url: string): Promise<PublicProjectInfo> {
  let pending = described.get(url);
  if (!pending) {
    pending = (async (): Promise<PublicProjectInfo> => {
      const { createPublicationDataSource } = await import('../cirro/cirro-publication');
      try {
        const [project] = await createPublicationDataSource({ baseUrl: url }).dataService.projects.getProjects();
        return { kind: 'publication', url, id: project.id, name: project.name, description: project.description ?? '' };
      } catch (notPublication) {
        const { readIndex } = await import('./indexFolder');
        const index = await readIndex(url).catch((e: unknown) => {
          // Why each failed is for whoever runs the host; the person adding it gets the gist.
          console.warn(`Not a public project at ${url}:`, notPublication, e);
          throw new Error('Nothing at that address could be read as a public project: no Cirro publication, and no folder with an index.json.');
        });
        return { kind: 'index', url, id: addressId('index', url), name: index.name ?? url.split('/').pop()!, description: index.description };
      }
    })();
    described.set(url, pending);
  }
  return pending;
}

let urls = readUrls();
const results = new Map<string, { project: PublicProjectInfo } | { error: string }>();
const resolving = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: PublicProjectEntry[] = [];

function publish() {
  snapshot = urls.map((url): PublicProjectEntry => {
    const isDefault = url === DEFAULT_PUBLIC_PROJECT;
    const r = results.get(url);
    if (!r) return { url, isDefault, status: 'loading' };
    return 'project' in r ? { url, isDefault, status: 'ready', project: r.project } : { url, isDefault, status: 'error', error: r.error };
  });
  listeners.forEach((l) => l());
}

// A project that failed to answer is read afresh the next time it is listed.
function resolve(url: string) {
  if (results.has(url) || resolving.has(url)) return;
  resolving.add(url);
  describe(url).then(
    (project) => results.set(url, { project }),
    (e: unknown) => {
      described.delete(url);
      results.set(url, { error: e instanceof Error ? e.message : String(e) });
    },
  ).finally(() => {
    resolving.delete(url);
    publish();
  });
}

function save(next: string[]) {
  urls = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(urls.map((u) => (u === DEFAULT_PUBLIC_PROJECT ? DEFAULT_ENTRY : u))));
  urls.forEach(resolve);
  publish();
}

publish();

// Each publication is read once something first asks for the list.
export function subscribePublicProjects(listener: () => void) {
  listeners.add(listener);
  urls.forEach(resolve);
  return () => void listeners.delete(listener);
}

/** The public projects this browser lists, each loading, ready or unreachable. */
export const publicProjectsSnapshot = () => snapshot;

export const usePublicProjects = () => useSyncExternalStore(subscribePublicProjects, publicProjectsSnapshot);

/** Add a publication by its root's address, once it reads as one; resolves to its project. */
export async function addPublicProject(text: string): Promise<PublicProjectInfo> {
  const url = publicationRoot(text);
  if (urls.includes(url)) throw new Error('That public project is already in the list.');
  let project: PublicProjectInfo;
  try {
    project = await describe(url);
  } catch (e) {
    described.delete(url);
    throw e;
  }
  // Listed while it was being read (restored, or added twice at once).
  if (urls.includes(url)) throw new Error('That public project is already in the list.');
  const same = snapshot.find((p) => p.status === 'ready' && p.project.id === project.id);
  if (same) throw new Error(`That is the same public project as ${same.url}.`);
  results.set(url, { project });
  save([...urls, url]);
  return project;
}

export function removePublicProject(url: string) {
  results.delete(url);
  save(urls.filter((u) => u !== url));
}

export function restoreDefaultPublicProject() {
  if (!urls.includes(DEFAULT_PUBLIC_PROJECT)) save([DEFAULT_PUBLIC_PROJECT, ...urls]);
}
