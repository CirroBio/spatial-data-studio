// How an opened dataset is being looked at: the spatial and embedding display specs the
// canvases draw, kept per dataset for the life of the page. Camera moves are kept out
// of React (they arrive every frame); every other edit re-renders the page.
import { useCallback, useSyncExternalStore } from 'react';
import {
  boundarySets, isEmbeddingDisplay, isSpatialDisplay, type CheckpointHandle, type DisplaySpec, type EmbeddingDisplaySpec,
  type EmbeddingEncoding, type SpatialDisplaySpec, type Viewport,
} from '@cirrobio/spatial-viewer';
import { readObs } from '../tasks/data';

export interface Displays {
  spatial: SpatialDisplaySpec | null;
  embedding: EmbeddingDisplaySpec | null;
}

interface Entry {
  displays: Displays;
  viewports: Record<string, Viewport | null>;
  listeners: Set<() => void>;
}

const entries = new Map<string, Entry>();

// The tissue and the cell map color their cells one way: a color chosen on either is the
// color on the other, and the one Composition counts.
type CellColor = Pick<EmbeddingEncoding, 'color_by' | 'colormap' | 'legend_title' | 'category_colors'>;
const cellColor = ({ color_by, colormap, legend_title, category_colors }: CellColor): CellColor =>
  ({ color_by, colormap, legend_title, category_colors });

function shareColor(d: Displays, from: keyof Displays): Displays {
  if (from === 'spatial') {
    return d.spatial && d.embedding ? { ...d, embedding: { ...d.embedding, encoding: { ...d.embedding.encoding, ...cellColor(d.spatial.encoding) } } } : d;
  }
  return d.spatial && d.embedding ? { ...d, spatial: { ...d.spatial, encoding: { ...d.spatial.encoding, ...cellColor(d.embedding.encoding) } } } : d;
}

function fromHandle(handle: CheckpointHandle): Displays {
  const displays = (handle.appState.displays ?? []) as DisplaySpec[];
  const spatial = displays.find(isSpatialDisplay) ?? null;
  const embedding = displays.find(isEmbeddingDisplay) ?? null;
  return shareColor({
    spatial: spatial && {
      ...spatial, viewport: null,
      encoding: { ...spatial.encoding, background: spatial.encoding.background ?? 'light' },
    },
    embedding: embedding && { ...embedding, viewport: null },
  }, 'spatial');
}

// A color with one group shows nothing. Stores saved by tools that color by the first
// grouping they find often name one like that (`region`, which every cell shares), so
// the store opens colored by its first grouping with a useful number of groups instead.
// A store with no such grouping opens with its cells as outlines where it has a boundary
// set: dots all one color would only cover the image under them.
const GROUPS = { min: 2, max: 50 };

async function chooseCellLook(key: string, handle: CheckpointHandle) {
  const groups = async (column: string) => {
    const values = await readObs(handle, column);
    return values.kind === 'categorical' ? values.categories.length : null;
  };
  const current = entries.get(key)?.displays.spatial?.encoding.color_by;
  if (current === undefined) return;
  // A gene, a layer or a numeric column was chosen on purpose.
  if (current && !current.startsWith('obs:')) return;
  const currentGroups = current ? await groups(current.slice('obs:'.length)) : 0;
  if (currentGroups === null || currentGroups >= GROUPS.min) return;
  // Unless the color was changed while the columns were read.
  const unchanged = () => entries.get(key)?.displays.spatial?.encoding.color_by === current;
  for (const field of handle.fields.obs.filter((f) => f.kind === 'categorical')) {
    const n = await groups(field.name);
    if (n !== null && n >= GROUPS.min && n <= GROUPS.max) {
      if (unchanged()) updateEncoding(key, 'spatial', { color_by: `obs:${field.name}` });
      return;
    }
  }
  const elements = await handle.source.getElements?.();
  if (elements && boundarySets(elements).length > 0 && unchanged()) {
    updateEncoding(key, 'spatial', { render_mode: 'points+shapes', boundary_style: 'outline' });
  }
}

/** Behind the tissue, unless the store's display names a backdrop: light behind a
 * brightfield (RGB) image or none, dark behind fluorescence, whose channels add light to
 * black and wash out on white. */
function chooseBackdrop(key: string, handle: CheckpointHandle) {
  const display = ((handle.appState.displays ?? []) as DisplaySpec[]).find(isSpatialDisplay);
  const image = display?.encoding.image_layer;
  if (!image || display.encoding.background) return;
  handle.source.getImageInfo(image).then(
    (info) => { if (!info.is_rgb) updateEncoding(key, 'spatial', { background: 'dark' }); },
    // An image that can't be read keeps the light backdrop; the canvas reports it.
    () => undefined,
  );
}

function entryFor(key: string, handle: CheckpointHandle | null): Entry | null {
  let e = entries.get(key);
  if (!e && handle) {
    e = { displays: fromHandle(handle), viewports: {}, listeners: new Set() };
    entries.set(key, e);
    chooseBackdrop(key, handle);
    // A column that can't be read keeps the store's color; the canvas reports it.
    chooseCellLook(key, handle).catch(() => undefined);
  }
  return e ?? null;
}

const NONE: Displays = { spatial: null, embedding: null };

export function useDisplays(key: string, handle: CheckpointHandle | null): Displays {
  const e = entryFor(key, handle);
  const subscribe = useCallback((l: () => void) => {
    if (!e) return () => undefined;
    e.listeners.add(l);
    return () => e.listeners.delete(l);
  }, [e]);
  return useSyncExternalStore(subscribe, () => e?.displays ?? NONE);
}

/** A display edit from the canvas or the page. Camera-only edits are remembered without
 * a re-render, so the next encoding edit keeps the camera where the user left it. */
export function setDisplay(key: string, next: DisplaySpec) {
  const e = entries.get(key);
  if (!e) return;
  const slot = isSpatialDisplay(next) ? 'spatial' : 'embedding';
  const current = e.displays[slot];
  e.viewports[slot] = next.viewport;
  if (current && JSON.stringify(current.encoding) === JSON.stringify(next.encoding)) return;
  e.displays = shareColor({ ...e.displays, [slot]: { ...next } }, slot);
  e.listeners.forEach((l) => l());
}

/** The freshest spec, camera included. */
export function currentDisplay<T extends DisplaySpec>(key: string, display: T): T {
  const e = entries.get(key);
  if (!e) return display;
  const slot = isSpatialDisplay(display) ? 'spatial' : 'embedding';
  const latest = (e.displays[slot] ?? display) as T;
  return { ...latest, viewport: e.viewports[slot] ?? latest.viewport };
}

/** Patch the spatial (or embedding) encoding, e.g. to color by another field. */
export function updateEncoding(key: string, slot: keyof Displays, patch: Record<string, unknown>) {
  const e = entries.get(key);
  const current = e?.displays[slot];
  if (!e || !current) return;
  e.displays = shareColor({ ...e.displays, [slot]: { ...current, encoding: { ...current.encoding, ...patch } } }, slot);
  e.listeners.forEach((l) => l());
}

/** Show a display exactly as saved (a figure), camera included. */
export function showDisplay(key: string, display: DisplaySpec) {
  const e = entries.get(key);
  if (!e) return;
  const slot = isSpatialDisplay(display) ? 'spatial' : 'embedding';
  // A copy: the canvas moves to each viewport object once, and it may already have moved
  // to this one before the user panned away.
  const viewport = display.viewport && { ...display.viewport };
  e.viewports[slot] = viewport;
  e.displays = shareColor({ ...e.displays, [slot]: { ...display, viewport } }, slot);
  e.listeners.forEach((l) => l());
}

/** A version just saved opens looking as its parent did. */
export function carryDisplays(fromKey: string, toKey: string) {
  const e = entries.get(fromKey);
  if (!e) return;
  entries.set(toKey, { displays: e.displays, viewports: { ...e.viewports }, listeners: new Set() });
}

// World units per screen pixel of each dataset's spatial canvas, as the canvas reports it:
// what the scale bars, on the canvas and in a figure, are measured from.
const worldPerPixel = new Map<string, number>();
const scaleListeners = new Set<() => void>();
export function setWorldPerPixel(key: string, value: number) {
  worldPerPixel.set(key, value);
  scaleListeners.forEach((l) => l());
}
export const worldPerPixelOf = (key: string) => worldPerPixel.get(key) ?? null;
const subscribeScale = (l: () => void) => {
  scaleListeners.add(l);
  return () => scaleListeners.delete(l);
};
export const useWorldPerPixel = (key: string) => useSyncExternalStore(subscribeScale, () => worldPerPixelOf(key));

// The element each dataset's tissue is drawn in while a lens shows it: what a figure's
// download captures. Only the tissue registers, since the figure's scale bar, legend and
// caption describe the tissue, not the cell map.
const tissueCanvases = new Map<string, HTMLElement>();
export function setTissueCanvas(key: string, el: HTMLElement | null) {
  if (el) tissueCanvases.set(key, el);
  else tissueCanvases.delete(key);
}
export const tissueCanvasOf = (key: string) => tissueCanvases.get(key) ?? null;
