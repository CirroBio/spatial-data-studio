import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, PolygonLayer, PathLayer } from '@deck.gl/layers';
import { LinearInterpolator } from '@deck.gl/core';
import type { Layer, OrthographicViewState, PickingInfo } from '@deck.gl/core';
import { useAppStore } from '../../store/sessionStore';
import { useArrowField } from '../../hooks/useArrowField';
import {
  getImageInfo, putDisplay, saveSnapshot, getElements,
  updateShapeAnnotation, fetchWhenIdle,
} from '../../api';
import { reportError } from '../../lib/errors';
import { countPointsInRings } from '../../lib/pointInPolygon';
import TransformEditor from '../TransformEditor';
import { isSpatialDisplay, type SpatialDisplaySpec, type ImageInfo } from '../../types';
import type { ShapeAnnotation, ShapeGeometry, ShapeKind } from '../../schemas/annotations';
import { textGeometryAt } from '../../schemas/annotations';
import { geometryFromDrag, applyHandleDrag, translateGeometry } from '../../lib/shapeAnnotations';
import { useArrowPositions } from './useArrowPositions';
import { useVivImageLayer } from './useVivImageLayer';
import { useCanvasViewState, shapesFetchZoomThreshold } from './useCanvasViewState';
import { ZOOM_LIMITS, ZOOM_STEP } from './viewFit';
import { useSpotColors, arrowToColorSource } from './useSpotColors';
import { Matrix4 } from '@math.gl/core';
import { worldToPixelAffine, affineScale, wx, wy } from './imageAffine';
import { buildSpotLayer, estimateMeanSpacing } from './buildSpotLayer';
import { PLOT_BACKGROUNDS } from './colorUtils';
import { buildShapeAnnotationLayers, buildShapeHandleLayer, buildDragPreviewLayers } from './buildShapeAnnotationLayers';
import { usePolygonBbox } from './usePolygonBbox';
import { useImageChannels } from './useImageChannels';
import CanvasControls from './CanvasControls';
import { FlipOrthographicView } from './FlipOrthographicView';
import { colorByLabel } from './colorBy';
import { LoadingCue, ChannelLegend, CellColorLegend, DrawHint } from './CanvasOverlays';

// Animate zoom-button clicks so the level eases to the target instead of snapping.
// Matches the axes deck's OrthographicController interpolates for its own transitions.
const ZOOM_TRANSITION = new LinearInterpolator(['target', 'zoomX', 'zoomY']);
const ZOOM_TRANSITION_MS = 250;

type Point = [number, number];
type ShapeDragTarget =
  | { kind: 'create'; tool: Exclude<ShapeKind, 'polygon' | 'text'>; start: Point }
  | { kind: 'handle'; shapeId: string; handleId: string }
  | { kind: 'translate'; shapeId: string; start: Point; origin: ShapeGeometry };

interface Props {
  display: SpatialDisplaySpec;
  sessionId: string;
  // 'regions' | 'shapes' | 'subset' | null — set by active sidebar tab; when null canvas is view-only
  canvasMode: 'regions' | 'shapes' | 'subset' | null;
  // Region-labeling config: which region set + category + color to label into
  annotationTarget: { regionSetId: string; category: string; color: string } | null;
}

export default function SpatialCanvas({ display, sessionId, canvasMode, annotationTarget }: Props) {
  const { sessionState, updateDisplay, isolatedCategory, pushNotification, openSnapshots, setSnapshotHandler, theme } = useAppStore();
  const fields = sessionState?.fields;
  const dataVersions = sessionState?.data_versions ?? {};
  const readOnly = sessionState?.summary.read_only ?? false;

  const coordsPath = display.encoding.coords;
  const coordsVersion = dataVersions[coordsPath] ?? 0;
  const colorByPath = display.encoding.color_by;
  const colorVersion = dataVersions[colorByPath] ?? 0;

  const { table: coordsTable, loading: coordsLoading } = useArrowField(sessionId, coordsPath, coordsVersion);
  const { table: colorTable, loading: colorLoading } = useArrowField(sessionId, colorByPath, colorVersion);

  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);

  // When the display has an image, the canvas works in that image's pixel coordinate
  // space so Viv's MultiscaleImageLayer renders natively (the image sits at its own
  // [0,0,W,H] extent, no modelMatrix). The cell points and every other world-space
  // overlay (shapes, lasso, regions) get this world->pixel modelMatrix instead, and
  // picked coordinates are mapped back to world via `toWorld`. `pixelAffine` is null
  // when there is no image → the canvas stays in world space and all this is identity.
  // Keyed on the image's presence (not `showImage`) so toggling image visibility never
  // reframes the scene. Note: point radii are in world units, so `radiusScale`
  // (= px per world unit) rescales them into the pixel frame.
  const pixelAffine = (display.encoding.image_layer && imageInfo?.pixel_to_world) || null;
  const worldToPixelMat = useMemo(() => {
    if (!pixelAffine) return undefined;
    const [A, B, C, D, E, F] = worldToPixelAffine(pixelAffine);
    return new Matrix4([A, D, 0, 0, B, E, 0, 0, 0, 0, 1, 0, C, F, 0, 1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pixelAffine?.join(',')]);
  const radiusScale = pixelAffine ? 1 / affineScale(pixelAffine) : 1;
  const toWorld = useCallback(
    (c: number[]): [number, number] =>
      (pixelAffine ? [wx(pixelAffine, c[0], c[1]), wy(pixelAffine, c[0], c[1])] : [c[0], c[1]]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pixelAffine?.join(',')],
  );

  // Layer-visibility toggles are persisted in the display encoding (fall back to the
  // historical defaults when a checkpoint predates these fields).
  const showPoints = display.encoding.show_points ?? true;
  const showImage = display.encoding.show_image ?? (display.encoding.image_layer !== null);
  const showLegend = display.encoding.show_channel_legend ?? true;
  // View orientation + backdrop. Both flips live in the camera (FlipOrthographicView),
  // so picking/drawing stay consistent; the backdrop follows the app theme until the
  // user pins one explicitly.
  const invertX = display.encoding.invert_x ?? false;
  const invertY = display.encoding.invert_y ?? false;
  const bg = display.encoding.background ?? theme;
  const views = useMemo(
    () => [new FlipOrthographicView({ id: 'main', flipX: invertX, flipY: invertY })],
    [invertX, invertY],
  );
  const [transformOpen, setTransformOpen] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  // Polygon draw state lives in the store so the active tab's left panel owns the
  // commit / apply / clear actions; the canvas is purely the drawing surface.
  const { drawPolygons: polygons, drawRing: currentRing, addDrawVertex, clearDraw, setRegionCellCount, setRegionCellIndices } = useAppStore();

  // Shape-annotation editor state — the fetched list persists/renders regardless
  // of the active tab; the tool/selection/draft state only matters in 'shapes' mode.
  const {
    shapeAnnotations, activeShapeTool, selectedShapeId, draftVertices,
    setSelectedShapeId, addDraftVertex, clearDraft,
    upsertShapeAnnotation, commitNewShape,
  } = useAppStore();
  // In-progress drag (creating a shape, or dragging a selected shape's handle) is
  // local: it changes on every pointer move and only this canvas renders it.
  const [shapeDragTarget, setShapeDragTarget] = useState<ShapeDragTarget | null>(null);
  const [shapeDragPreview, setShapeDragPreview] = useState<ShapeGeometry | null>(null);
  // Whether the cursor is over an edit handle, or over the selected shape's body
  // (which a drag would move). Tracked on hover (before any drag begins) so pan
  // can be disabled just for that gesture while background drags in select mode
  // still pan the plot — the controller reads dragPan at panstart, so it must
  // already be false by the time the drag gesture starts.
  const [overHandle, setOverHandle] = useState(false);
  const [overBody, setOverBody] = useState(false);

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
  const shapeInteracting = shapesMode && (activeShapeTool !== null || overHandle || overBody || shapeDragTarget !== null);

  const positions = useArrowPositions(coordsTable);

  // Count cells inside the drawn region (union of committed rings + the closeable
  // in-progress ring) so the Regions/Subset action buttons can show n=…. Points and
  // rings are both in world coords (draw captures apply toWorld), so the test is direct.
  useEffect(() => {
    const rings = currentRing.length >= 3 ? [...polygons, currentRing] : polygons;
    setRegionCellCount(positions ? countPointsInRings(positions.positions, positions.numRows, rings) : 0);
    setRegionCellIndices(null);  // spatial resolves the lasso server-side via polygon_query
  }, [positions, polygons, currentRing, setRegionCellCount, setRegionCellIndices]);

  const { containerRef, canvasSize, viewState, setViewState, fitToData } = useCanvasViewState({
    positions,
    imageInfo,
    showImage,
    display,
  });

  const { channels, setChannel, maxVisibleReached } = useImageChannels({
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

  const handleClick = useCallback((info: PickingInfo) => {
    if (lassoMode && info.coordinate) {
      addDrawVertex(toWorld(info.coordinate));
      return;
    }
    if (!shapesMode || !info.coordinate) return;
    const pt: Point = toWorld(info.coordinate);

    if (activeShapeTool === 'polygon') {
      // Each click drops a vertex; the shape is committed by the panel's Close
      // Shape button (see AnnotationsPanel / commitNewShape).
      addDraftVertex(pt);
      return;
    }

    if (activeShapeTool === 'text') {
      const vs = viewStateRef.current;
      const z = vs ? (Array.isArray(vs.zoom) ? vs.zoom[0] : vs.zoom) ?? 0 : 0;
      commitNewShape(textGeometryAt(pt, Math.pow(2, -z)));
      return;
    }

    if (!activeShapeTool) {
      // Select mode: click a shape's fill/stroke/text to select it, empty space to deselect.
      const hit = info.layer?.id === 'shape-fill' || info.layer?.id === 'shape-stroke' || info.layer?.id === 'shape-text'
        ? (info.object as ShapeAnnotation | undefined)?.id
        : undefined;
      setSelectedShapeId(hit ?? null);
    }
  }, [lassoMode, shapesMode, activeShapeTool, addDrawVertex, addDraftVertex,
      commitNewShape, setSelectedShapeId, toWorld]);

  // True when the pick hits the currently selected shape's body (its fill,
  // stroke, or text glyph) — the surface a drag translates.
  const isSelectedBody = useCallback((info: PickingInfo) => {
    if (!selectedShapeId) return false;
    const id = info.layer?.id;
    if (id !== 'shape-fill' && id !== 'shape-stroke' && id !== 'shape-text') return false;
    return (info.object as ShapeAnnotation | undefined)?.id === selectedShapeId;
  }, [selectedShapeId]);

  const handleShapeDragStart = useCallback((info: PickingInfo) => {
    if (!shapesMode || !info.coordinate) return;
    const pt: Point = toWorld(info.coordinate);
    // Polygon and text are click-placed (see handleClick), not drag-created.
    if (activeShapeTool && activeShapeTool !== 'polygon' && activeShapeTool !== 'text') {
      setShapeDragTarget({ kind: 'create', tool: activeShapeTool, start: pt });
      setShapeDragPreview(geometryFromDrag(activeShapeTool, pt, pt));
      return;
    }
    if (activeShapeTool) return;
    if (info.layer?.id === 'shape-handles' && info.object) {
      const handle = info.object as { id: string };
      const shape = shapeAnnotations.find((s) => s.id === selectedShapeId);
      if (!shape) return;
      setShapeDragTarget({ kind: 'handle', shapeId: shape.id, handleId: handle.id });
      setShapeDragPreview(shape.geometry);
      return;
    }
    // Dragging the selected shape's body (fill/stroke/text) moves the whole shape.
    if (isSelectedBody(info)) {
      const shape = shapeAnnotations.find((s) => s.id === selectedShapeId)!;
      setShapeDragTarget({ kind: 'translate', shapeId: shape.id, start: pt, origin: shape.geometry });
      setShapeDragPreview(shape.geometry);
    }
  }, [shapesMode, activeShapeTool, shapeAnnotations, selectedShapeId, isSelectedBody, toWorld]);

  const handleHover = useCallback((info: PickingInfo) => {
    setOverHandle(info.layer?.id === 'shape-handles');
    setOverBody(isSelectedBody(info));
  }, [isSelectedBody]);

  const handleShapeDrag = useCallback((info: PickingInfo) => {
    if (!shapeDragTarget || !info.coordinate) return;
    const pt: Point = toWorld(info.coordinate);
    if (shapeDragTarget.kind === 'create') {
      setShapeDragPreview(geometryFromDrag(shapeDragTarget.tool, shapeDragTarget.start, pt));
    } else if (shapeDragTarget.kind === 'translate') {
      setShapeDragPreview(translateGeometry(shapeDragTarget.origin, pt[0] - shapeDragTarget.start[0], pt[1] - shapeDragTarget.start[1]));
    } else {
      setShapeDragPreview((prev) => (prev ? applyHandleDrag(prev, shapeDragTarget.handleId, pt) : prev));
    }
  }, [shapeDragTarget, toWorld]);

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

  // Load image info. Retry a transient 503 (session busy — the async checkpoint load
  // holds the write lock on first open) so the image layer materializes once the lock
  // frees; without this a single 503 here leaves imageInfo null and the image blank,
  // since nothing else re-runs this effect after the session becomes ready.
  useEffect(() => {
    const element = display.encoding.image_layer;
    if (!element || !sessionId) return;
    const controller = new AbortController();
    fetchWhenIdle(() => getImageInfo(sessionId, element), { signal: controller.signal })
      .then((info) => { if (!controller.signal.aborted) setImageInfo(info); })
      .catch((err) => { if (!controller.signal.aborted) console.error(err); });
    return () => controller.abort();
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

  // GPU-composited image via Viv (the sole image path). While the pyramid loads,
  // Viv renders its own coarse low-res background and streams detail as tiles arrive.
  const { layers: vivLayers } = useVivImageLayer({
    imageInfo,
    element: display.encoding.image_layer,
    channels,
    viewState,
    size: canvasSize,
    show: showImage,
  });

  // How the Cells layer renders. Points always draw; 'points+shapes' additionally
  // overlays the cell-boundary fills once zoomed in far enough that the viewport
  // fits. The old 'shapes' value (points replaced by outlines) maps to 'points+shapes';
  // anything else (or a stale value from an older session) is points-only.
  const renderMode: 'points' | 'points+shapes' =
    display.encoding.render_mode === 'points+shapes' || display.encoding.render_mode === 'shapes'
      ? 'points+shapes' : 'points';
  const marker = display.encoding.point_marker ?? 'circle';
  // Cell-boundary overlay style: filled polygons (default) or boundary-only strokes.
  const boundaryOutline = (display.encoding.boundary_style ?? 'filled') === 'outline';
  const boundaryLineWidth = display.encoding.boundary_line_width ?? 1;

  // Polygon shape sets available for this session (elements inventory filtered to
  // polygonal geom types). Empty → the whole shapes path stays dormant.
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

  // Shapes overlay: cell-boundary fills drawn on top of the points once zoomed in.
  // The outlines are viewport-culled and the backend serves nothing when the viewport
  // holds more than it can ship, so the fetch is deferred until a cell is big enough
  // on screen (shapesFetchZoomThreshold); below that the points are the whole view.
  const meanSpacing = useMemo(() => (positions ? estimateMeanSpacing(positions) : 0), [positions]);
  // `zoom` is in the canvas coordinate space (image-pixel when an image is shown), so
  // scale the world-unit mean spacing into that space (radiusScale = px per world unit;
  // 1 in world space) before deciding when cells are big enough on screen to fetch shapes.
  const zoomedInForShapes = meanSpacing > 0 && zoom >= shapesFetchZoomThreshold(meanSpacing * radiusScale);
  const shapesOverlay = renderMode === 'points+shapes' && shapesElement !== null;
  const { layer: polygonLayer, loading: polygonsLoading } = usePolygonBbox({
    sessionId,
    element: shapesElement,
    version: coordsVersion,
    viewState,
    size: canvasSize,
    colors,
    opacity: display.encoding.opacity,
    outline: boundaryOutline,
    lineWidth: boundaryLineWidth,
    enabled: shapesOverlay && showPoints && zoomedInForShapes,
    modelMatrix: worldToPixelMat,
    pixelToWorld: pixelAffine ?? undefined,
  });

  const layers = useMemo(() => {
    // Viv GPU-composites the image (no-depth params so points always draw over it).
    const result: Layer[] = [...vivLayers];

    if (showPoints && positions && colors) {
      // In 'points+shapes', the cell-boundary fills replace the points once loaded;
      // the points are the fallback for the zoomed-out regime and the shapes
      // over-budget/loading bands, so the Cells layer never blanks.
      if (shapesOverlay && polygonLayer) {
        result.push(polygonLayer);
      } else {
        result.push(...buildSpotLayer(positions, colors, {
          pointSize: display.encoding.point_size,
          opacity: display.encoding.opacity,
          marker,
          modelMatrix: worldToPixelMat,
          radiusScale,
        }));
      }
    }

    return result;
  }, [vivLayers, positions, colors, showPoints, shapesOverlay, polygonLayer,
      display.encoding.point_size, display.encoding.opacity, marker, worldToPixelMat, radiusScale]);

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Update the store mirror immediately, then debounce the PUT so rapid changes
  // (a slider drag, a pan) collapse into one write. A ref (not state) holds the timer
  // so back-to-back viewport events during a drag reliably reset the same debounce.
  // A read-only (snapshot) session keeps the camera/encoding interactive locally but
  // never persists — the backend would 403 the PUT anyway (session.read_only).
  function persistDisplay(updated: SpatialDisplaySpec) {
    updateDisplay(updated);
    if (readOnly) return;
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
  // compare so they aren't occluded by any cell layer that writes depth.
  const OVERLAY_PARAMS = { depthCompare: 'always' as const, depthWriteEnabled: false };
  const drawLayers: Layer[] = [];
  if (lassoMode) {
    if (polygons.length) {
      drawLayers.push(new PolygonLayer<[number, number][]>({
        id: 'sel-polygons', data: polygons, getPolygon: (d) => d,
        filled: true, getFillColor: [...SEL, 50], stroked: true,
        getLineColor: [...SEL, 220], getLineWidth: 2, lineWidthUnits: 'pixels', pickable: false,
        parameters: OVERLAY_PARAMS, modelMatrix: worldToPixelMat,
      }));
    }
    if (currentRing.length >= 2) {
      drawLayers.push(new PathLayer<[number, number][]>({
        id: 'sel-path', data: [currentRing], getPath: (d) => d,
        getColor: [...SEL, 220], getWidth: 2, widthUnits: 'pixels',
        parameters: OVERLAY_PARAMS, modelMatrix: worldToPixelMat,
      }));
    }
    if (currentRing.length >= 1) {
      drawLayers.push(new ScatterplotLayer<[number, number]>({
        id: 'sel-verts', data: currentRing, getPosition: (d) => d,
        getFillColor: [...SEL, 255], getRadius: 4, radiusUnits: 'pixels',
        parameters: OVERLAY_PARAMS, modelMatrix: worldToPixelMat,
      }));
    }
  }

  // Shape annotations render whenever they exist, independent of the active tab;
  // the drag-in-progress override keeps the persisted-shape layer showing the
  // live position instead of stale data while a handle is being dragged.
  const shapeOverrides = (shapeDragTarget?.kind === 'handle' || shapeDragTarget?.kind === 'translate') && shapeDragPreview
    ? { [shapeDragTarget.shapeId]: shapeDragPreview }
    : {};
  // OrthographicView scale = 2^zoom, so one screen pixel spans 2^-zoom canvas units.
  // In image-pixel space those are pixel units; divide by radiusScale (px per world
  // unit) to get world units per screen pixel for the arrowhead's world-space geometry.
  const worldPerScreenPixel = Math.pow(2, -zoom) / radiusScale;
  const shapeLayers = buildShapeAnnotationLayers(shapeAnnotations, shapeOverrides, worldPerScreenPixel, worldToPixelMat, radiusScale);

  if (shapesMode) {
    const selectedShape = shapeAnnotations.find((s) => s.id === selectedShapeId);
    const handleGeometry = (shapeDragTarget?.kind === 'handle' || shapeDragTarget?.kind === 'translate')
      ? shapeDragPreview : selectedShape?.geometry;
    if (selectedShape && handleGeometry) {
      shapeLayers.push(...buildShapeHandleLayer(handleGeometry, worldToPixelMat));
    }
    if (shapeDragTarget?.kind === 'create' && shapeDragPreview) {
      shapeLayers.push(...buildDragPreviewLayers(shapeDragPreview, worldToPixelMat));
    }
    if (activeShapeTool === 'polygon' && draftVertices.length >= 1) {
      if (draftVertices.length >= 2) {
        shapeLayers.push(new PathLayer<Point[]>({
          id: 'shape-draft-path', data: [draftVertices], getPath: (d) => d,
          getColor: [51, 136, 255, 220], getWidth: 2, widthUnits: 'pixels', parameters: OVERLAY_PARAMS, modelMatrix: worldToPixelMat,
        }));
      }
      shapeLayers.push(new ScatterplotLayer<Point>({
        id: 'shape-draft-verts', data: draftVertices, getPosition: (d) => d,
        getFillColor: [51, 136, 255, 255], getRadius: 4, radiusUnits: 'pixels', parameters: OVERLAY_PARAMS, modelMatrix: worldToPixelMat,
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
    <div ref={containerRef} className="w-full h-full relative" style={{ backgroundColor: PLOT_BACKGROUNDS[bg] }}>
      <DeckGL
        views={views}
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
        getCursor={
          overBody || shapeDragTarget?.kind === 'translate' ? () => 'move'
          : shapeInteracting && !overHandle ? () => 'crosshair'
          : lassoMode ? () => 'crosshair'
          : ({ isDragging }) => (isDragging ? 'grabbing' : 'grab')
        }
      />

      <LoadingCue coordsLoading={coordsLoading} colorLoading={colorLoading} tilesLoading={polygonsLoading} />

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
        invertX={invertX}
        setInvertX={(v) => updateEncoding({ invert_x: v })}
        invertY={invertY}
        setInvertY={(v) => updateEncoding({ invert_y: v })}
        background={bg}
        setBackground={(v) => updateEncoding({ background: v })}
        showLegend={showLegend}
        setShowLegend={(v) => updateEncoding({ show_channel_legend: v })}
        renderMode={renderMode}
        setRenderMode={(v) => updateEncoding({ render_mode: v })}
        shapeSets={polygonElements}
        shapesElement={shapesElement}
        setShapesElement={(v) => updateEncoding({ shapes_layer: v })}
        channels={channels}
        setChannel={setChannel}
        maxVisibleReached={maxVisibleReached}
        panelCollapsed={panelCollapsed}
        setPanelCollapsed={setPanelCollapsed}
        zoom={zoom}
        onZoom={(dir) => {
          const next = Math.max(ZOOM_LIMITS.minZoom, Math.min(ZOOM_LIMITS.maxZoom, zoom + dir * ZOOM_STEP));
          const t = viewState.target as number[];
          // A wheel zoom leaves deck's per-axis zoomX/zoomY on the view state, and
          // those override `zoom` — so a button update that set only `zoom` would be
          // ignored. Write the new scalar into all three to keep them consistent.
          const updated = {
            ...viewState, zoom: next, zoomX: next, zoomY: next,
            transitionDuration: ZOOM_TRANSITION_MS, transitionInterpolator: ZOOM_TRANSITION,
          };
          setViewState(updated);
          persistDisplay({ ...currentSpec(), viewport: { target: [t[0], t[1]], zoom: next } });
        }}
        onFit={() => { const fit = fitToData(); if (fit) setViewState(fit); }}
        onEditTransform={() => setTransformOpen(true)}
      />

      {transformOpen && <TransformEditor sessionId={sessionId} onClose={() => setTransformOpen(false)} />}
    </div>
  );
}
