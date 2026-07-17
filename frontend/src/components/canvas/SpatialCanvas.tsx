import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { ScatterplotLayer, PolygonLayer, PathLayer } from '@deck.gl/layers';
import type { Layer, OrthographicViewState, PickingInfo } from '@deck.gl/core';
import { useAppStore } from '../../store/sessionStore';
import { useArrowField } from '../../hooks/useArrowField';
import { getImageInfo, putDisplay, saveSnapshot, getCellField, getElements, type CellFieldMeta } from '../../api';
import { reportError } from '../../lib/errors';
import TransformEditor from '../TransformEditor';
import { isSpatialDisplay, type SpatialDisplaySpec, type ImageInfo } from '../../types';
import { useArrowPositions } from './useArrowPositions';
import { useImageTiles } from './useImageTiles';
import { useCanvasViewState, cellZoomThreshold, ZOOM_HYSTERESIS } from './useCanvasViewState';
import { useSpotColors, arrowToColorSource } from './useSpotColors';
import { buildSpotLayer } from './buildSpotLayer';
import { buildCellFieldLayer } from './buildCellFieldLayer';
import { usePolygonBbox } from './usePolygonBbox';
import { useImageChannels } from './useImageChannels';
import CanvasControls from './CanvasControls';
import { colorByLabel } from './colorBy';
import { LoadingCue, ChannelLegend, CellColorLegend, DrawHint } from './CanvasOverlays';

const VIEWS = [new OrthographicView({ id: 'main', flipY: false })];

interface Props {
  display: SpatialDisplaySpec;
  sessionId: string;
  // 'annotate' | 'subset' | null — set by active sidebar tab; when null canvas is view-only
  canvasMode: 'annotate' | 'subset' | null;
  // Annotation config: which region set + category + color to label into
  annotationTarget: { regionSetId: string; category: string; color: string } | null;
}

export default function SpatialCanvas({ display, sessionId, canvasMode, annotationTarget }: Props) {
  const { sessionState, updateDisplay, isolatedCategory, pushNotification, openSnapshots, setSnapshotHandler } = useAppStore();
  const fields = sessionState?.fields;
  const dataVersions = sessionState?.data_versions ?? {};

  const coordsPath = display.encoding.coords;
  const coordsVersion = dataVersions[coordsPath] ?? 0;
  const colorByPath = display.encoding.color_by;
  const colorVersion = dataVersions[colorByPath] ?? 0;

  const { table: coordsTable, loading: coordsLoading } = useArrowField(sessionId, coordsPath, coordsVersion);
  const { table: colorTable, loading: colorLoading } = useArrowField(sessionId, colorByPath, colorVersion);

  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  // Layer-visibility toggles are persisted in the display encoding (fall back to the
  // historical defaults when a checkpoint predates these fields).
  const showPoints = display.encoding.show_points ?? true;
  const showImage = display.encoding.show_image ?? (display.encoding.image_layer !== null);
  const showLegend = display.encoding.show_channel_legend ?? true;
  const [transformOpen, setTransformOpen] = useState(false);
  const [openColorPicker, setOpenColorPicker] = useState<number | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  // Polygon draw state lives in the store so the active tab's left panel owns the
  // commit / apply / clear actions; the canvas is purely the drawing surface.
  const { drawPolygons: polygons, drawRing: currentRing, addDrawVertex, clearDraw } = useAppStore();

  const drawMode = canvasMode !== null;

  const positions = useArrowPositions(coordsTable);

  const { containerRef, canvasSize, viewState, setViewState, fitToData } = useCanvasViewState({
    positions,
    imageInfo,
    showImage,
    display,
  });

  const { channels, visibleChannels, setChannel } = useImageChannels({
    imageInfo,
    display,
    sessionId,
    updateDisplay,
  });

  // Snapshot is triggered from the header menu; register a handler that reads the
  // live viewport via a ref (so the snapshot opens where the user was looking, not
  // at the possibly-stale persisted viewport) and reports itself while mounted.
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const handleSnapshot = useCallback(async () => {
    try {
      const vs = viewStateRef.current;
      const viewport = vs && typeof vs.zoom === 'number'
        ? { target: (vs.target as number[]).slice(0, 2), zoom: vs.zoom }
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

  // Clear any in-progress drawing when leaving/entering a draw mode.
  useEffect(() => {
    clearDraw();
  }, [canvasMode, clearDraw]);

  const handleClick = useCallback((info: PickingInfo) => {
    if (!drawMode || !info.coordinate) return;
    addDrawVertex([info.coordinate[0], info.coordinate[1]]);
  }, [drawMode, addDrawVertex]);

  // Load image info
  useEffect(() => {
    if (display.encoding.image_layer && sessionId) {
      getImageInfo(sessionId, display.encoding.image_layer)
        .then(setImageInfo)
        .catch(console.error);
    }
  }, [sessionId, display.encoding.image_layer]);

  const colorSource = useMemo(() => arrowToColorSource(colorTable), [colorTable]);
  const { colors, colorLegend } = useSpotColors({
    colorSource,
    positions,
    opacity: display.encoding.opacity,
    isolatedCategory,
  });

  const legendVisible = display.encoding.legend_visible !== false;
  const legendTitle = display.encoding.legend_title || colorByLabel(colorByPath);

  const { layers: imageLayers, loading: tilesLoading } = useImageTiles({
    imageInfo,
    sessionId,
    element: display.encoding.image_layer,
    viewState,
    size: canvasSize,
    visibleChannels,
    show: showImage,
  });

  // Cell-field metadata (R = median NN distance) — fetched once per session/coords/
  // version. R sizes the field discs and sets the field<->detail zoom threshold.
  const renderMode = display.encoding.render_mode ?? 'auto';
  const [cellField, setCellField] = useState<CellFieldMeta | null>(null);
  useEffect(() => {
    setCellField(null);
    if (!sessionId || !coordsPath) return;
    let stale = false;
    getCellField(sessionId, coordsPath)
      .then((m) => { if (!stale) setCellField(m); })
      .catch(() => { if (!stale) setCellField(null); });  // no field metadata → fall back to points
    return () => { stale = true; };
  }, [sessionId, coordsPath, coordsVersion]);

  // Polygon shape sets available for this session (elements inventory filtered to
  // polygonal geom types). Empty → the whole polygon path stays dormant.
  const [polygonElements, setPolygonElements] = useState<string[]>([]);
  useEffect(() => {
    setPolygonElements([]);
    if (!sessionId) return;
    let stale = false;
    getElements(sessionId)
      .then((inv) => {
        if (stale) return;
        setPolygonElements(
          inv.shapes
            .filter((s) => s.geometry.some((g) => g === 'Polygon' || g === 'MultiPolygon'))
            .map((s) => s.name),
        );
      })
      .catch(() => { if (!stale) setPolygonElements([]); });
    return () => { stale = true; };
  }, [sessionId, coordsVersion]);

  // Effective shape set: the persisted choice if it still exists, else the first
  // available polygon element (e.g. cell_boundaries). null when none exist.
  const shapesElement = useMemo(() => {
    const chosen = display.encoding.shapes_layer;
    if (chosen && polygonElements.includes(chosen)) return chosen;
    return polygonElements[0] ?? null;
  }, [display.encoding.shapes_layer, polygonElements]);

  const zoom = viewState ? (Array.isArray(viewState.zoom) ? viewState.zoom[0] : viewState.zoom) ?? 0 : 0;

  // Field <-> detail regime with hysteresis, so hovering near the threshold does
  // not flip-flop. Only meaningful in 'auto' mode; 'points' pins to the scatter.
  const [regime, setRegime] = useState<'field' | 'detail'>('field');
  useEffect(() => {
    if (renderMode !== 'auto' || !cellField) return;
    const th = cellZoomThreshold(cellField.median_nn_world);
    setRegime((prev) => {
      if (prev === 'field' && zoom > th + ZOOM_HYSTERESIS) return 'detail';
      if (prev === 'detail' && zoom < th - ZOOM_HYSTERESIS) return 'field';
      return prev;
    });
  }, [zoom, cellField, renderMode]);

  const polygonsActive = renderMode === 'auto' && regime === 'detail' && shapesElement !== null && showPoints;
  const { layer: polygonLayer, loading: polygonsLoading } = usePolygonBbox({
    sessionId,
    element: shapesElement,
    version: coordsVersion,
    viewState,
    size: canvasSize,
    colors,
    opacity: display.encoding.opacity,
    enabled: polygonsActive,
  });

  const layers = useMemo(() => {
    const result: Layer[] = [...imageLayers];

    if (showPoints && positions && colors) {
      // 'points' mode, or 'auto' before the field metadata arrives, or the
      // zoomed-in fallback when no polygon set is available: the classic scatter.
      const haveField = renderMode === 'auto' && cellField !== null;
      const useField = haveField && regime === 'field';
      const usePolygons = polygonsActive && polygonLayer !== null;
      // Just after crossing into the detail regime the polygons are still fetching
      // (polygonsActive but no layer yet); keep the field up until they arrive so
      // the switch is field -> polygons, never field -> points -> polygons.
      const fieldWhilePolygonsLoad = polygonsActive && polygonLayer === null && haveField;

      if (useField || fieldWhilePolygonsLoad) {
        result.push(buildCellFieldLayer(positions, colors, {
          radius: cellField.median_nn_world,
          opacity: display.encoding.opacity,
        }));
      } else if (usePolygons) {
        result.push(polygonLayer);
      } else {
        result.push(buildSpotLayer(positions, colors, {
          pointSize: display.encoding.point_size,
          opacity: display.encoding.opacity,
        }));
      }
    }

    return result;
  }, [imageLayers, positions, colors, showPoints, renderMode, cellField, regime,
      polygonsActive, polygonLayer, display.encoding.point_size, display.encoding.opacity]);

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Update the store mirror immediately, then debounce the PUT so rapid changes
  // (a slider drag, a pan) collapse into one write. A ref (not state) holds the timer
  // so back-to-back viewport events during a drag reliably reset the same debounce.
  function persistDisplay(updated: SpatialDisplaySpec) {
    updateDisplay(updated);
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      putDisplay(sessionId, updated).catch(console.error);
    }, 500);
  }

  // Build from the latest store spec, not the possibly-stale prop, so an encoding
  // edit and a viewport pan in the same debounce window don't clobber each other.
  function currentSpec(): SpatialDisplaySpec {
    const stored = useAppStore.getState().sessionState?.app_state.displays.find((d) => d.id === display.id);
    return stored && isSpatialDisplay(stored) ? stored : display;
  }

  function updateEncoding(patch: Partial<typeof display.encoding>) {
    const base = currentSpec();
    persistDisplay({ ...base, encoding: { ...base.encoding, ...patch } });
  }

  const SEL = canvasMode === 'annotate'
    ? [72, 187, 120] as [number, number, number]  // green for annotation
    : [124, 108, 246] as [number, number, number]; // accent purple for subset

  // Selection graphics are UI overlays that must always be visible: 'always' depth
  // compare so they aren't occluded by the cell-field layer, which writes a depth
  // below the z = 0 plane to resolve nearest-cell fill.
  const OVERLAY_PARAMS = { depthCompare: 'always' as const, depthWriteEnabled: false };
  const drawLayers: Layer[] = [];
  if (drawMode) {
    if (polygons.length) {
      drawLayers.push(new PolygonLayer<[number, number][]>({
        id: 'sel-polygons', data: polygons, getPolygon: (d) => d,
        filled: true, getFillColor: [...SEL, 50], stroked: true,
        getLineColor: [...SEL, 220], getLineWidth: 2, lineWidthUnits: 'pixels', pickable: false,
        parameters: OVERLAY_PARAMS,
      }));
    }
    if (currentRing.length >= 2) {
      drawLayers.push(new PathLayer<[number, number][]>({
        id: 'sel-path', data: [currentRing], getPath: (d) => d,
        getColor: [...SEL, 220], getWidth: 2, widthUnits: 'pixels',
        parameters: OVERLAY_PARAMS,
      }));
    }
    if (currentRing.length >= 1) {
      drawLayers.push(new ScatterplotLayer<[number, number]>({
        id: 'sel-verts', data: currentRing, getPosition: (d) => d,
        getFillColor: [...SEL, 255], getRadius: 4, radiusUnits: 'pixels',
        parameters: OVERLAY_PARAMS,
      }));
    }
  }

  const obsFields = fields?.obs ?? [];
  const layerNames = fields?.layers ?? [];
  const colorByName = colorByLabel(colorByPath);

  if (!viewState) {
    return (
      <div ref={containerRef} className="w-full h-full flex items-center justify-center bg-bg text-muted text-sm">
        {coordsLoading ? 'Loading spatial coordinates...' : 'Initializing canvas...'}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full relative bg-bg">
      <DeckGL
        views={VIEWS}
        viewState={viewState as unknown as Record<string, OrthographicViewState>}
        onViewStateChange={({ viewState: vs }) => {
          const v = vs as OrthographicViewState;
          setViewState(v);
          const t = v.target as number[];
          persistDisplay({ ...currentSpec(), viewport: { target: [t[0], t[1]], zoom: v.zoom as number } });
        }}
        layers={[...layers, ...drawLayers]}
        controller={drawMode ? { doubleClickZoom: false } : true}
        onClick={handleClick}
        getCursor={drawMode ? () => 'crosshair' : ({ isDragging }) => (isDragging ? 'grabbing' : 'grab')}
      />

      <LoadingCue coordsLoading={coordsLoading} colorLoading={colorLoading} tilesLoading={tilesLoading || polygonsLoading} />

      <ChannelLegend show={showImage} showLegend={showLegend} channels={channels} />

      <CellColorLegend visible={legendVisible && showPoints} legend={colorLegend} title={legendTitle} />

      <DrawHint drawMode={drawMode} canvasMode={canvasMode} annotationTarget={annotationTarget} />

      <CanvasControls
        display={display}
        sessionId={sessionId}
        obsFields={obsFields}
        layers={layerNames}
        colorByName={colorByName}
        legendVisible={legendVisible}
        updateEncoding={updateEncoding}
        showPoints={showPoints}
        setShowPoints={(v) => updateEncoding({ show_points: v })}
        showImage={showImage}
        setShowImage={(v) => updateEncoding({ show_image: v })}
        showLegend={showLegend}
        setShowLegend={(v) => updateEncoding({ show_channel_legend: v })}
        renderMode={renderMode}
        setRenderMode={(v) => updateEncoding({ render_mode: v })}
        shapeSets={polygonElements}
        shapesElement={shapesElement}
        setShapesElement={(v) => updateEncoding({ shapes_layer: v })}
        channels={channels}
        setChannel={setChannel}
        openColorPicker={openColorPicker}
        setOpenColorPicker={setOpenColorPicker}
        panelCollapsed={panelCollapsed}
        setPanelCollapsed={setPanelCollapsed}
        onFit={() => { const fit = fitToData(); if (fit) setViewState(fit); }}
        onEditTransform={() => setTransformOpen(true)}
      />

      {transformOpen && <TransformEditor sessionId={sessionId} onClose={() => setTransformOpen(false)} />}
    </div>
  );
}
