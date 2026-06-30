import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { BitmapLayer, ScatterplotLayer, PolygonLayer, PathLayer } from '@deck.gl/layers';
import type { Layer, OrthographicViewState, PickingInfo } from '@deck.gl/core';
import { useAppStore } from '../../store/sessionStore';
import { useArrowField } from '../../hooks/useArrowField';
import { getImageInfo, putDisplay, saveSnapshot } from '../../api';
import type { DisplaySpec, ImageInfo } from '../../types';
import { useArrowPositions } from './useArrowPositions';
import { buildCategoricalPalette, buildNumericColormap } from './colorUtils';

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
      pushNotification({ kind: 'error', message: `Snapshot failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  const fields = sessionState?.fields;
  const dataVersions = sessionState?.data_versions ?? {};

  const coordsPath = display.encoding.coords;
  const coordsVersion = dataVersions[coordsPath] ?? 0;
  const colorByPath = display.encoding.color_by;
  const colorVersion = dataVersions[colorByPath] ?? 0;

  const { table: coordsTable, loading: coordsLoading } = useArrowField(sessionId, coordsPath, coordsVersion);
  const { table: colorTable } = useArrowField(sessionId, colorByPath, colorVersion);

  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [showImage, setShowImage] = useState(display.encoding.image_layer !== null);
  const [viewState, setViewState] = useState<OrthographicViewState | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

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
    })),
    [imageInfo, display.encoding.channels],
  );
  const visibleChannels = channels.filter((c) => c.visible).map((c) => c.index).join(',');

  function setChannel(index: number, patch: Partial<{ visible: boolean; name: string }>) {
    const cur = channels[index];
    const next = { ...(display.encoding.channels ?? {}) };
    next[String(index)] = { visible: cur.visible, name: cur.name, ...patch };
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
      const rgba = buildNumericColormap(values, display.encoding.colormap);
      for (let i = 0; i < n; i++) {
        result[i * 4] = rgba[i * 4];
        result[i * 4 + 1] = rgba[i * 4 + 1];
        result[i * 4 + 2] = rgba[i * 4 + 2];
        result[i * 4 + 3] = Math.round(display.encoding.opacity * 255);
      }
    }
    return result;
  }, [colorTable, positions, display.encoding.opacity, display.encoding.colormap, isolatedCategory]);

  const layers = useMemo(() => {
    const result: Layer[] = [];

    if (imageInfo && display.encoding.image_layer) {
      const thumbnailUrl = `/api/sessions/${sessionId}/image/${display.encoding.image_layer}/thumbnail?channels=${visibleChannels}`;
      result.push(
        new BitmapLayer({
          id: `tissue-image-${visibleChannels}`,  // id changes -> layer refetches on toggle
          image: thumbnailUrl,
          bounds: [
            imageInfo.bounds[0],
            imageInfo.bounds[1],
            imageInfo.bounds[2],
            imageInfo.bounds[3],
          ],
          opacity: showImage ? 1 : 0,
        })
      );
    }

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
  }, [imageInfo, positions, colors, display.encoding, sessionId, showImage, visibleChannels]);

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
  const colorOptions: string[] = obsFields.map((f) => `obs:${f.name}`);

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

      {/* Controls panel — top right */}
      <div className="absolute top-3 right-3 z-10 bg-surface/90 border border-border rounded p-3 flex flex-col gap-2 min-w-[200px] backdrop-blur-sm">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted font-mono uppercase tracking-wide">Color by</label>
          <select
            value={display.encoding.color_by}
            onChange={(e) => updateEncoding({ color_by: e.target.value })}
            className="bg-bg border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:border-accent"
          >
            {colorOptions.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted font-mono uppercase tracking-wide">
            Point size: {display.encoding.point_size}
          </label>
          <input
            type="range"
            min={1}
            max={20}
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

        {display.encoding.image_layer && showImage && channels.length > 1 && (
          <div className="flex flex-col gap-1 border border-border/50 rounded p-1.5">
            <span className="text-[10px] text-muted font-mono uppercase tracking-wide">Channels</span>
            {channels.map((c) => (
              <div key={c.index} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={c.visible}
                  onChange={(e) => setChannel(c.index, { visible: e.target.checked })}
                  className="accent-accent"
                  title="Toggle channel"
                />
                <input
                  type="text"
                  value={c.name}
                  onChange={(e) => setChannel(c.index, { name: e.target.value })}
                  className="flex-1 min-w-0 bg-bg border border-border rounded px-1 py-0.5 text-[10px] text-text focus:outline-none focus:border-accent"
                  title="Rename channel"
                />
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
          onClick={handleSnapshot}
          className="py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent transition-colors"
        >
          Save snapshot
        </button>
      </div>
    </div>
  );
}
