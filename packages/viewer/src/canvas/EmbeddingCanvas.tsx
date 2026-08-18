import { useMemo, useCallback, useEffect, useRef, type ReactNode } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView, OrbitView } from '@deck.gl/core';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { useArrowField } from '../data/useArrowField';
import { indicesInRings } from '../lib/pointInPolygon';
import { isEmbeddingDisplay, type EmbeddingDisplaySpec, type ObsField, type ObsmField, type Viewport } from '../types';
import { EMBEDDING_ENCODING_DEFAULTS } from '../defaults';
import { useArrowPositions } from './useArrowPositions';
import { useCanvasHost, useDisplayEditor } from './canvas-host';
import { useEmbeddingViewState, type EmbeddingViewState } from './useEmbeddingViewState';
import { useColorField } from './useColorField';
import { useSnapshotHandler } from './useSnapshotHandler';
import { buildLassoLayers } from './buildLassoLayers';
import { useSpotColors, arrowToColorSource } from './useSpotColors';
import { buildSpotLayer } from './buildSpotLayer';
import { colorByLabel } from './colorBy';
import { SELECTION_COLORS } from './colorUtils';
import { LoadingCue, CellColorLegend, DrawHint } from './CanvasOverlays';
import { CANVAS_PLACEHOLDER, CANVAS_ROOT, MONO_FONT, themeColor } from './overlayStyles';

// Stable empties for a host without region drawing, so the lasso memo and the
// membership effect below aren't handed a fresh array on every render.
const NO_POLYGONS: [number, number][][] = [];
const NO_POINTS: [number, number][] = [];

/** What an in-canvas control panel needs from a mounted EmbeddingCanvas. Same slot
 * contract as SpatialCanvas: the Studio app renders `EmbeddingControls` from this,
 * a dashboard passes no `controls`. */
export interface EmbeddingCanvasControls {
  display: EmbeddingDisplaySpec;
  obsFields: ObsField[];
  layers: string[];
  obsmFields: ObsmField[];
  colorByName: string;
  legendVisible: boolean;
  updateEncoding: (patch: Partial<EmbeddingDisplaySpec['encoding']>) => void;
  onFit: () => void;
}

interface Props {
  display: EmbeddingDisplaySpec;
  sessionId: string;
  obsmFields: ObsmField[];
  obsFields: ObsField[];
  layerNames: string[];
  // Set by the active sidebar tab (see App); 'regions'/'subset' arm the lasso here,
  // 'shapes'/null leave the embedding view-only. Same contract as SpatialCanvas.
  canvasMode: 'regions' | 'shapes' | 'subset' | null;
  annotationTarget: { regionSetId: string; category: string; color: string } | null;
  /** In-canvas control panel; omit it for a bare canvas. See SpatialCanvas. */
  controls?: (api: EmbeddingCanvasControls) => ReactNode;
  /** Follow `display.viewport` into the camera when the host replaces it. See SpatialCanvas. */
  followDisplayViewport?: boolean;
}

export default function EmbeddingCanvas({
  display,
  sessionId,
  obsFields,
  layerNames,
  obsmFields,
  canvasMode,
  annotationTarget,
  controls,
  followDisplayViewport = false,
}: Props) {
  const host = useCanvasHost();
  const { dataVersions, isolatedCategory, hiddenCells, theme } = host;
  // The lasso is an optional host feature; absent, this canvas is view-only.
  const regions = host.regions;
  const drawPolygons = regions?.drawPolygons ?? NO_POLYGONS;
  const drawRing = regions?.drawRing ?? NO_POINTS;

  const { is_3d, x_component, y_component, z_component } = display.encoding;
  const coordsPath = `obsm:${display.encoding.obsm_key}`;
  const coordsVersion = dataVersions[coordsPath] ?? 0;

  const { table: coordsTable, loading: coordsLoading } = useArrowField(coordsPath, coordsVersion);
  const { colorByPath, colorTable, colorLoading } = useColorField(display.encoding.color_by, dataVersions);

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
    hiddenCells,
    categoryColors: display.encoding.category_colors?.[colorByPath],
  });

  useSnapshotHandler({
    kind: 'embedding',
    sessionId,
    displayId: display.id,
    viewState,
    containerRef,
    getCanvasSize: () => {
      const el = containerRef.current;
      return el ? { width: el.clientWidth, height: el.clientHeight } : { width: 1000, height: 1000 };
    },
  });

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
  const lassoMode = !!regions && (canvasMode === 'regions' || canvasMode === 'subset');
  // Unlike the spatial canvas, the embedding plot has no backdrop of its own — it sits
  // on the app background, so the overlay color keys off the app theme.
  const selColor = SELECTION_COLORS[theme][canvasMode === 'regions' ? 'regions' : 'subset'];

  // A click adds a lasso vertex. In 2D the vertex is an embedding coordinate; in 3D the
  // orbit camera makes an unprojected world point meaningless, so we capture the screen
  // pixel and select by projecting cells back to screen (see the effect below).
  const handleClick = useCallback((info: PickingInfo) => {
    if (!lassoMode || !regions) return;
    if (is_3d) {
      if (info.x != null && info.y != null) regions.addDrawVertex([info.x, info.y]);
    } else if (info.coordinate) {
      regions.addDrawVertex([info.coordinate[0], info.coordinate[1]]);
    }
  }, [lassoMode, is_3d, regions]);

  const clearDraw = regions?.clearDraw;
  // Clear any in-progress drawing when the lasso disarms or the view unmounts, so a
  // half-drawn embedding region never leaks into the spatial canvas (shared draw state).
  useEffect(() => {
    if (!clearDraw) return;
    if (!lassoMode) clearDraw();
    return () => clearDraw();
  }, [lassoMode, clearDraw]);

  // Resolve the drawn region to table-row indices. The embedding view is always
  // index-based (the backend can't polygon_query embedding/screen space). 2D tests the
  // lasso against embedding coords directly; 3D projects each cell through the live
  // camera and tests screen coords, so it selects every cell *visible* within the region.
  useEffect(() => {
    if (!regions) return;
    const { setRegionCellCount, setRegionCellIndices } = regions;
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
    return buildLassoLayers(drawPolygons, drawRing, selColor, { idPrefix: 'embed-draw' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lassoMode, is_3d, drawPolygons, drawRing, canvasMode]);

  const { persistDisplay, currentSpec, updateEncoding } = useDisplayEditor(display, isEmbeddingDisplay);

  // Persist a camera move as the display's viewport; 3D keeps the orbit angles,
  // 2D just target + zoom.
  function commitViewState(vs: EmbeddingViewState) {
    const v = vs as { target: number[]; zoom: number; rotationX?: number; rotationOrbit?: number };
    const viewport = is_3d
      ? { target: [v.target[0], v.target[1], v.target[2] ?? 0], zoom: v.zoom, rotationX: v.rotationX, rotationOrbit: v.rotationOrbit }
      : { target: [v.target[0], v.target[1]], zoom: v.zoom };
    persistDisplay({ ...currentSpec(), viewport });
  }

  // Follow a viewport the host applied to the display (the embedded viewer's
  // apply-display, and the checkpoint's saved viewport on mount). Same shape and
  // rationale as the SpatialCanvas counterpart — opt-in, one-shot per applied
  // viewport object, and a camera move made here round-trips through the store as an
  // equal viewport and is left alone.
  const appliedEmbedViewport = useRef<Viewport | null | undefined>(undefined);
  useEffect(() => {
    if (!followDisplayViewport || !viewState) return;
    const vp = display.viewport;
    if (appliedEmbedViewport.current === vp) return;
    appliedEmbedViewport.current = vp;
    if (!vp) {
      // null = auto-fit
      const fit = fitToData();
      if (fit) setViewState(fit);
      return;
    }
    const v = viewState as { target: number[]; zoom: number; rotationX?: number; rotationOrbit?: number };
    if (
      Math.abs(v.target[0] - vp.target[0]) < 1e-6 &&
      Math.abs(v.target[1] - vp.target[1]) < 1e-6 &&
      Math.abs(v.zoom - vp.zoom) < 1e-6 &&
      (vp.rotationX === undefined || Math.abs((v.rotationX ?? 0) - vp.rotationX) < 1e-6) &&
      (vp.rotationOrbit === undefined || Math.abs((v.rotationOrbit ?? 0) - vp.rotationOrbit) < 1e-6)
    ) return;
    setViewState(
      is_3d
        ? {
            ...viewState,
            target: [vp.target[0], vp.target[1], vp.target[2] ?? 0],
            zoom: vp.zoom,
            rotationX: vp.rotationX ?? v.rotationX,
            rotationOrbit: vp.rotationOrbit ?? v.rotationOrbit,
          }
        : { ...viewState, target: [vp.target[0], vp.target[1], 0], zoom: vp.zoom },
    );
  }, [followDisplayViewport, display.viewport, viewState, is_3d, fitToData, setViewState]);

  const colorByName = colorByLabel(colorByPath);

  if (!viewState) {
    return (
      <div ref={containerRef} style={CANVAS_PLACEHOLDER}>
        {coordsLoading ? 'Loading embedding coordinates...' : 'Initializing canvas...'}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ ...CANVAS_ROOT, background: themeColor('bg') }}
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
          if (is_3d && lassoMode && (drawRing.length > 0 || drawPolygons.length > 0)) clearDraw?.();
        }}
        onClick={handleClick}
        layers={[...layers, ...drawLayers]}
        controller={(display.encoding.lock_view ?? EMBEDDING_ENCODING_DEFAULTS.lock_view) ? false
          : lassoMode ? { doubleClickZoom: false } : true}
        getCursor={lassoMode ? () => 'crosshair' : ({ isDragging }) => (isDragging ? 'grabbing' : 'grab')}
      />

      {/* 3D lasso overlay: the ring lives in screen pixels (see handleClick), which the
          canvas-sized SVG draws in directly. 2D rings render as deck layers instead. */}
      {is_3d && lassoMode && (drawPolygons.length > 0 || drawRing.length > 0) && (
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
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

      <LoadingCue coordsLoading={coordsLoading} colorLoading={colorLoading} boundariesLoading={false} />

      <CellColorLegend visible={legendVisible} legend={colorLegend} title={legendTitle}
        scale={display.encoding.legend_scale ?? EMBEDDING_ENCODING_DEFAULTS.legend_scale} />

      {controls?.({
        display,
        obsFields,
        layers: layerNames,
        obsmFields,
        colorByName,
        legendVisible,
        updateEncoding,
        onFit: () => { const fit = fitToData(); if (fit) setViewState(fit); },
      })}

      {is_3d && (
        <div style={{
          position: 'absolute', bottom: 12, left: 12,
          fontSize: 10, lineHeight: 1.25, fontFamily: MONO_FONT,
          color: themeColor('muted', 0.7),
          userSelect: 'none', WebkitUserSelect: 'none', pointerEvents: 'none',
        }}>
          <div>Left-drag · rotate</div>
          <div>Right-drag · move</div>
        </div>
      )}
    </div>
  );
}
