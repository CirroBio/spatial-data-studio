import { createContext, useCallback, useContext, type ReactNode } from 'react';
import type { DisplaySpec, SessionFields } from '../types';
import type { ShapeAnnotation, ShapeGeometry, ShapeKind } from '../schemas/annotations';
import type { SelectionShape, SelectionTool } from '../lib/selectionShapes';
import type { SnapshotExportParams } from '../lib/snapshots';

// Everything the canvases need from whatever is hosting them, in one contract.
//
// The Studio app builds it from the zustand store, the edit gate and the debounced
// display PUT (components/StudioCanvasHost.tsx); a Cirro dashboard tile will build it
// from node config and persist to the graph instead. This is the only seam between the
// canvas components and either host — nothing under components/canvas/ reaches for the
// app's store or its REST layer.

// Cell-selection drawing (region labeling / subsetting). The rings live on the host
// because the active sidebar tab's panel owns the commit / apply / clear actions; the
// canvas is purely the drawing surface, and reports which cells fall inside.
export interface RegionDrawHost {
  readonly drawPolygons: [number, number][][];
  readonly drawRing: [number, number][];
  /** What a drag on the canvas does: collect lasso vertices a click at a time, or place
   *  a geometric shape (see lib/selectionShapes). The panel owns the choice. */
  readonly selectionTool: SelectionTool;
  /** The one geometric shape in progress — the counterpart of `drawRing`, contributing
   *  its ring to the selection until the panel's Finish action banks it. */
  readonly drawShape: SelectionShape | null;
  readonly setDrawShape: (shape: SelectionShape | null) => void;
  readonly addDrawVertex: (pt: [number, number]) => void;
  readonly clearDraw: () => void;
  readonly setRegionCellCount: (n: number) => void;
  readonly setRegionCellIndices: (idx: number[] | null) => void;
}

// The shape-annotation editor (arrows/lines/boxes/polygons/ellipses). The fetched list
// renders regardless of the active tab; the tool/selection/draft members only matter
// while the canvas is in 'shapes' mode.
export interface ShapeAnnotationHost {
  readonly shapeAnnotations: ShapeAnnotation[];
  readonly activeShapeTool: ShapeKind | null;
  readonly selectedShapeId: string | null;
  readonly draftVertices: [number, number][];
  readonly setSelectedShapeId: (id: string | null) => void;
  readonly addDraftVertex: (pt: [number, number]) => void;
  readonly clearDraft: () => void;
  readonly upsertShapeAnnotation: (shape: ShapeAnnotation) => void;
  readonly sendShapeUpdate: (shapeId: string) => void;
  readonly commitNewShape: (geometry: ShapeGeometry) => void;
}

// Save Snapshot lives outside the canvas (the settings panel), so the mounted canvas
// registers a handler that captures its live framing when the action fires.
export interface SnapshotHost {
  readonly openSnapshotExport: (params: SnapshotExportParams) => void;
  readonly setSnapshotHandler: (fn: (() => void) | null) => void;
}

export interface CanvasHost {
  /** Label used for snapshot filenames (today: session summary name). */
  readonly viewName: string;
  /** obs/obsm inventory the canvases enumerate. */
  readonly fields: SessionFields | null;
  /** Cache-bust keys for useArrowField, keyed by field path. */
  readonly dataVersions: Record<string, number>;
  readonly theme: 'light' | 'dark';
  /** False → canvas stays fully interactive but persists nothing. */
  readonly canEdit: boolean;
  readonly editBlockedReason?: string | null;

  /** Controlled display updates. The host decides what persistence means:
   *  the Studio app mirrors into its store + debounced PUT; a dashboard writes
   *  it to node config. */
  readonly onDisplayChange: (next: DisplaySpec) => void;
  /** Freshest spec for an id — the app reads its store so an encoding edit and a
   *  camera move in the same debounce window don't clobber each other. Omitted →
   *  the passed display is already the freshest one. */
  readonly currentSpec?: (display: DisplaySpec) => DisplaySpec;

  readonly isolatedCategory: string | null;
  readonly hiddenCells: ReadonlySet<number> | null;

  /** Optional editing features. Omitted → that feature is simply off, and the canvas
   *  hides its affordances rather than offering a control that does nothing. */
  readonly regions?: RegionDrawHost;
  readonly annotations?: ShapeAnnotationHost;
  readonly snapshot?: SnapshotHost;
  /** Opens the points→global transform editor. The editor itself is app UI (it PUTs a
   *  transform through the REST layer), so the canvas only raises the intent and the
   *  host renders the modal. */
  readonly onEditTransform?: () => void;
}

const CanvasHostContext = createContext<CanvasHost | null>(null);

export function CanvasHostProvider({ host, children }: { host: CanvasHost; children: ReactNode }) {
  return <CanvasHostContext.Provider value={host}>{children}</CanvasHostContext.Provider>;
}

export function useCanvasHost(): CanvasHost {
  const host = useContext(CanvasHostContext);
  // A canvas genuinely cannot render without a host — it has no fields to enumerate
  // and nowhere to send a display edit. A silent default would hide the wiring bug.
  if (!host) throw new Error('useCanvasHost must be used inside a <CanvasHostProvider>');
  return host;
}

/** The display-editing handles a canvas works through: `persistDisplay` hands a whole
 * spec to the host, `currentSpec` re-reads the freshest one (not the possibly-stale
 * prop) so edits landing in the same window don't clobber each other, and
 * `updateEncoding` patches the encoding of that freshest spec. */
export function useDisplayEditor<T extends DisplaySpec>(
  display: T,
  isKind: (d: DisplaySpec) => d is T,
): {
  persistDisplay: (updated: T) => void;
  currentSpec: () => T;
  updateEncoding: (patch: Partial<T['encoding']>) => void;
} {
  const { onDisplayChange, currentSpec: hostCurrentSpec } = useCanvasHost();

  const currentSpec = useCallback((): T => {
    const latest = hostCurrentSpec ? hostCurrentSpec(display) : display;
    return isKind(latest) ? latest : display;
  }, [hostCurrentSpec, display, isKind]);

  const persistDisplay = useCallback(
    (updated: T) => onDisplayChange(updated),
    [onDisplayChange],
  );

  const updateEncoding = useCallback((patch: Partial<T['encoding']>) => {
    const base = currentSpec();
    persistDisplay({ ...base, encoding: { ...base.encoding, ...patch } } as T);
  }, [currentSpec, persistDisplay]);

  return { persistDisplay, currentSpec, updateEncoding };
}
