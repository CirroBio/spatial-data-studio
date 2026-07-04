import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { ScatterplotLayer, PolygonLayer, PathLayer } from '@deck.gl/layers';
import type { Layer, OrthographicViewState, PickingInfo } from '@deck.gl/core';
import { useAppStore } from '../../store/sessionStore';
import { useArrowField } from '../../hooks/useArrowField';
import { getImageInfo, putDisplay, saveSnapshot } from '../../api';
import { reportError } from '../../lib/errors';
import ObsFieldSelect from '../ObsFieldSelect';
import TransformEditor from '../TransformEditor';
import type { DisplaySpec, ImageInfo } from '../../types';
import { useArrowPositions } from './useArrowPositions';
import { useImageTiles } from './useImageTiles';
import { buildCategoricalPalette, buildNumericColormap, CHANNEL_COLORS, defaultChannelColor, VIRIDIS_CSS_GRADIENT } from './colorUtils';

const VIEWS = [new OrthographicView({ id: 'main', flipY: false })];

interface Props {
  display: DisplaySpec;
  sessionId: string;
  // 'annotate' | 'subset' | null — set by active sidebar tab; when null canvas is view-only
  canvasMode: 'annotate' | 'subset' | null;
  // Annotation config: which region set + category + color to label into
  annotationTarget: { regionSetId: string; category: string; color: string } | null;
}

export default function SpatialCanvas({ display, sessionId, canvasMode, annotationTarget }: Props) {
  const { sessionState, updateDisplay, isolatedCategory, pushNotification } = useAppStore();

  async function handleSnapshot() {
    try {
      const r = await saveSnapshot(sessionId);
      window.open(r.url, '_blank');
      pushNotification({ kind: 'info', message: 'Snapshot saved.' });
    } catch (e) {
      reportError('Snapshot failed', e);
    }
  }
  const fields = sessionState?.fields;
  const dataVersions = sessionState?.data_versions ?? {};

  const coordsPath = display.encoding.coords;
  const coordsVersion = dataVersions[coordsPath] ?? 0;
  const colorByPath = display.encoding.color_by;
  const colorVersion = dataVersions[colorByPath] ?? 0;

  const { table: coordsTable, loading: coordsLoading } = useArrowField(sessionId, coordsPath, coordsVersion);
  const { table: colorTable, loading: colorLoading } = useArrowField(sessionId, colorByPath, colorVersion);

  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [showImage, setShowImage] = useState(display.encoding.image_layer !== null);
  const [showLegend, setShowLegend] = useState(true);
  const [transformOpen, setTransformOpen] = useState(false);
  const [openColorPicker, setOpenColorPicker] = useState<number | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [viewState, setViewState] = useState<OrthographicViewState | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Track the canvas pixel size so the tile layer can pick a level of detail and
  // enumerate which tiles fall in the viewport.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setCanvasSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Polygon draw state lives in the store so the active tab's left panel owns the
  // commit / apply / clear actions; the canvas is purely the drawing surface.
  const { drawPolygons: polygons, drawRing: currentRing, addDrawVertex, clearDraw } = useAppStore();

  const drawMode = canvasMode !== null;

  // Per-channel display state (v3 Part 10): persisted in the display encoding,
  // defaulting to all-visible with the raw channel names from image_info.
  const channels = useMemo(
    () => (imageInfo?.channel_names ?? []).map((cn, i) => ({
      index: i,
      visible: display.encoding.channels?.[String(i)]?.visible ?? true,
      name: display.encoding.channels?.[String(i)]?.name ?? cn,
      color: display.encoding.channels?.[String(i)]?.color ?? defaultChannelColor(i),
    })),
    [imageInfo, display.encoding.channels],
  );
  const visibleChannels = channels
    .filter((c) => c.visible)
    .map((c) => `${c.index}:${c.color.replace('#', '')}`)
    .join(',');

  function setChannel(index: number, patch: Partial<{ visible: boolean; name: string; color: string }>) {
    const cur = channels[index];
    const next = { ...(display.encoding.channels ?? {}) };
    next[String(index)] = { visible: cur.visible, name: cur.name, color: cur.color, ...patch };
    const spec = { ...display, encoding: { ...display.encoding, channels: next } };
    updateDisplay(spec);                       // optimistic local update
    putDisplay(sessionId, spec).catch(console.error);
  }

  const positions = useArrowPositions(coordsTable);

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

  // Compute a view state that fits the data bounds within the current canvas size.
  // OrthographicView: world units per pixel = 1 / 2**zoom, so to fit an extent E
  // into P pixels we need zoom = log2(P / E). A margin keeps the data off the edges.
  const fitToData = useCallback((): OrthographicViewState | null => {
    if (!positions) return null;
    let { d0min, d0max, d1min, d1max } = positions.bounds;
    // Frame the whole section: union the spot extent with the image extent when the
    // image is shown, so a tissue image larger than the spots is fully visible.
    if (showImage && imageInfo) {
      const [ix0, iy0, ix1, iy1] = imageInfo.bounds;
      d0min = Math.min(d0min, ix0, ix1);
      d0max = Math.max(d0max, ix0, ix1);
      d1min = Math.min(d1min, iy0, iy1);
      d1max = Math.max(d1max, iy0, iy1);
    }
    const centerX = (d0min + d0max) / 2;
    const centerY = (d1min + d1max) / 2;
    const extentX = Math.max(1, d0max - d0min);
    const extentY = Math.max(1, d1max - d1min);
    const el = containerRef.current;
    const pxW = el?.clientWidth || window.innerWidth;
    const pxH = el?.clientHeight || window.innerHeight;
    const MARGIN = 0.9; // leave ~10% padding around the data
    const zoom = Math.log2(Math.min((pxW * MARGIN) / extentX, (pxH * MARGIN) / extentY));
    return { target: [centerX, centerY, 0], zoom, minZoom: -8, maxZoom: 8 };
  }, [positions, showImage, imageInfo]);

  // Set initial view state from the saved display viewport, else fit to data.
  // Wait for the image bounds before the first fit when a tissue image is shown, so
  // the whole section (which can extend beyond the spots) is framed, not just the spots.
  useEffect(() => {
    if (viewState) return;
    if (display.viewport) {
      setViewState({
        target: [display.viewport.target[0], display.viewport.target[1], 0],
        zoom: display.viewport.zoom,
        minZoom: -8,
        maxZoom: 8,
      });
      return;
    }
    if (!positions) return;
    if (display.encoding.image_layer && !imageInfo) return;
    const fit = fitToData();
    if (fit) setViewState(fit);
  }, [fitToData, display.viewport, display.encoding.image_layer, imageInfo, positions, viewState]);

  // Build color array — respects isolated category by dimming non-matching points
  const colors = useMemo((): Uint8Array | null => {
    if (!colorTable || !positions) return null;
    const n = positions.numRows;
    const result = new Uint8Array(n * 4);

    const schemaMetadata = colorTable.schema.metadata;
    const kind = schemaMetadata?.get('kind');

    if (kind === 'categorical') {
      const codeCol = colorTable.getChild('code');
      const catJson = schemaMetadata?.get('categories');
      if (!codeCol || !catJson) return null;

      const categories: string[] = JSON.parse(catJson) as string[];
      const palette = buildCategoricalPalette(categories);
      const categoryColors: [number, number, number][] = categories.map(
        (cat) => palette.get(cat) ?? [128, 128, 128]
      );

      for (let i = 0; i < n; i++) {
        const code = codeCol.get(i) as number;
        const cat = categories[code];
        const [r, g, b] = categoryColors[code] ?? [128, 128, 128];
        const dimmed = isolatedCategory !== null && cat !== isolatedCategory;
        result[i * 4] = r;
        result[i * 4 + 1] = g;
        result[i * 4 + 2] = b;
        result[i * 4 + 3] = dimmed ? 30 : Math.round(display.encoding.opacity * 255);
      }
    } else {
      const valueCol = colorTable.getChild('value');
      if (!valueCol) return null;
      const values = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        values[i] = valueCol.get(i) as number;
      }
      const rgba = buildNumericColormap(values);
      for (let i = 0; i < n; i++) {
        result[i * 4] = rgba[i * 4];
        result[i * 4 + 1] = rgba[i * 4 + 1];
        result[i * 4 + 2] = rgba[i * 4 + 2];
        result[i * 4 + 3] = Math.round(display.encoding.opacity * 255);
      }
    }
    return result;
  }, [colorTable, positions, display.encoding.opacity, isolatedCategory]);

  // Legend for the current cell coloring: category swatches (categorical) or a
  // colorbar with the value range (numeric). Mirrors the palette/ramp used above.
  const colorLegend = useMemo(() => {
    if (!colorTable) return null;
    const meta = colorTable.schema.metadata;
    if (meta?.get('kind') === 'categorical') {
      const catJson = meta?.get('categories');
      if (!catJson) return null;
      const categories = JSON.parse(catJson) as string[];
      const palette = buildCategoricalPalette(categories);
      return {
        kind: 'categorical' as const,
        items: categories.map((c) => ({ label: c, color: palette.get(c) ?? [128, 128, 128] })),
      };
    }
    const valueCol = colorTable.getChild('value');
    if (!valueCol) return null;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < colorTable.numRows; i++) {
      const v = valueCol.get(i) as number;
      if (!Number.isNaN(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min)) return null;
    return { kind: 'numeric' as const, min, max };
  }, [colorTable]);

  const legendVisible = display.encoding.legend_visible !== false;
  const legendTitle = display.encoding.legend_title || colorByPath.replace(/^obs:/, '');

  const { layers: imageLayers, loading: tilesLoading } = useImageTiles({
    imageInfo,
    sessionId,
    element: display.encoding.image_layer,
    viewState,
    size: canvasSize,
    visibleChannels,
    show: showImage,
  });

  const layers = useMemo(() => {
    const result: Layer[] = [...imageLayers];

    if (positions && colors) {
      const b = positions.bounds;
      const area = Math.max(1, (b.d0max - b.d0min) * (b.d1max - b.d1min));
      const spacing = Math.sqrt(area / Math.max(1, positions.numRows));
      const worldRadius = (display.encoding.point_size / 8) * spacing;
      result.push(
        new ScatterplotLayer({
          id: 'spots',
          data: {
            length: positions.numRows,
            attributes: {
              getPosition: { value: positions.positions, size: 2 },
              getFillColor: { value: colors, size: 4, normalized: true },
            },
          },
          getRadius: worldRadius,
          radiusUnits: 'common',
          radiusMinPixels: 0.5,
          opacity: display.encoding.opacity,
          pickable: false,
          updateTriggers: {
            getFillColor: colors,
            getPosition: positions.positions,
            getRadius: worldRadius,
          },
        })
      );
    }

    return result;
  }, [imageLayers, positions, colors, display.encoding.point_size, display.encoding.opacity]);

  const [pendingUpdate, setPendingUpdate] = useState<ReturnType<typeof setTimeout> | null>(null);

  function updateEncoding(patch: Partial<typeof display.encoding>) {
    const updated: DisplaySpec = {
      ...display,
      encoding: { ...display.encoding, ...patch },
    };
    updateDisplay(updated);
    if (pendingUpdate) clearTimeout(pendingUpdate);
    const t = setTimeout(() => {
      putDisplay(sessionId, updated).catch(console.error);
    }, 500);
    setPendingUpdate(t);
  }

  const SEL = canvasMode === 'annotate'
    ? [72, 187, 120] as [number, number, number]  // green for annotation
    : [124, 108, 246] as [number, number, number]; // accent purple for subset

  const drawLayers: Layer[] = [];
  if (drawMode) {
    if (polygons.length) {
      drawLayers.push(new PolygonLayer<[number, number][]>({
        id: 'sel-polygons', data: polygons, getPolygon: (d) => d,
        filled: true, getFillColor: [...SEL, 50], stroked: true,
        getLineColor: [...SEL, 220], getLineWidth: 2, lineWidthUnits: 'pixels', pickable: false,
      }));
    }
    if (currentRing.length >= 2) {
      drawLayers.push(new PathLayer<[number, number][]>({
        id: 'sel-path', data: [currentRing], getPath: (d) => d,
        getColor: [...SEL, 220], getWidth: 2, widthUnits: 'pixels',
      }));
    }
    if (currentRing.length >= 1) {
      drawLayers.push(new ScatterplotLayer<[number, number]>({
        id: 'sel-verts', data: currentRing, getPosition: (d) => d,
        getFillColor: [...SEL, 255], getRadius: 4, radiusUnits: 'pixels',
      }));
    }
  }

  const obsFields = fields?.obs ?? [];
  const colorByName = colorByPath.replace(/^obs:/, '');

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
        onViewStateChange={({ viewState: vs }) => setViewState(vs as OrthographicViewState)}
        layers={[...layers, ...drawLayers]}
        controller={drawMode ? { doubleClickZoom: false } : true}
        onClick={handleClick}
        getCursor={drawMode ? () => 'crosshair' : ({ isDragging }) => (isDragging ? 'grabbing' : 'grab')}
      />

      {/* Recalculation cue — top left. Visible while spatial coords, colors, or
          image tiles for the current view are still loading/rendering. */}
      {(coordsLoading || colorLoading || tilesLoading) && (
        <div className="absolute top-3 left-3 z-20 flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface/95 border border-accent/60 text-xs text-text backdrop-blur-sm shadow-lg pointer-events-none">
          <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          <span>
            {coordsLoading ? 'Loading cells…' : colorLoading ? 'Loading colors…' : 'Rendering image…'}
          </span>
        </div>
      )}

      {/* Channel legend — bottom left, only while the image and legend are shown. */}
      {showImage && showLegend && channels.some((c) => c.visible) && (
        <div className="absolute bottom-3 left-3 z-10 bg-surface/90 border border-border rounded p-2 flex flex-col gap-1 max-w-[180px] backdrop-blur-sm pointer-events-none">
          {channels.filter((c) => c.visible).map((c) => (
            <div key={c.index} className="flex items-center gap-1.5 text-[11px] text-text">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0 border border-border/50" style={{ background: c.color }} />
              <span className="truncate">{c.name}</span>
            </div>
          ))}
        </div>
      )}

      {/* Cell-color legend — bottom right. Colorbar for numeric, swatches for categorical. */}
      {legendVisible && colorLegend && (
        <div className="absolute bottom-3 right-3 z-10 bg-surface/90 border border-border rounded p-2 max-w-[200px] backdrop-blur-sm">
          <div className="text-[11px] font-medium text-text mb-1 truncate" title={legendTitle}>{legendTitle}</div>
          {colorLegend.kind === 'categorical' ? (
            <div className="flex flex-col gap-1 max-h-[220px] overflow-y-auto">
              {colorLegend.items.map((it) => (
                <div key={it.label} className="flex items-center gap-1.5 text-[11px] text-text">
                  <span
                    className="w-2.5 h-2.5 rounded-sm shrink-0 border border-border/50"
                    style={{ background: `rgb(${it.color[0]},${it.color[1]},${it.color[2]})` }}
                  />
                  <span className="truncate">{it.label}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-1 w-[150px]">
              <div className="h-2.5 w-full rounded-sm border border-border/50" style={{ background: VIRIDIS_CSS_GRADIENT }} />
              <div className="flex justify-between text-[10px] text-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <span>{colorLegend.min.toLocaleString(undefined, { maximumSignificantDigits: 3 })}</span>
                <span>{colorLegend.max.toLocaleString(undefined, { maximumSignificantDigits: 3 })}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Draw-mode hint — top center. All actions live in the active tab's panel. */}
      {drawMode && (
        <div
          className="absolute top-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded text-xs tracking-wide pointer-events-none backdrop-blur-sm whitespace-nowrap"
          style={{
            background: 'rgba(26,29,39,0.92)',
            border: `1px solid ${canvasMode === 'annotate' ? 'rgba(72,187,120,0.7)' : 'rgba(124,108,246,0.7)'}`,
            color: canvasMode === 'annotate' ? '#6fd99a' : '#a99bff',
          }}
        >
          {canvasMode === 'annotate'
            ? annotationTarget
              ? `Annotating ${annotationTarget.regionSetId} / ${annotationTarget.category} — click to add points, then Apply on the left`
              : 'Annotating — set a region set and category on the left, then click to add points'
            : 'Subsetting — draw a region, then Subset to selection on the left'}
        </div>
      )}

      {/* Controls panel — top right; minimizes to a gear icon in the same corner. */}
      {panelCollapsed ? (
        <button
          type="button"
          onClick={() => setPanelCollapsed(false)}
          title="Show controls"
          aria-label="Show controls"
          className="absolute top-3 right-3 z-10 p-1.5 rounded border border-border bg-surface/90 text-muted hover:text-accent hover:border-accent transition-colors backdrop-blur-sm"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      ) : (
      <div className="absolute top-3 right-3 z-10 bg-surface/90 border border-border rounded p-3 flex flex-col gap-2 min-w-[200px] backdrop-blur-sm">
        <div className="flex justify-end -mt-1 -mr-1">
          <button
            type="button"
            onClick={() => setPanelCollapsed(true)}
            title="Minimize controls"
            aria-label="Minimize controls"
            className="w-5 h-5 flex items-center justify-center rounded text-muted hover:text-accent hover:bg-bg transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M5 12h14" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted font-mono uppercase tracking-wide">Color by</label>
          <ObsFieldSelect
            fields={obsFields}
            value={colorByName}
            onChange={(name) => updateEncoding({ color_by: `obs:${name}` })}
          />
        </div>

        <label className="flex items-center gap-2 text-xs text-text cursor-pointer">
          <input
            type="checkbox"
            checked={legendVisible}
            onChange={(e) => updateEncoding({ legend_visible: e.target.checked })}
            className="accent-accent"
          />
          Color legend
        </label>

        {legendVisible && (
          <input
            type="text"
            value={display.encoding.legend_title ?? ''}
            onChange={(e) => updateEncoding({ legend_title: e.target.value })}
            placeholder={colorByName}
            className="bg-bg border border-border rounded px-2 py-1 text-xs text-text placeholder:text-muted/40 focus:outline-none focus:border-accent"
            title="Legend title"
          />
        )}

        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted font-mono uppercase tracking-wide">
            Point size: {display.encoding.point_size.toFixed(1)}
          </label>
          <input
            type="range"
            min={0.1}
            max={20}
            step={0.1}
            value={display.encoding.point_size}
            onChange={(e) => updateEncoding({ point_size: Number(e.target.value) })}
            className="w-full accent-accent"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted font-mono uppercase tracking-wide">
            Opacity: {display.encoding.opacity.toFixed(2)}
          </label>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={display.encoding.opacity}
            onChange={(e) => updateEncoding({ opacity: Number(e.target.value) })}
            className="w-full accent-accent"
          />
        </div>

        {display.encoding.image_layer && (
          <label className="flex items-center gap-2 text-xs text-text cursor-pointer">
            <input
              type="checkbox"
              checked={showImage}
              onChange={(e) => setShowImage(e.target.checked)}
              className="accent-accent"
            />
            Show image
          </label>
        )}

        {display.encoding.image_layer && showImage && channels.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-text cursor-pointer">
            <input
              type="checkbox"
              checked={showLegend}
              onChange={(e) => setShowLegend(e.target.checked)}
              className="accent-accent"
            />
            Channel legend
          </label>
        )}

        {display.encoding.image_layer && showImage && channels.length > 1 && (
          <div className="flex flex-col gap-1 border border-border/50 rounded p-1.5">
            <span className="text-[10px] text-muted font-mono uppercase tracking-wide">Channels</span>
            {channels.map((c) => (
              <div key={c.index} className="relative flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={c.visible}
                  onChange={(e) => setChannel(c.index, { visible: e.target.checked })}
                  className="accent-accent"
                  title="Toggle channel"
                />
                <button
                  type="button"
                  onClick={() => setOpenColorPicker(openColorPicker === c.index ? null : c.index)}
                  className="w-3.5 h-3.5 rounded-sm border border-border shrink-0 hover:ring-1 hover:ring-accent"
                  style={{ background: c.color }}
                  title="Change channel color"
                  aria-label={`Change color for ${c.name}`}
                />
                <input
                  type="text"
                  value={c.name}
                  onChange={(e) => setChannel(c.index, { name: e.target.value })}
                  className="flex-1 min-w-0 bg-bg border border-border rounded px-1 py-0.5 text-[10px] text-text focus:outline-none focus:border-accent"
                  title="Rename channel"
                />
                {openColorPicker === c.index && (
                  <div className="absolute left-0 top-full z-10 mt-1 grid grid-cols-4 gap-1 p-1.5 bg-surface border border-border rounded shadow-lg">
                    {CHANNEL_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => { setChannel(c.index, { color }); setOpenColorPicker(null); }}
                        className={`w-4 h-4 rounded-sm border transition-transform hover:scale-110 ${
                          color === c.color ? 'border-text' : 'border-border/50'
                        }`}
                        style={{ background: color }}
                        title={color}
                        aria-label={`Set color ${color}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => { const fit = fitToData(); if (fit) setViewState(fit); }}
          className="py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent transition-colors"
        >
          Fit to data
        </button>

        <button
          type="button"
          onClick={() => setTransformOpen(true)}
          className="py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent transition-colors"
        >
          Edit points transform
        </button>

        <button
          type="button"
          onClick={handleSnapshot}
          className="py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent transition-colors"
        >
          Save snapshot
        </button>
      </div>
      )}

      {transformOpen && <TransformEditor sessionId={sessionId} onClose={() => setTransformOpen(false)} />}
    </div>
  );
}
