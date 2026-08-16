import { useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { LinearInterpolator } from '@deck.gl/core';
import type { Layer, OrthographicViewState, PickingInfo } from '@deck.gl/core';
import { useDataSource } from '../data/context';
import { useArrowField } from '../data/useArrowField';
import { fetchWhenIdle } from '../lib/fetchWhenIdle';
import { countPointsInRings, indicesInRings } from '../lib/pointInPolygon';
import { reportError } from '../lib/errors';
import { isSpatialDisplay, type SpatialDisplaySpec, type ImageInfo, type ObsField, type Viewport } from '../types';
import { useCanvasHost, useDisplayEditor } from './canvas-host';
import type { ShapeAnnotation, ShapeGeometry, ShapeKind } from '../schemas/annotations';
import { textGeometryAt } from '../schemas/annotations';
import { geometryFromDrag, applyHandleDrag, translateGeometry } from '../lib/shapeAnnotations';
import { useArrowPositions } from './useArrowPositions';
import { useVivImageLayer } from './useVivImageLayer';
import { useCanvasViewState, shapesFetchZoomThreshold } from './useCanvasViewState';
import { ZOOM_LIMITS, ZOOM_STEP } from './viewFit';
import { useSpotColors, arrowToColorSource } from './useSpotColors';
import { Matrix4 } from '@math.gl/core';
import { worldToPixelAffine, affineScale, wx, wy } from './imageAffine';
import { buildSpotLayer, estimateMeanSpacing } from './buildSpotLayer';
import { PLOT_BACKGROUNDS, SELECTION_COLORS, rgbToHex } from './colorUtils';
import { buildShapeAnnotationLayers, buildShapeHandleLayer, buildDragPreviewLayers } from './buildShapeAnnotationLayers';
import { buildLassoLayers } from './buildLassoLayers';
import { useColorField } from './useColorField';
import { useSnapshotHandler } from './useSnapshotHandler';
import { usePolygonBbox } from './usePolygonBbox';
import { useImageChannels, type Channel, type ChannelPatch } from './useImageChannels';
import Minimap from './Minimap';
import { FlipOrthographicView } from './FlipOrthographicView';
import { colorByLabel } from './colorBy';
import { LoadingCue, ChannelLegend, CellColorLegend, DrawHint, ImageTileStatus } from './CanvasOverlays';
import { CANVAS_PLACEHOLDER, CANVAS_ROOT } from './overlayStyles';
import { SPATIAL_ENCODING_DEFAULTS, showImageDefault } from '../defaults';

// Animate zoom-button clicks so the level eases to the target instead of snapping.
// Matches the axes deck's OrthographicController interpolates for its own transitions.
const ZOOM_TRANSITION = new LinearInterpolator(['target', 'zoomX', 'zoomY']);
const ZOOM_TRANSITION_MS = 250;

// Resolution of the whole-image overview fetched for the minimap inset (drawn at
// most 160 CSS px across, so this covers a retina display with room to spare).
const MINIMAP_THUMB_PX = 384;

// Stable empties for the optional host features, so a host without them doesn't hand
// the memos and effects below a fresh array on every render.
const NO_POLYGONS: [number, number][][] = [];
const NO_POINTS: [number, number][] = [];
const NO_SHAPES: ShapeAnnotation[] = [];

type Point = [number, number];
type ShapeDragTarget =
  | { kind: 'create'; tool: Exclude<ShapeKind, 'polygon' | 'text'>; start: Point }
  | { kind: 'handle'; shapeId: string; handleId: string }
  | { kind: 'translate'; shapeId: string; start: Point; origin: ShapeGeometry };

/** Everything an in-canvas control panel needs that only the mounted canvas knows:
 * the resolved channel list, the live camera, the legend's categorical levels, and
 * the polygon element inventory. The Studio app renders `CanvasControls` from this;
 * a dashboard passes no `controls` and gets a bare canvas. */
export interface SpatialCanvasControls {
  display: SpatialDisplaySpec;
  obsFields: ObsField[];
  layers: string[];
  colorByName: string;
  legendVisible: boolean;
  updateEncoding: (patch: Partial<SpatialDisplaySpec['encoding']>) => void;
  // Categorical levels + effective hex color for the per-category color controls;
  // null unless the current color-by field is categorical (within the level cap).
  categoryColorItems: { label: string; color: string }[] | null;
  hasCategoryOverrides: boolean;
  setCategoryColor: (label: string, color: string) => void;
  resetCategoryColors: () => void;
  showPoints: boolean;
  showImage: boolean;
  invertX: boolean;
  invertY: boolean;
  background: 'light' | 'dark';
  showLegend: boolean;
  showMinimap: boolean;
  renderMode: 'points' | 'points+shapes';
  shapeSets: string[];
  shapesElement: string | null;
  channels: Channel[];
  setChannel: (index: number, patch: ChannelPatch) => void;
  maxVisibleReached: boolean;
  zoom: number;
  onZoom: (delta: number) => void;
  onFit: () => void;
  onEditTransform?: () => void;
  // False when this viewer can't change the session (read-only snapshot, or another
  // viewer holds the edit lock): everything else here is a display setting that stays
  // on this screen, but the transform editor writes to the session and its checkpoint.
  canEdit: boolean;
  editBlockedReason: string | null;
}

interface Props {
  display: SpatialDisplaySpec;
  sessionId: string;
  // 'regions' | 'shapes' | 'subset' | null — set by active sidebar tab; when null canvas is view-only
  canvasMode: 'regions' | 'shapes' | 'subset' | null;
  // Region-labeling config: which region set + category + color to label into
  annotationTarget: { regionSetId: string; category: string; color: string } | null;
  /** In-canvas control panel, rendered over the bottom-left of the canvas. The panel
   * itself is host UI (the Studio app's is Tailwind-styled), so the canvas only
   * supplies the state it owns; omit it for a bare canvas. */
  controls?: (api: SpatialCanvasControls) => ReactNode;
  /** Follow `display.viewport` into the camera when the host replaces it. Off by
   * default: a live session must not let another viewer's PUT echo yank this one's
   * camera. A host that owns the viewport (a dashboard tile, the embedded viewer)
   * turns it on. */
  followDisplayViewport?: boolean;
}

export default function SpatialCanvas({
  display, sessionId, canvasMode, annotationTarget, controls, followDisplayViewport = false,
}: Props) {
  const host = useCanvasHost();
  const source = useDataSource();
  const { fields, dataVersions, isolatedCategory, hiddenCells, canEdit } = host;
  const editBlockedReason = host.editBlockedReason ?? null;

  const coordsPath = display.encoding.coords;
  const coordsVersion = dataVersions[coordsPath] ?? 0;

  const { table: coordsTable, loading: coordsLoading } = useArrowField(coordsPath, coordsVersion);
  const { colorByPath, colorTable, colorLoading } = useColorField(display.encoding.color_by, dataVersions);

  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [imageInfoFailed, setImageInfoFailed] = useState(false);

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
  const showPoints = display.encoding.show_points ?? SPATIAL_ENCODING_DEFAULTS.show_points;
  const showImage = display.encoding.show_image ?? showImageDefault(display.encoding);
  const showLegend = display.encoding.show_channel_legend ?? SPATIAL_ENCODING_DEFAULTS.show_channel_legend;
  const showMinimap = display.encoding.show_minimap ?? SPATIAL_ENCODING_DEFAULTS.show_minimap;
  // View orientation + backdrop. Both flips live in the camera (FlipOrthographicView),
  // so picking/drawing stay consistent. The backdrop is independent of the app theme
  // and defaults to dark, matching the snapshot renderer's facecolor default.
  const invertX = display.encoding.invert_x ?? SPATIAL_ENCODING_DEFAULTS.invert_x;
  const invertY = display.encoding.invert_y ?? SPATIAL_ENCODING_DEFAULTS.invert_y;
  const bg = display.encoding.background ?? SPATIAL_ENCODING_DEFAULTS.background;
  const views = useMemo(
    () => [new FlipOrthographicView({ id: 'main', flipX: invertX, flipY: invertY })],
    [invertX, invertY],
  );
  // Polygon draw state lives on the host so the active tab's left panel owns the
  // commit / apply / clear actions; the canvas is purely the drawing surface. Absent
  // (a host that offers no region drawing) the lasso stays disarmed.
  const regions = host.regions;
  const polygons = regions?.drawPolygons ?? NO_POLYGONS;
  const currentRing = regions?.drawRing ?? NO_POINTS;

  // Shape-annotation editor state — the fetched list persists/renders regardless
  // of the active tab; the tool/selection/draft state only matters in 'shapes' mode.
  const annotations = host.annotations;
  const shapeAnnotations = annotations?.shapeAnnotations ?? NO_SHAPES;
  const activeShapeTool = annotations?.activeShapeTool ?? null;
  const selectedShapeId = annotations?.selectedShapeId ?? null;
  const draftVertices = annotations?.draftVertices ?? NO_POINTS;
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
  const lassoMode = !!regions && (canvasMode === 'regions' || canvasMode === 'subset');
  const shapesMode = !!annotations && canvasMode === 'shapes';
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
    if (!regions) return;
    const { setRegionCellCount, setRegionCellIndices } = regions;
    const rings = currentRing.length >= 3 ? [...polygons, currentRing] : polygons;
    if (!positions) {
      setRegionCellCount(0);
      setRegionCellIndices(null);
      return;
    }
    // A checkpoint has no backend to run polygon_query, so resolve membership here —
    // the same client-side test the embedding canvas already uses. A live session
    // still sends the rings and lets the backend do it against the real geometry.
    if (source?.kind === 'checkpoint') {
      const inside = indicesInRings(positions.positions, positions.numRows, rings);
      setRegionCellCount(inside.length);
      setRegionCellIndices(inside);
      return;
    }
    setRegionCellCount(countPointsInRings(positions.positions, positions.numRows, rings));
    setRegionCellIndices(null);
  }, [source, positions, polygons, currentRing, regions]);

  const { containerRef, canvasSize, viewState, setViewState, fitToData } = useCanvasViewState({
    positions,
    imageInfo,
    imageInfoFailed,
    showImage,
    display,
  });

  const { persistDisplay, currentSpec, updateEncoding } = useDisplayEditor(display, isSpatialDisplay);

  const { channels, setChannel, maxVisibleReached } = useImageChannels({
    imageInfo,
    display,
    persistDisplay,
    currentSpec,
  });

  // Live viewport for handlers that read where the user is looking right now
  // (text placement zoom, minimap navigation, viewport persistence).
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;

  // A host that owns the viewport replaces the display's wholesale (the embedded
  // viewer's apply-display, and the checkpoint's saved viewport on mount); follow it
  // into the camera. Opt-in on purpose — a live session never restores a persisted
  // viewport into a mounted canvas (see useCanvasViewState), and doing so there would
  // let another viewer's PUT echo yank this one's camera. The ref keeps the effect
  // one-shot per applied viewport object; a camera move the canvas made itself
  // round-trips through the store as an equal viewport and is left alone.
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
    const t = viewState.target as number[];
    const zoom = (Array.isArray(viewState.zoom) ? viewState.zoom[0] : viewState.zoom) ?? 0;
    if (
      Math.abs(t[0] - vp.target[0]) < 1e-6 &&
      Math.abs(t[1] - vp.target[1]) < 1e-6 &&
      Math.abs(zoom - vp.zoom) < 1e-6
    ) return;
    setViewState({
      ...viewState,
      target: [vp.target[0], vp.target[1], 0],
      zoom: vp.zoom, zoomX: vp.zoom, zoomY: vp.zoom,
    });
  }, [followDisplayViewport, display.viewport, viewState, fitToData, setViewState]);

  useSnapshotHandler({
    kind: 'spatial',
    sessionId,
    displayId: display.id,
    viewState,
    containerRef,
    getCanvasSize: () => canvasSize ?? { width: 1200, height: 900 },
    minimap: showMinimap,
  });

  // Overview inset (Minimap): the whole section with a box marking the visible window.
  // Its coordinate space is the canvas': the image's level-0 pixel extent when the
  // display has an image, else the cell bounds in world space.
  const minimapExtent = useMemo((): [number, number, number, number] | null => {
    if (pixelAffine && imageInfo?.levels.length) {
      const { width, height } = imageInfo.levels[0];
      return [0, 0, width, height];
    }
    if (!positions) return null;
    const { d0min, d0max, d1min, d1max } = positions.bounds;
    if (!Number.isFinite(d0min + d0max + d1min + d1max)) return null;
    return [d0min, d1min, d0max, d1max];
  }, [pixelAffine, imageInfo, positions]);

  // Whole-image overview, composited server-side with the visible channels' colors
  // (the endpoint reads the coarsest pyramid level; contrast overrides don't apply to
  // it). Null when the image is off — the inset then draws the cell scatter instead.
  const minimapImageUrl = useMemo(() => {
    const element = display.encoding.image_layer;
    if (!element || !showImage || !source) return null;
    const visible = channels.filter((c) => c.visible)
      .map((c) => `${c.index}:${c.color.replace('#', '')}`).join(',');
    return source.imageThumbnailUrl(element, visible || undefined, MINIMAP_THUMB_PX);
  }, [display.encoding.image_layer, showImage, channels, source]);

  const navigateTo = useCallback((target: [number, number]) => {
    const vs = viewStateRef.current;
    if (!vs) return;
    setViewState({ ...vs, target: [target[0], target[1], 0] });
  }, [setViewState]);
  const persistViewport = useCallback(() => {
    const vs = viewStateRef.current;
    if (!vs) return;
    const t = vs.target as number[];
    persistDisplay({ ...currentSpec(), viewport: { target: [t[0], t[1]], zoom: vs.zoom as number } });
  }, [persistDisplay, currentSpec]);

  // Clear any in-progress drawing when leaving/entering a draw mode.
  useEffect(() => {
    regions?.clearDraw();
    annotations?.clearDraft();
    annotations?.setSelectedShapeId(null);
    setShapeDragTarget(null);
    setShapeDragPreview(null);
  }, [canvasMode, regions?.clearDraw, annotations?.clearDraft, annotations?.setSelectedShapeId]);

  const handleClick = useCallback((info: PickingInfo) => {
    if (lassoMode && info.coordinate) {
      regions?.addDrawVertex(toWorld(info.coordinate));
      return;
    }
    if (!shapesMode || !info.coordinate || !annotations) return;
    const pt: Point = toWorld(info.coordinate);

    if (activeShapeTool === 'polygon') {
      // Each click drops a vertex; the shape is committed by the panel's Close
      // Shape button (see AnnotationsPanel / commitNewShape).
      annotations.addDraftVertex(pt);
      return;
    }

    if (activeShapeTool === 'text') {
      const vs = viewStateRef.current;
      const z = vs ? (Array.isArray(vs.zoom) ? vs.zoom[0] : vs.zoom) ?? 0 : 0;
      // 2^-z is canvas units per screen px — image-pixel units when an image is
      // shown — so divide by radiusScale (px per world unit) to get the WORLD units
      // per screen px textGeometryAt expects (text renders at fontSize * radiusScale).
      annotations.commitNewShape(textGeometryAt(pt, Math.pow(2, -z) / radiusScale));
      return;
    }

    if (!activeShapeTool) {
      // Select mode: click a shape's fill/stroke/text to select it, empty space to deselect.
      const hit = info.layer?.id === 'shape-fill' || info.layer?.id === 'shape-stroke' || info.layer?.id === 'shape-text'
        ? (info.object as ShapeAnnotation | undefined)?.id
        : undefined;
      annotations.setSelectedShapeId(hit ?? null);
    }
  }, [lassoMode, shapesMode, activeShapeTool, regions, annotations, toWorld, radiusScale]);

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
    if (!shapeDragTarget || !shapeDragPreview || !annotations) { setShapeDragTarget(null); setShapeDragPreview(null); return; }
    if (shapeDragTarget.kind === 'create') {
      annotations.commitNewShape(shapeDragPreview);
    } else {
      const shape = shapeAnnotations.find((s) => s.id === shapeDragTarget.shapeId);
      if (shape) {
        const updated: ShapeAnnotation = { ...shape, geometry: shapeDragPreview };
        annotations.upsertShapeAnnotation(updated);
        annotations.sendShapeUpdate(shape.id);  // reads the just-upserted latest; marks it locally owned
      }
    }
    setShapeDragTarget(null);
    setShapeDragPreview(null);
  }, [shapeDragTarget, shapeDragPreview, shapeAnnotations, annotations]);

  // Load image info. Retry a transient 503 (session busy — the async checkpoint load
  // holds the write lock on first open) so the image layer materializes once the lock
  // frees; without this a single 503 here leaves imageInfo null and the image blank,
  // since nothing else re-runs this effect after the session becomes ready.
  // On terminal failure (503 beyond fetchWhenIdle's retries, any other error) the
  // error is surfaced and `imageInfoFailed` lets useCanvasViewState fall through to
  // the world-space spot-bounds fit instead of "Initializing canvas..." forever. No
  // retry after that: the view is by then framed in world space, and a late-arriving
  // affine would shift every layer out from under the camera. A fresh attempt happens
  // whenever this effect re-runs (the image element or source changes) — both states
  // reset first so a failed or stale fetch never leaves the previous element's
  // affine applied.
  useEffect(() => {
    setImageInfo(null);
    setImageInfoFailed(false);
    const element = display.encoding.image_layer;
    if (!element || !source) return;
    const controller = new AbortController();
    fetchWhenIdle(() => source.getImageInfo(element), { signal: controller.signal })
      .then((info) => { if (!controller.signal.aborted) setImageInfo(info); })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setImageInfoFailed(true);
        reportError('Tissue image failed to load', err);
      });
    return () => controller.abort();
  }, [source, display.encoding.image_layer]);

  const colorSource = useMemo(() => arrowToColorSource(colorTable), [colorTable]);
  const categoryColors = display.encoding.category_colors?.[colorByPath];
  const { colors, colorLegend } = useSpotColors({
    colorSource,
    positions,
    opacity: display.encoding.opacity,
    isolatedCategory,
    hiddenCells,
    categoryColors,
  });

  // Categorical levels + their effective hex color, for the per-category color
  // controls. Null unless the current field is categorical (within the level cap).
  const categoryColorItems = useMemo(
    () => (colorLegend?.kind === 'categorical'
      ? colorLegend.items.map((it) => ({ label: it.label, color: rgbToHex(it.color) }))
      : null),
    [colorLegend],
  );

  const setCategoryColor = useCallback((label: string, color: string) => {
    const existing = display.encoding.category_colors ?? {};
    const forField = { ...(existing[colorByPath] ?? {}), [label]: color };
    updateEncoding({ category_colors: { ...existing, [colorByPath]: forField } });
  }, [display.encoding.category_colors, colorByPath, updateEncoding]);

  const resetCategoryColors = useCallback(() => {
    const existing = display.encoding.category_colors ?? {};
    if (!existing[colorByPath]) return;
    const { [colorByPath]: _drop, ...rest } = existing;
    updateEncoding({ category_colors: rest });
  }, [display.encoding.category_colors, colorByPath, updateEncoding]);

  const legendVisible = display.encoding.legend_visible !== false;
  const legendTitle = display.encoding.legend_title || colorByLabel(colorByPath);

  // GPU-composited image via Viv (the sole image path). While the pyramid loads,
  // Viv renders its own coarse low-res background and streams detail as tiles arrive.
  const { layers: vivLayers, tileProgress } = useVivImageLayer({
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
  const marker = display.encoding.point_marker ?? SPATIAL_ENCODING_DEFAULTS.point_marker;
  // Cell-boundary overlay style: filled polygons (default) or boundary-only strokes.
  const boundaryOutline = (display.encoding.boundary_style ?? SPATIAL_ENCODING_DEFAULTS.boundary_style) === 'outline';
  const boundaryLineWidth = display.encoding.boundary_line_width ?? SPATIAL_ENCODING_DEFAULTS.boundary_line_width;

  // Polygon shape sets available for this session (elements inventory filtered to
  // polygonal geom types). Empty → the whole shapes path stays dormant, which is
  // also what a source with no element inventory (a checkpoint) gets.
  const [polygonElements, setPolygonElements] = useState<string[]>([]);
  useEffect(() => {
    setPolygonElements([]);
    if (!source?.getElements) return;
    let stale = false;
    source.getElements()
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
  }, [source, coordsVersion]);

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

  const SEL = SELECTION_COLORS[bg][canvasMode === 'regions' ? 'regions' : 'subset'];

  // Selection graphics are UI overlays that must always be visible: 'always' depth
  // compare so they aren't occluded by any cell layer that writes depth.
  const OVERLAY_PARAMS = { depthCompare: 'always' as const, depthWriteEnabled: false };
  const drawLayers: Layer[] = lassoMode
    ? buildLassoLayers(polygons, currentRing, SEL,
        { idPrefix: 'sel', modelMatrix: worldToPixelMat, parameters: OVERLAY_PARAMS })
    : [];

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
      <div ref={containerRef} style={CANVAS_PLACEHOLDER}>
        {coordsLoading ? 'Loading spatial coordinates...' : 'Initializing canvas...'}
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ ...CANVAS_ROOT, backgroundColor: PLOT_BACKGROUNDS[bg] }}>
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

      {showMinimap && minimapExtent && canvasSize && (
        <Minimap
          imageUrl={minimapImageUrl}
          positions={positions}
          colors={colors}
          worldToCanvas={pixelAffine ? worldToPixelAffine(pixelAffine) : null}
          extent={minimapExtent}
          viewport={{ target: [(viewState.target as number[])[0], (viewState.target as number[])[1]], zoom }}
          canvasSize={canvasSize}
          invertX={invertX}
          invertY={invertY}
          onNavigate={navigateTo}
          onNavigateEnd={persistViewport}
        />
      )}

      <LoadingCue coordsLoading={coordsLoading} colorLoading={colorLoading} boundariesLoading={polygonsLoading} />

      <ImageTileStatus progress={tileProgress} />

      <ChannelLegend show={showImage} showLegend={showLegend} channels={channels} />

      <CellColorLegend visible={legendVisible && showPoints} legend={colorLegend} title={legendTitle} />

      <DrawHint drawMode={drawMode} canvasMode={canvasMode} annotationTarget={annotationTarget} />

      {controls?.({
        display,
        obsFields,
        layers: layerNames,
        colorByName,
        legendVisible,
        updateEncoding,
        categoryColorItems,
        hasCategoryOverrides: !!categoryColors && Object.keys(categoryColors).length > 0,
        setCategoryColor,
        resetCategoryColors,
        showPoints,
        showImage,
        invertX,
        invertY,
        background: bg,
        showLegend,
        showMinimap,
        renderMode,
        shapeSets: polygonElements,
        shapesElement,
        channels,
        setChannel,
        maxVisibleReached,
        zoom,
        onZoom: (dir) => {
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
        },
        onFit: () => { const fit = fitToData(); if (fit) setViewState(fit); },
        onEditTransform: host.onEditTransform,
        canEdit,
        editBlockedReason,
      })}

    </div>
  );
}
