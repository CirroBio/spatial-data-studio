// Cells picked on a canvas: the lasso rings and the shape being drawn, and which cells
// they hold, as the canvas reports them. One per opened dataset; tasks read it, and a
// task that draws on the canvas arms it.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { selectionShapeRing, type RegionDrawHost, type SelectionShape, type SelectionTool } from '@cirrobio/spatial-viewer';

export interface Selection {
  polygons: [number, number][][];
  ring: [number, number][];
  shape: SelectionShape | null;
  tool: SelectionTool;
  cells: number[] | null;
  // While armed the canvas takes clicks and drags as drawing rather than panning.
  armed: boolean;
}

const EMPTY: Selection = { polygons: [], ring: [], shape: null, tool: 'lasso', cells: null, armed: false };

type Actions = Pick<RegionDrawHost, 'setDrawShape' | 'addDrawVertex' | 'clearDraw' | 'setRegionCellCount' | 'setRegionCellIndices'>;

interface Entry { state: Selection; listeners: Set<() => void>; actions: Actions; host: RegionDrawHost | null }
const entries = new Map<string, Entry>();

// The canvas runs effects keyed on these functions (it clears the drawing when they
// change), so they are made once per dataset: a new `clearDraw` on every change would
// clear, notify, re-render and clear again without end.
function actionsFor(key: string): Actions {
  return {
    setDrawShape: (shape) => set(key, { shape }),
    addDrawVertex: (pt) => set(key, { ring: [...entry(key).state.ring, pt] }),
    clearDraw: () => {
      const s = entry(key).state;
      if (s.polygons.length || s.ring.length || s.shape) set(key, { polygons: [], ring: [], shape: null });
    },
    // The count follows from the indices, which the canvas always reports for a store
    // read in the browser.
    setRegionCellCount: () => undefined,
    setRegionCellIndices: (cells) => {
      const current = entry(key).state.cells;
      if (current === cells || (current && cells && current.length === cells.length && current.every((c, i) => c === cells[i]))) return;
      set(key, { cells });
    },
  };
}

function entry(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = { state: EMPTY, listeners: new Set(), actions: actionsFor(key), host: null };
    entries.set(key, e);
  }
  return e;
}

function set(key: string, patch: Partial<Selection>) {
  const e = entry(key);
  e.state = { ...e.state, ...patch };
  e.host = null;
  e.listeners.forEach((l) => l());
}

export function useSelection(key: string): Selection {
  const e = entry(key);
  const subscribe = useCallback((l: () => void) => {
    e.listeners.add(l);
    return () => e.listeners.delete(l);
  }, [e]);
  return useSyncExternalStore(subscribe, () => e.state);
}

/** The canvas's side of the selection; the same object until the selection changes. */
export function regionHost(key: string): RegionDrawHost {
  const e = entry(key);
  if (!e.host) {
    const s = e.state;
    e.host = { drawPolygons: s.polygons, drawRing: s.ring, selectionTool: s.tool, drawShape: s.shape, ...e.actions };
  }
  return e.host;
}

/** Bank the ring or shape being drawn, so the next drag starts another. */
export function commitShape(key: string) {
  const s = entry(key).state;
  const polygons = [...s.polygons];
  if (s.shape) polygons.push(selectionShapeRing(s.shape));
  if (s.ring.length >= 3) polygons.push(s.ring);
  set(key, { polygons, ring: s.ring.length >= 3 ? [] : s.ring, shape: null });
}

/** Arms the canvas for drawing while `on` and the calling task is open. */
export function useArmedSelection(key: string, on: boolean) {
  useEffect(() => {
    set(key, { armed: on });
    return () => set(key, { armed: false });
  }, [key, on]);
}

export const setTool = (key: string, tool: SelectionTool) => set(key, tool === 'lasso' ? { tool } : { tool, shape: null });
export const clearSelection = (key: string) => set(key, { polygons: [], ring: [], shape: null, cells: null });
