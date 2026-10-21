// The viewer's canvases inside the app: the CanvasHost that feeds them the opened
// dataset's fields and data versions, takes their display edits, and holds their cell
// selection. Their display settings are the Studio's own panel, docked in the page's
// Display drawer (`settings`) rather than floating over the canvas.
import { lazy, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { EmbeddingSettings, SpatialSettings } from '@cirrobio/studio-ui';
import {
  CanvasHostProvider, DataSourceProvider, type CanvasHost, type CheckpointHandle, type DisplaySpec,
  type EmbeddingDisplaySpec, type OverlayInset, type SpatialDisplaySpec,
} from '@cirrobio/spatial-viewer';
import { currentDisplay, setDisplay, setTissueCanvas, setWorldPerPixel } from './displayState';
import { regionHost, useSelection } from './selection';
import { EmbeddingTools, SpatialTools } from './ViewTools';

const SpatialCanvas = lazy(() => import('@cirrobio/spatial-viewer').then((m) => ({ default: m.SpatialCanvas })));
const EmbeddingCanvas = lazy(() => import('@cirrobio/spatial-viewer').then((m) => ({ default: m.EmbeddingCanvas })));

const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
const subscribeScheme = (l: () => void) => {
  darkScheme.addEventListener('change', l);
  return () => darkScheme.removeEventListener('change', l);
};
function useTheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribeScheme, () => (darkScheme.matches ? 'dark' : 'light'));
}

export function DatasetCanvases({ wbKey, handle, dataVersions, selecting, inset, children }: {
  wbKey: string; handle: CheckpointHandle; dataVersions: Record<string, number>; selecting: boolean;
  // The page's drawers and views bar, which the canvases' legends and overview keep clear of.
  inset: OverlayInset; children: ReactNode;
}) {
  const theme = useTheme();
  // Subscribed so the host changes identity when the selection does.
  useSelection(wbKey);
  const regions = regionHost(wbKey);
  const host = useMemo((): CanvasHost => ({
    viewName: handle.source.id,
    fields: handle.fields,
    dataVersions,
    theme,
    canEdit: true,
    onDisplayChange: (next: DisplaySpec) => setDisplay(wbKey, next),
    currentSpec: (d: DisplaySpec) => currentDisplay(wbKey, d),
    isolatedCategory: null,
    hiddenCells: null,
    regions: selecting ? regions : undefined,
    onView: ({ worldPerScreenPixel }) => setWorldPerPixel(wbKey, worldPerScreenPixel),
    drawHint: (gesture) => `Selecting cells: ${gesture}`,
    overlayInset: inset,
  }), [handle, dataVersions, theme, wbKey, regions, selecting, inset]);
  return (
    <DataSourceProvider source={handle.source}>
      <CanvasHostProvider host={host}>{children}</CanvasHostProvider>
    </DataSourceProvider>
  );
}

/** Where the page shows a canvas' controls: the Display drawer's body for its settings,
 * and the views bar for the tools. */
export interface ControlSlots { settings: HTMLElement | null; tools: HTMLElement | null }

export function SpatialLens({ display, wbKey, selecting, slots, unit }: {
  display: SpatialDisplaySpec; wbKey: string; selecting: boolean; slots: ControlSlots; unit: 'µm' | null;
}) {
  return (
    <div className="lens-canvas" ref={(el) => setTissueCanvas(wbKey, el)}>
      <SpatialCanvas display={display} sessionId={wbKey} canvasMode={selecting ? 'regions' : null} annotationTarget={null} followDisplayViewport
        controls={(api) => (
          <>
            {slots.settings && createPortal(<SpatialSettings api={api} docked />, slots.settings)}
            {slots.tools && createPortal(<SpatialTools api={api} wbKey={wbKey} unit={unit} />, slots.tools)}
          </>
        )} />
    </div>
  );
}

export function EmbeddingLens({ display, wbKey, handle, selecting, slots }: {
  display: EmbeddingDisplaySpec; wbKey: string; handle: CheckpointHandle; selecting: boolean; slots: ControlSlots;
}) {
  return (
    <div className="lens-canvas">
      <EmbeddingCanvas display={display} sessionId={wbKey} obsmFields={handle.fields.obsm} obsFields={handle.fields.obs}
        layerNames={handle.fields.layers} canvasMode={selecting ? 'regions' : null} annotationTarget={null} followDisplayViewport
        controls={(api) => (
          <>
            {slots.settings && createPortal(<EmbeddingSettings api={api} docked />, slots.settings)}
            {slots.tools && createPortal(<EmbeddingTools api={api} />, slots.tools)}
          </>
        )} />
    </div>
  );
}
