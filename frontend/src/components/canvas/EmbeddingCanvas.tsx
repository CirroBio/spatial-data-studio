import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView, OrbitView } from '@deck.gl/core';
import { PolygonLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { useAppStore } from '../../store/sessionStore';
import { useArrowField } from '../../hooks/useArrowField';
import { putDisplay, addDisplay as postDisplay, saveSnapshot } from '../../api';
import { reportError } from '../../lib/errors';
import { indicesInRings } from '../../lib/pointInPolygon';
import { isEmbeddingDisplay, type EmbeddingDisplaySpec, type ObsField, type ObsmField } from '../../types';
import { useArrowPositions } from './useArrowPositions';
import { useEmbeddingViewState, type EmbeddingViewState } from './useEmbeddingViewState';
import { useSpotColors, arrowToColorSource } from './useSpotColors';
import { buildSpotLayer } from './buildSpotLayer';
import EmbeddingControls from './EmbeddingControls';
import ColorBySelect from './ColorBySelect';
import { colorByLabel } from './colorBy';
import { LoadingCue, CellColorLegend, DrawHint } from './CanvasOverlays';

interface Props {
  display: EmbeddingDisplaySpec | null;
  sessionId: string;
  obsmFields: ObsmField[];
  obsFields: ObsField[];
  layerNames: string[];
  // Set by the active sidebar tab (see App); 'regions'/'subset' arm the lasso here,
  // 'shapes'/null leave the embedding view-only. Same contract as SpatialCanvas.
  canvasMode: 'regions' | 'shapes' | 'subset' | null;
  annotationTarget: { regionSetId: string; category: string; color: string } | null;
}

export default function EmbeddingCanvas({ display, sessionId, obsmFields, obsFields, layerNames, canvasMode, annotationTarget }: Props) {
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
      canvasMode={canvasMode}
      annotationTarget={annotationTarget}
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
  canvasMode,
  annotationTarget,
}: {
  display: EmbeddingDisplaySpec;
  sessionId: string;
  obsFields: ObsField[];
  layerNames: string[];
  obsmFields: ObsmField[];
  canvasMode: 'regions' | 'shapes' | 'subset' | null;
  annotationTarget: { regionSetId: string; category: string; color: string } | null;
}) {
  const {
    sessionState, updateDisplay, isolatedCategory, pushNotification, openSnapshots, setSnapshotHandler,
    drawPolygons, drawRing, addDrawVertex, clearDraw, setRegionCellCount, setRegionCellIndices,
  } = useAppStore();
  const dataVersions = sessionState?.data_versions ?? {};
  const readOnly = sessionState?.summary.read_only ?? false;

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
    return buildSpotLayer(positions, colors, {
      pointSize: display.encoding.point_size,
      opacity: display.encoding.opacity,
      is3d: is_3d,
    });
  }, [positions, colors, is_3d, display.encoding.point_size, display.encoding.opacity]);

  // ---- Region lasso (region labeling / subset from the embedding) ----
  // Shape annotations aren't offered here (they're tissue-coordinate decorations), so
  // only the cell-selecting modes arm drawing.
  const lassoMode = canvasMode === 'regions' || canvasMode === 'subset';
  const selColor: [number, number, number] = canvasMode === 'regions' ? [72, 187, 120] : [124, 108, 246];

  // A click adds a lasso vertex. In 2D the vertex is an embedding coordinate; in 3D the
  // orbit camera makes an unprojected world point meaningless, so we capture the screen
  // pixel and select by projecting cells back to screen (see the effect below).
  const handleClick = useCallback((info: PickingInfo) => {
    if (!lassoMode) return;
    if (is_3d) {
      if (info.x != null && info.y != null) addDrawVertex([info.x, info.y]);
    } else if (info.coordinate) {
      addDrawVertex([info.coordinate[0], info.coordinate[1]]);
    }
  }, [lassoMode, is_3d, addDrawVertex]);

  // Clear any in-progress drawing when the lasso disarms or the view unmounts, so a
  // half-drawn embedding region never leaks into the spatial canvas (shared draw state).
  useEffect(() => {
    if (!lassoMode) clearDraw();
    return () => clearDraw();
  }, [lassoMode, clearDraw]);

  // Resolve the drawn region to table-row indices. The embedding view is always
  // index-based (the backend can't polygon_query embedding/screen space). 2D tests the
  // lasso against embedding coords directly; 3D projects each cell through the live
  // camera and tests screen coords, so it selects every cell *visible* within the region.
  useEffect(() => {
    const rings = drawRing.length >= 3 ? [...drawPolygons, drawRing] : drawPolygons;
    if (!positions || !rings.length) {
      setRegionCellCount(0);
      setRegionCellIndices(lassoMode ? [] : null);
      return;
    }
    let indices: number[];
    if (is_3d) {
      const el = containerRef.current;
      const width = el?.clientWidth ?? 0;
      const height = el?.clientHeight ?? 0;
      if (!(width > 0 && height > 0) || !viewState) { setRegionCellCount(0); setRegionCellIndices([]); return; }
      const viewport = views[0].makeViewport({
        width, height,
        viewState: viewState as unknown as { target: [number, number, number]; zoom: number },
      });
      if (!viewport) { setRegionCellCount(0); setRegionCellIndices([]); return; }
      const n = positions.numRows;
      const stride = positions.positions.length / n;
      const screen = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const p = viewport.project([
          positions.positions[i * stride],
          positions.positions[i * stride + 1],
          stride >= 3 ? positions.positions[i * stride + 2] : 0,
        ]);
        screen[i * 2] = p[0];
        screen[i * 2 + 1] = p[1];
      }
      indices = indicesInRings(screen, n, rings);
    } else {
      indices = indicesInRings(positions.positions, positions.numRows, rings);
    }
    setRegionCellCount(indices.length);
    setRegionCellIndices(indices);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, drawPolygons, drawRing, is_3d, viewState, lassoMode]);

  const drawLayers = useMemo<Layer[]>(() => {
    if (!lassoMode || is_3d) return [];  // 3D draws a screen-space SVG overlay instead
    const out: Layer[] = [];
    if (drawPolygons.length) {
      out.push(new PolygonLayer<[number, number][]>({
        id: 'embed-draw-polys', data: drawPolygons, getPolygon: (d) => d,
        filled: true, getFillColor: [...selColor, 50], stroked: true,
        getLineColor: [...selColor, 220], getLineWidth: 2, lineWidthUnits: 'pixels', pickable: false,
      }));
    }
    if (drawRing.length) {
      out.push(new PathLayer<[number, number][]>({
        id: 'embed-draw-ring', data: [drawRing], getPath: (d) => d,
        getColor: [...selColor, 220], getWidth: 2, widthUnits: 'pixels', pickable: false,
      }));
      out.push(new ScatterplotLayer<[number, number]>({
        id: 'embed-draw-verts', data: drawRing, getPosition: (d) => d,
        getFillColor: [...selColor, 255], getRadius: 4, radiusUnits: 'pixels', pickable: false,
      }));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lassoMode, is_3d, drawPolygons, drawRing, canvasMode]);

  // Update the store mirror immediately, then debounce the PUT so a slider drag or a
  // pan/rotate collapses into one write. A ref (not state) holds the timer so back-to-back
  // viewport events during a drag reliably reset the same debounce. A read-only
  // (snapshot) session keeps the camera interactive locally but never persists — the
  // backend would 403 the PUT anyway (session.read_only).
  function persistDisplay(updated: EmbeddingDisplaySpec) {
    updateDisplay(updated);
    if (readOnly) return;
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
          // A 3D lasso is captured in screen space (see handleClick); once the camera
          // moves the frozen ring no longer matches the scene, so drop the in-progress
          // /committed region rather than let it select the wrong cells.
          if (is_3d && lassoMode && (drawRing.length > 0 || drawPolygons.length > 0)) clearDraw();
        }}
        onClick={handleClick}
        layers={[...layers, ...drawLayers]}
        controller={lassoMode ? { doubleClickZoom: false } : true}
        getCursor={lassoMode ? () => 'crosshair' : ({ isDragging }) => (isDragging ? 'grabbing' : 'grab')}
      />

      {/* 3D lasso overlay: the ring lives in screen pixels (see handleClick), which the
          canvas-sized SVG draws in directly. 2D rings render as deck layers instead. */}
      {is_3d && lassoMode && (drawPolygons.length > 0 || drawRing.length > 0) && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none">
          {drawPolygons.map((ring, i) => (
            <polygon key={i} points={ring.map((p) => p.join(',')).join(' ')}
              fill={`rgba(${selColor.join(',')},0.15)`} stroke={`rgba(${selColor.join(',')},0.85)`} strokeWidth={2} />
          ))}
          {drawRing.length > 0 && (
            <polyline points={drawRing.map((p) => p.join(',')).join(' ')}
              fill="none" stroke={`rgba(${selColor.join(',')},0.9)`} strokeWidth={2} />
          )}
          {drawRing.map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r={3} fill={`rgba(${selColor.join(',')},1)`} />
          ))}
        </svg>
      )}

      <DrawHint drawMode={lassoMode} canvasMode={canvasMode} annotationTarget={annotationTarget} />

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
