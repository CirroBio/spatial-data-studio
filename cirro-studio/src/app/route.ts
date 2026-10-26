// The URL is the app's state: shared context (tenant, project, dataset) in plain keys so
// another Cirro app can hand it over, app-specific state prefixed with the app's ID.
import { useSyncExternalStore } from 'react';
import { appKey } from './appInfo';

// home: the map of the project's stages. stage: one stage opened. item: one item (a
// store, a version, an image, a run) opened as its picture. task: a task beside it.
// add: how to add data to the project.
export const SECTIONS = ['home', 'stage', 'item', 'task', 'add'] as const;
export type Section = (typeof SECTIONS)[number];

export const STAGE_PARAM = appKey('stage');
export const ITEM_PARAM = appKey('item');
export const LENS_PARAM = appKey('lens');
export const TASK_PARAM = appKey('task');
export const GROUP_PARAM = appKey('group');
export const BY_PARAM = appKey('by');

export interface Route {
  tenant: string | null;
  project: string | null;
  dataset: string | null;
  section: Section;
  params: URLSearchParams;
}

const listeners = new Set<() => void>();
// A step back waits for its popstate; steps asked for meanwhile (a second Esc) are
// dropped, or they would go back past where the first one lands.
let stepping = false;
window.addEventListener('popstate', () => {
  stepping = false;
  listeners.forEach((l) => l());
});

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const getSearch = () => window.location.search;

function parse(search: string): Route {
  const params = new URLSearchParams(search);
  const s = params.get('section') ?? '';
  return {
    tenant: params.get('tenant'),
    project: params.get('project'),
    dataset: params.get('dataset'),
    section: (SECTIONS as readonly string[]).includes(s) ? (s as Section) : 'home',
    params,
  };
}

let cache: { search: string; route: Route } | null = null;

export function useRoute(): Route {
  const search = useSyncExternalStore(subscribe, getSearch);
  if (!cache || cache.search !== search) cache = { search, route: parse(search) };
  return cache.route;
}

function target(update: Record<string, string | null>): URL {
  const url = new URL(window.location.href);
  // A new project starts at its map: nothing opened in the old one carries over.
  if ('project' in update && update.project !== url.searchParams.get('project')) {
    for (const key of [...url.searchParams.keys()]) if (key !== 'tenant' && key !== 'project') url.searchParams.delete(key);
  }
  for (const [k, v] of Object.entries(update)) {
    if (v === null) url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  return url;
}

/** null removes a parameter. Each entry remembers the address it was pushed from. */
export function navigate(update: Record<string, string | null>, { replace = false } = {}) {
  const url = target(update);
  if (url.search === window.location.search) return;
  if (replace) window.history.replaceState(window.history.state, '', url);
  else window.history.pushState({ from: window.location.search }, '', url);
  listeners.forEach((l) => l());
}

export const hrefFor = (update: Record<string, string | null>) => target(update).toString();

const sameAddress = (a: string, b: string) => {
  const sorted = (s: string) => [...new URLSearchParams(s)].map((p) => p.join('=')).sort().join('&');
  return sorted(a) === sorted(b);
};

/** Stepping out (Esc, ×) goes back in history when the previous entry is where it leads,
 * so stepping in and out doesn't pile up entries; otherwise it navigates there. */
export function stepBack(update: Record<string, string | null>) {
  if (stepping) return;
  const from = (window.history.state as { from?: string } | null)?.from;
  if (from !== undefined && sameAddress(from, target(update).search)) {
    stepping = true;
    window.history.back();
  } else navigate(update);
}

/** Back from an item to the map where it was opened: its stage when it came from one. */
export const backToMap = (fromStage: boolean) =>
  stepBack({ section: fromStage ? 'stage' : 'home', dataset: null, [ITEM_PARAM]: null, [LENS_PARAM]: null });

/** Open an item's picture. */
export const openItem = (datasetId: string, path: string, extra: Record<string, string | null> = {}) =>
  navigate({ section: 'item', dataset: datasetId, [ITEM_PARAM]: path, [TASK_PARAM]: null, ...extra });
