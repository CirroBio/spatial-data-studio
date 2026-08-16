// @cirrobio/spatial-viewer — the public surface. See README.md.

// ---- Canvases ---------------------------------------------------------------
export { default as SpatialCanvas, type SpatialCanvasControls } from './canvas/SpatialCanvas';
export { default as EmbeddingCanvas, type EmbeddingCanvasControls } from './canvas/EmbeddingCanvas';

// ---- The host contract ------------------------------------------------------
export {
  CanvasHostProvider, useCanvasHost, useDisplayEditor,
  type CanvasHost, type RegionDrawHost, type ShapeAnnotationHost, type SnapshotHost,
} from './canvas/canvas-host';

// ---- Where the data comes from ----------------------------------------------
export { DataSourceProvider, useDataSource } from './data/context';
export type { DataSource, ElementInventory, ImageLoader, LocalCategorical } from './data/types';
export { openCheckpoint, type CheckpointHandle, type CheckpointUrlRefresher } from './data/checkpointSource';
export { useArrowField } from './data/useArrowField';

// ---- The display model ------------------------------------------------------
export {
  isSpatialDisplay, isEmbeddingDisplay,
  type ChannelState, type DisplayEncoding, type DisplaySpec, type EmbeddingDisplaySpec,
  type EmbeddingEncoding, type ImageDims, type ImageInfo, type ImageLevel, type ObsField,
  type ObsmField, type SessionFields, type SpatialDisplaySpec, type Viewport,
} from './types';
export {
  EMBEDDING_ENCODING_DEFAULTS, SPATIAL_ENCODING_DEFAULTS, showImageDefault,
} from './defaults';

// ---- Shape annotations ------------------------------------------------------
export {
  FillStyle, ShapeAnnotation, ShapeGeometry, SHAPE_KINDS, StrokeStyle,
  defaultFill, defaultStroke, textGeometryAt, type ShapeKind,
} from './schemas/annotations';
export {
  ROTATE_HANDLE_ID, applyHandleDrag, arrowheadTriangle, geometryFromDrag, polygonFromClicks,
  shapeCentroid, shapeHandles, shapeOutline, translateGeometry,
} from './lib/shapeAnnotations';

// ---- Palettes and per-display styling ---------------------------------------
export {
  CATEGORY_COLORS, CATEGORY_SWATCHES, CHANNEL_COLORS, PLOT_BACKGROUNDS, SELECTION_COLORS,
  VIRIDIS_CSS_GRADIENT, buildCategoricalPalette, buildNumericColormap, defaultChannelColor,
  hexToRgb, rgbToHex,
} from './canvas/colorUtils';
export { colorByLabel, parseColorBy, type ColorBy, type ColorBySlot } from './canvas/colorBy';
export { ZOOM_LIMITS, ZOOM_STEP } from './canvas/viewFit';
export {
  MAX_VISIBLE_CHANNELS, useImageChannels, type Channel, type ChannelPatch,
} from './canvas/useImageChannels';
export {
  arrowToColorSource, useSpotColors, type ColorLegend,
} from './canvas/useSpotColors';
export { useArrowPositions, type ScatterPositions } from './canvas/useArrowPositions';

// ---- Snapshots (PNG capture + the saved-figure contract) ---------------------
export { downloadCanvasPng } from './lib/canvasCapture';
export {
  formatCreated, type Snapshot, type SnapshotExportParams, type SnapshotFormat,
} from './lib/snapshots';

// ---- Fetch plumbing the DataSource implementations share --------------------
export { ApiError } from './lib/apiError';
export { fetchWhenIdle } from './lib/fetchWhenIdle';
export { formatError } from './lib/format';
export { reportError, setErrorSink } from './lib/errors';
export { countPointsInRings, indicesInRings } from './lib/pointInPolygon';
