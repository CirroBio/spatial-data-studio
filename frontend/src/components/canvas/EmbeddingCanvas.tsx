import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView, OrbitView } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { useAppStore } from '../../store/sessionStore';
import { useArrowField } from '../../hooks/useArrowField';
import { putDisplay, addDisplay as postDisplay, saveSnapshot } from '../../api';
import { reportError } from '../../lib/errors';
import { isEmbeddingDisplay, type EmbeddingDisplaySpec, type ObsField, type ObsmField } from '../../types';
import { useArrowPositions } from './useArrowPositions';
import { useEmbeddingViewState, type EmbeddingViewState } from './useEmbeddingViewState';
import { useSpotColors, arrowToColorSource } from './useSpotColors';
import { buildSpotLayer } from './buildSpotLayer';
import EmbeddingControls from './EmbeddingControls';
import ColorBySelect from './ColorBySelect';
import { colorByLabel } from './colorBy';
import { LoadingCue, CellColorLegend } from './CanvasOverlays';

interface Props {
  display: EmbeddingDisplaySpec | null;
  sessionId: string;
  obsmFields: ObsmField[];
  obsFields: ObsField[];
  layerNames: string[];
}

export default function EmbeddingCanvas({ display, sessionId, obsmFields, obsFields, layerNames }: Props) {
  const { addDisplay } = useAppStore();

  if (!display) {
    return (
      <EmbeddingEmptyState
        sessionId={sessionId}
        obsmFields={obsmFields.filter((f) => f.name !== 'spatial')}
        obsFields={obsFields}
        layers={layerNames}
        onCreated={addDisplay}
      />
    );
  }

  return (
    <EmbeddingCanvasView
      display={display}
      sessionId={sessionId}
      obsFields={obsFields}
      layerNames={layerNames}
      obsmFields={obsmFields}
    />
  );
}

function EmbeddingEmptyState({
  sessionId,
  obsmFields,
  obsFields,
  layers,
  onCreated,
}: {
  sessionId: string;
  obsmFields: ObsmField[];
  obsFields: ObsField[];
  layers: string[];
  onCreated: (display: EmbeddingDisplaySpec) => void;
}) {
  const firstCategorical = obsFields.find((f) => f.kind === 'categorical');
  const [selectedKey, setSelectedKey] = useState(obsmFields[0]?.name ?? '');
  const [colorBy, setColorBy] = useState(firstCategorical ? `obs:${firstCategorical.name}` : '');
  const [creating, setCreating] = useState(false);

  if (obsmFields.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm text-center px-8">
        No embeddings found — run a dimensionality reduction (e.g. UMAP, PCA) to populate this view.
      </div>
    );
  }

  // selectedKey's initial value is captured before any embedding exists (the
  // empty branch above), so fall back to the first available key if it's stale.
  const embeddingKey = obsmFields.some((f) => f.name === selectedKey) ? selectedKey : obsmFields[0].name;

  async function handleCreate() {
    const field = obsmFields.find((f) => f.name === embeddingKey);
    const n = field?.n_components ?? 2;
    setCreating(true);
    try {
      const spec = await postDisplay(sessionId, {
        type: 'embedding_canvas',
        encoding: {
          obsm_key: embeddingKey,
          x_component: 0,
          y_component: Math.min(1, n - 1),
          z_component: Math.min(2, n - 1),
          is_3d: false,
          color_by: colorBy,
          point_size: 4,
          opacity: 0.85,
          colormap: 'viridis',
          legend_visible: true,
          legend_title: '',
        },
        viewport: null,
      });
      onCreated(spec as EmbeddingDisplaySpec);
    } catch (e) {
      reportError('Could not create embedding view', e);
    } finally {
      setCreating(false);
    }
  }

  const labelClass = 'text-[10px] text-muted font-mono uppercase tracking-wide';

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-muted">
      <span className="text-sm">No embedding view configured for this session yet.</span>
      <div className="flex flex-col gap-2 w-60">
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Embedding</label>
          <select
            value={embeddingKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:border-accent"
          >
            {obsmFields.map((f) => (
              <option key={f.name} value={f.name}>{f.name}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Color by</label>
          <ColorBySelect
            sessionId={sessionId}
            value={colorBy}
            obsFields={obsFields}
            layers={layers}
            onChange={setColorBy}
          />
        </div>
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="mt-1 w-full px-3 py-1 bg-accent hover:bg-accent/80 text-white rounded text-xs transition-colors disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create embedding view'}
        </button>
      </div>
    </div>
  );
}

function EmbeddingCanvasView({
  display,
  sessionId,
  obsFields,
  layerNames,
  obsmFields,
}: {
  display: EmbeddingDisplaySpec;
  sessionId: string;
  obsFields: ObsField[];
  layerNames: string[];
  obsmFields: ObsmField[];
}) {
  const { sessionState, updateDisplay, isolatedCategory, pushNotification, openSnapshots, setSnapshotHandler } = useAppStore();
  const dataVersions = sessionState?.data_versions ?? {};

  const { is_3d, x_component, y_component, z_component } = display.encoding;
  const coordsPath = `obsm:${display.encoding.obsm_key}`;
  const coordsVersion = dataVersions[coordsPath] ?? 0;
  const colorByPath = display.encoding.color_by;
  const colorVersion = dataVersions[colorByPath] ?? 0;

  const { table: coordsTable, loading: coordsLoading } = useArrowField(sessionId, coordsPath, coordsVersion);
  const { table: colorTable, loading: colorLoading } = useArrowField(sessionId, colorByPath, colorVersion);

  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const positions = useArrowPositions(coordsTable, {
    xIndex: x_component,
    yIndex: y_component,
    zIndex: is_3d ? z_component : undefined,
  });

  const { containerRef, viewState, setViewState, fitToData } = useEmbeddingViewState({
    positions,
    is3d: is_3d,
  });

  const colorSource = useMemo(() => arrowToColorSource(colorTable), [colorTable]);
  const { colors, colorLegend } = useSpotColors({
    colorSource,
    positions,
    opacity: display.encoding.opacity,
    isolatedCategory,
  });

  // Snapshot is triggered from the header menu; register a handler that reads the
  // live camera via a ref so the snapshot opens where the user was looking.
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const handleSnapshot = useCallback(async () => {
    try {
      const vs = viewStateRef.current;
      const target = vs?.target as number[] | undefined;
      const viewport = vs && target && typeof vs.zoom === 'number'
        ? { target: target.slice(0, 2), zoom: vs.zoom }
        : undefined;
      const r = await saveSnapshot(sessionId, { viewport, display_id: display.id });
      openSnapshots(r.name);
      pushNotification({ kind: 'info', message: 'Snapshot saved.' });
    } catch (e) {
      reportError('Snapshot failed', e);
    }
  }, [sessionId, display.id, openSnapshots, pushNotification]);
  useEffect(() => {
    setSnapshotHandler(handleSnapshot);
    return () => setSnapshotHandler(null);
  }, [handleSnapshot, setSnapshotHandler]);

  const legendVisible = display.encoding.legend_visible !== false;
  const legendTitle = display.encoding.legend_title || colorByLabel(colorByPath);

  const views = useMemo(
    () => (is_3d ? [new OrbitView({ id: 'main' })] : [new OrthographicView({ id: 'main', flipY: false })]),
    [is_3d],
  );

  const layers = useMemo(() => {
    if (!positions || !colors) return [] as Layer[];
    return [buildSpotLayer(positions, colors, {
      pointSize: display.encoding.point_size,
      opacity: display.encoding.opacity,
      is3d: is_3d,
    })];
  }, [positions, colors, is_3d, display.encoding.point_size, display.encoding.opacity]);

  // Update the store mirror immediately, then debounce the PUT so a slider drag or a
  // pan/rotate collapses into one write. A ref (not state) holds the timer so back-to-back
  // viewport events during a drag reliably reset the same debounce.
  function persistDisplay(updated: EmbeddingDisplaySpec) {
    updateDisplay(updated);
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      putDisplay(sessionId, updated).catch(console.error);
    }, 500);
  }

  // Build from the latest store spec, not the possibly-stale prop, so an encoding edit
  // and a camera move in the same debounce window don't clobber each other.
  function currentSpec(): EmbeddingDisplaySpec {
    const stored = useAppStore.getState().sessionState?.app_state.displays.find((d) => d.id === display.id);
    return stored && isEmbeddingDisplay(stored) ? stored : display;
  }

  function updateEncoding(patch: Partial<EmbeddingDisplaySpec['encoding']>) {
    const base = currentSpec();
    persistDisplay({ ...base, encoding: { ...base.encoding, ...patch } });
  }

  // Persist a camera move as the display's viewport; 3D keeps the orbit angles,
  // 2D just target + zoom.
  function commitViewState(vs: EmbeddingViewState) {
    const v = vs as { target: number[]; zoom: number; rotationX?: number; rotationOrbit?: number };
    const viewport = is_3d
      ? { target: [v.target[0], v.target[1], v.target[2] ?? 0], zoom: v.zoom, rotationX: v.rotationX, rotationOrbit: v.rotationOrbit }
      : { target: [v.target[0], v.target[1]], zoom: v.zoom };
    persistDisplay({ ...currentSpec(), viewport });
  }

  const colorByName = colorByLabel(colorByPath);

  if (!viewState) {
    return (
      <div ref={containerRef} className="w-full h-full flex items-center justify-center bg-bg text-muted text-sm">
        {coordsLoading ? 'Loading embedding coordinates...' : 'Initializing canvas...'}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative bg-bg"
      // Right-drag pans the orbit camera; swallow the browser context menu over the canvas
      // so the gesture isn't interrupted (form fields in the overlay panel keep theirs).
      onContextMenu={(e) => { if ((e.target as HTMLElement).tagName === 'CANVAS') e.preventDefault(); }}
    >
      <DeckGL
        // Remount on the 2D/3D toggle: deck.gl reuses the controller instance across an
        // in-place view-class swap (Orthographic <-> Orbit), leaving drag/zoom wedged until
        // the canvas is torn down. Keying on is_3d forces a fresh controller for the new view.
        key={is_3d ? '3d' : '2d'}
        views={views}
        viewState={viewState as unknown as Record<string, EmbeddingViewState>}
        onViewStateChange={({ viewState: vs }) => {
          setViewState(vs as EmbeddingViewState);
          commitViewState(vs as EmbeddingViewState);
        }}
        layers={layers}
        controller={true}
        getCursor={({ isDragging }) => (isDragging ? 'grabbing' : 'grab')}
      />

      <LoadingCue coordsLoading={coordsLoading} colorLoading={colorLoading} tilesLoading={false} />

      <CellColorLegend visible={legendVisible} legend={colorLegend} title={legendTitle} />

      <EmbeddingControls
        display={display}
        sessionId={sessionId}
        obsFields={obsFields}
        layers={layerNames}
        obsmFields={obsmFields}
        colorByName={colorByName}
        legendVisible={legendVisible}
        updateEncoding={updateEncoding}
        panelCollapsed={panelCollapsed}
        setPanelCollapsed={setPanelCollapsed}
        onFit={() => { const fit = fitToData(); if (fit) setViewState(fit); }}
      />

      {is_3d && (
        <div className="absolute bottom-3 left-3 text-[10px] leading-tight text-muted/70 font-mono select-none pointer-events-none">
          <div>Left-drag · rotate</div>
          <div>Right-drag · move</div>
        </div>
      )}
    </div>
  );
}
