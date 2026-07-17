import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { ScatterplotLayer, PolygonLayer, PathLayer } from '@deck.gl/layers';
import type { Layer, OrthographicViewState, PickingInfo } from '@deck.gl/core';
import { useAppStore } from '../../store/sessionStore';
import { useArrowField } from '../../hooks/useArrowField';
import {
  getImageInfo, putDisplay, saveSnapshot, getCellField, getElements,
  createShapeAnnotation, updateShapeAnnotation, type CellFieldMeta,
} from '../../api';
import { reportError } from '../../lib/errors';
import TransformEditor from '../TransformEditor';
import { isSpatialDisplay, type SpatialDisplaySpec, type ImageInfo } from '../../types';
import type { ShapeAnnotation, ShapeGeometry, ShapeKind } from '../../schemas/annotations';
import { defaultStroke, defaultFill, textGeometryAt } from '../../schemas/annotations';
import { geometryFromDrag, trapezoidFromClicks, applyHandleDrag } from '../../lib/shapeAnnotations';
import { useArrowPositions } from './useArrowPositions';
import { useImageTiles } from './useImageTiles';
import { useCanvasViewState, cellZoomThreshold, ZOOM_HYSTERESIS } from './useCanvasViewState';
import { useSpotColors, arrowToColorSource } from './useSpotColors';
import { buildSpotLayer } from './buildSpotLayer';
import { buildCellFieldLayer } from './buildCellFieldLayer';
import { buildShapeAnnotationLayers, buildShapeHandleLayer, buildDragPreviewLayers } from './buildShapeAnnotationLayers';
import { usePolygonBbox } from './usePolygonBbox';
import { useImageChannels } from './useImageChannels';
import CanvasControls from './CanvasControls';
import { colorByLabel } from './colorBy';
import { LoadingCue, ChannelLegend, CellColorLegend, DrawHint } from './CanvasOverlays';

type Point = [number, number];
type ShapeDragTarget =
  | { kind: 'create'; tool: Exclude<ShapeKind, 'trapezoid' | 'text'>; start: Point }
  | { kind: 'handle'; shapeId: string; handleId: string };

const VIEWS = [new OrthographicView({ id: 'main', flipY: false })];

interface Props {
  display: SpatialDisplaySpec;
  sessionId: string;
  // 'regions' | 'shapes' | 'subset' | null — set by active sidebar tab; when null canvas is view-only
  canvasMode: 'regions' | 'shapes' | 'subset' | null;
  // Region-labeling config: which region set + category + color to label into
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

  // Shape-annotation editor state — the fetched list persists/renders regardless
  // of the active tab; the tool/selection/draft state only matters in 'shapes' mode.
  const {
    shapeAnnotations, activeShapeTool, selectedShapeId, draftVertices,
    setSelectedShapeId, addDraftVertex, clearDraft,
    upsertShapeAnnotation, removeShapeAnnotationLocal,
  } = useAppStore();
  // In-progress drag (creating a shape, or dragging a selected shape's handle) is
  // local: it changes on every pointer move and only this canvas renders it.
  const [shapeDragTarget, setShapeDragTarget] = useState<ShapeDragTarget | null>(null);
  const [shapeDragPreview, setShapeDragPreview] = useState<ShapeGeometry | null>(null);
  // Whether the cursor is over an edit handle. Tracked on hover (before any drag
  // begins) so pan can be disabled just for handle-dragging while background
  // drags in select mode still pan the plot — the controller reads dragPan at
  // panstart, so it must already be false by the time the drag gesture starts.
  const [overHandle, setOverHandle] = useState(false);

  // The lasso (click-to-add-vertex ring) interaction is shared by region-labeling
  // and subsetting; the shape-annotation editor (canvasMode === 'shapes') uses a
  // separate drag/handle interaction — see useShapeAnnotations/ShapeAnnotationLayers.
  const lassoMode = canvasMode === 'regions' || canvasMode === 'subset';
  const shapesMode = canvasMode === 'shapes';
  const drawMode = lassoMode || shapesMode;
  // Pan is suppressed only while actively drawing (a tool armed) or dragging a
  // handle (or hovering one, about to). With no tool armed and not over a handle,
  // dragging pans the plot as usual — the Annotations tab being open no longer
  // blocks panning on its own.
  const shapeInteracting = shapesMode && (activeShapeTool !== null || overHandle || shapeDragTarget !== null);

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
    clearDraft();
    setSelectedShapeId(null);
    setShapeDragTarget(null);
    setShapeDragPreview(null);
  }, [canvasMode, clearDraw, clearDraft, setSelectedShapeId]);

  const commitNewShape = useCallback((geometry: ShapeGeometry) => {
    const shape: ShapeAnnotation = {
      id: crypto.randomUUID(),
      geometry,
      stroke: defaultStroke(),
      // Line and text have no interior to fill.
      fill: geometry.kind === 'line' || geometry.kind === 'text' ? undefined : defaultFill(),
    };
    upsertShapeAnnotation(shape); // optimistic — the job.completed refetch reconciles
    createShapeAnnotation(sessionId, shape)
      .catch((err) => { reportError('Create shape failed', err); removeShapeAnnotationLocal(shape.id); });
    setSelectedShapeId(shape.id); // also clears activeShapeTool (see store)
  }, [sessionId, upsertShapeAnnotation, removeShapeAnnotationLocal, setSelectedShapeId]);

  const handleClick = useCallback((info: PickingInfo) => {
    if (lassoMode && info.coordinate) {
      addDrawVertex([info.coordinate[0], info.coordinate[1]]);
      return;
    }
    if (!shapesMode || !info.coordinate) return;
    const pt: Point = [info.coordinate[0], info.coordinate[1]];

    if (activeShapeTool === 'trapezoid') {
      const next = [...draftVertices, pt];
      const geometry = trapezoidFromClicks(next);
      if (geometry) {
        commitNewShape(geometry);
        clearDraft();
      } else {
        addDraftVertex(pt);
      }
      return;
    }

    if (activeShapeTool === 'text') {
      commitNewShape(textGeometryAt(pt));
      return;
    }

    if (!activeShapeTool) {
      // Select mode: click a shape's fill/stroke/text to select it, empty space to deselect.
      const hit = info.layer?.id === 'shape-fill' || info.layer?.id === 'shape-stroke' || info.layer?.id === 'shape-text'
        ? (info.object as ShapeAnnotation | undefined)?.id
        : undefined;
      setSelectedShapeId(hit ?? null);
    }
  }, [lassoMode, shapesMode, activeShapeTool, draftVertices, addDrawVertex, addDraftVertex,
      clearDraft, commitNewShape, setSelectedShapeId]);

  const handleShapeDragStart = useCallback((info: PickingInfo) => {
    if (!shapesMode || !info.coordinate) return;
    const pt: Point = [info.coordinate[0], info.coordinate[1]];
    // Trapezoid and text are click-placed (see handleClick), not drag-created.
    if (activeShapeTool && activeShapeTool !== 'trapezoid' && activeShapeTool !== 'text') {
      setShapeDragTarget({ kind: 'create', tool: activeShapeTool, start: pt });
      setShapeDragPreview(geometryFromDrag(activeShapeTool, pt, pt));
      return;
    }
    if (!activeShapeTool && info.layer?.id === 'shape-handles' && info.object) {
      const handle = info.object as { id: string };
      const shape = shapeAnnotations.find((s) => s.id === selectedShapeId);
      if (!shape) return;
      setShapeDragTarget({ kind: 'handle', shapeId: shape.id, handleId: handle.id });
      setShapeDragPreview(shape.geometry);
    }
  }, [shapesMode, activeShapeTool, shapeAnnotations, selectedShapeId]);

  const handleHover = useCallback((info: PickingInfo) => {
    setOverHandle(info.layer?.id === 'shape-handles');
  }, []);

  const handleShapeDrag = useCallback((info: PickingInfo) => {
    if (!shapeDragTarget || !info.coordinate) return;
    const pt: Point = [info.coordinate[0], info.coordinate[1]];
    if (shapeDragTarget.kind === 'create') {
      setShapeDragPreview(geometryFromDrag(shapeDragTarget.tool, shapeDragTarget.start, pt));
    } else {
      setShapeDragPreview((prev) => (prev ? applyHandleDrag(prev, shapeDragTarget.handleId, pt) : prev));
    }
  }, [shapeDragTarget]);

  const handleShapeDragEnd = useCallback(() => {
    if (!shapeDragTarget || !shapeDragPreview) { setShapeDragTarget(null); setShapeDragPreview(null); return; }
    if (shapeDragTarget.kind === 'create') {
      commitNewShape(shapeDragPreview);
    } else {
      const shape = shapeAnnotations.find((s) => s.id === shapeDragTarget.shapeId);
      if (shape) {
        const updated: ShapeAnnotation = { ...shape, geometry: shapeDragPreview };
        upsertShapeAnnotation(updated);
        updateShapeAnnotation(sessionId, shape.id, updated)
          .catch((err) => reportError('Update shape failed', err));
      }
    }
    setShapeDragTarget(null);
    setShapeDragPreview(null);
  }, [shapeDragTarget, shapeDragPreview, shapeAnnotations, sessionId, commitNewShape, upsertShapeAnnotation]);

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

  const SEL = canvasMode === 'regions'
    ? [72, 187, 120] as [number, number, number]  // green for region labeling
    : [124, 108, 246] as [number, number, number]; // accent purple for subset

  // Selection graphics are UI overlays that must always be visible: 'always' depth
  // compare so they aren't occluded by the cell-field layer, which writes a depth
  // below the z = 0 plane to resolve nearest-cell fill.
  const OVERLAY_PARAMS = { depthCompare: 'always' as const, depthWriteEnabled: false };
  const drawLayers: Layer[] = [];
  if (lassoMode) {
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

  // Shape annotations render whenever they exist, independent of the active tab;
  // the drag-in-progress override keeps the persisted-shape layer showing the
  // live position instead of stale data while a handle is being dragged.
  const shapeOverrides = shapeDragTarget?.kind === 'handle' && shapeDragPreview
    ? { [shapeDragTarget.shapeId]: shapeDragPreview }
    : {};
  // OrthographicView scale = 2^zoom, so one screen pixel spans 2^-zoom world units.
  const shapeLayers = buildShapeAnnotationLayers(shapeAnnotations, shapeOverrides, Math.pow(2, -zoom));

  if (shapesMode) {
    const selectedShape = shapeAnnotations.find((s) => s.id === selectedShapeId);
    const handleGeometry = shapeDragTarget?.kind === 'handle' ? shapeDragPreview : selectedShape?.geometry;
    if (selectedShape && handleGeometry) {
      shapeLayers.push(...buildShapeHandleLayer(handleGeometry, Math.pow(2, -zoom)));
    }
    if (shapeDragTarget?.kind === 'create' && shapeDragPreview) {
      shapeLayers.push(...buildDragPreviewLayers(shapeDragPreview));
    }
    if (activeShapeTool === 'trapezoid' && draftVertices.length >= 1) {
      if (draftVertices.length >= 2) {
        shapeLayers.push(new PathLayer<Point[]>({
          id: 'shape-draft-path', data: [draftVertices], getPath: (d) => d,
          getColor: [51, 136, 255, 220], getWidth: 2, widthUnits: 'pixels', parameters: OVERLAY_PARAMS,
        }));
      }
      shapeLayers.push(new ScatterplotLayer<Point>({
        id: 'shape-draft-verts', data: draftVertices, getPosition: (d) => d,
        getFillColor: [51, 136, 255, 255], getRadius: 4, radiusUnits: 'pixels', parameters: OVERLAY_PARAMS,
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
        layers={[...layers, ...drawLayers, ...shapeLayers]}
        controller={shapeInteracting ? { dragPan: false, doubleClickZoom: false } : drawMode ? { doubleClickZoom: false } : true}
        onClick={handleClick}
        onHover={shapesMode ? handleHover : undefined}
        onDragStart={handleShapeDragStart}
        onDrag={handleShapeDrag}
        onDragEnd={handleShapeDragEnd}
        getCursor={shapeInteracting && !overHandle ? () => 'crosshair' : lassoMode ? () => 'crosshair' : ({ isDragging }) => (isDragging ? 'grabbing' : 'grab')}
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
