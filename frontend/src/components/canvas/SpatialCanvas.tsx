import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { BitmapLayer, ScatterplotLayer, PolygonLayer, PathLayer } from '@deck.gl/layers';
import type { Layer, OrthographicViewState, PickingInfo } from '@deck.gl/core';
import { useAppStore } from '../../store/sessionStore';
import { useArrowField } from '../../hooks/useArrowField';
import { getImageInfo, putDisplay, subsetSession, annotateSession } from '../../api';
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
  const { sessionState, updateDisplay, isolatedCategory } = useAppStore();
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

  // Polygon drawing state — shared between annotate and subset modes
  const [polygons, setPolygons] = useState<[number, number][][]>([]);
  const [currentRing, setCurrentRing] = useState<[number, number][]>([]);
  const [saveParent, setSaveParent] = useState(false);
  const [working, setWorking] = useState(false);

  const drawMode = canvasMode !== null;

  const positions = useArrowPositions(coordsTable);

  // Clear drawing when mode changes
  useEffect(() => {
    setPolygons([]);
    setCurrentRing([]);
  }, [canvasMode]);

  const handleClick = useCallback((info: PickingInfo) => {
    if (!drawMode || !info.coordinate) return;
    setCurrentRing((r) => [...r, [info.coordinate![0], info.coordinate![1]] as [number, number]]);
  }, [drawMode]);

  function commitRing() {
    if (currentRing.length >= 3) {
      setPolygons((p) => [...p, currentRing]);
      setCurrentRing([]);
      return true;
    }
    return false;
  }

  function clearSelection() {
    setPolygons([]);
    setCurrentRing([]);
  }

  async function runSubset() {
    const all = currentRing.length >= 3 ? [...polygons, currentRing] : polygons;
    if (all.length === 0) return;
    setWorking(true);
    try {
      await subsetSession(sessionId, { polygons: all, save_parent: saveParent });
      clearSelection();
    } catch (err) {
      useAppStore.getState().pushNotification({
        kind: 'error', message: `Subset failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setWorking(false);
    }
  }

  async function runAnnotate() {
    if (!annotationTarget) return;
    const all = currentRing.length >= 3 ? [...polygons, currentRing] : polygons;
    if (all.length === 0) return;
    setWorking(true);
    try {
      await annotateSession(sessionId, {
        polygons: all,
        region_set: annotationTarget.regionSetId,
        category: annotationTarget.category,
        color: annotationTarget.color,
      });
      clearSelection();
    } catch (err) {
      useAppStore.getState().pushNotification({
        kind: 'error', message: `Annotate failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setWorking(false);
    }
  }

  // Load image info
  useEffect(() => {
    if (display.encoding.image_layer && sessionId) {
      getImageInfo(sessionId, display.encoding.image_layer)
        .then(setImageInfo)
        .catch(console.error);
    }
  }, [sessionId, display.encoding.image_layer]);

  // Set initial view state from data bounds or display viewport
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
    if (positions) {
      const { d0min, d0max, d1min, d1max } = positions.bounds;
      const centerX = (d0min + d0max) / 2;
      const centerY = (d1min + d1max) / 2;
      setViewState({
        target: [centerX, centerY, 0],
        zoom: -2,
        minZoom: -8,
        maxZoom: 8,
      });
    }
  }, [positions, display.viewport, viewState]);

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
      const thumbnailUrl = `/api/sessions/${sessionId}/image/${display.encoding.image_layer}/thumbnail`;
      result.push(
        new BitmapLayer({
          id: 'tissue-image',
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
  }, [imageInfo, positions, colors, display.encoding, sessionId, showImage]);

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
      <div className="w-full h-full flex items-center justify-center bg-bg text-muted text-sm">
        {coordsLoading ? 'Loading spatial coordinates...' : 'Initializing canvas...'}
      </div>
    );
  }

  const ringCount = polygons.length + (currentRing.length >= 3 ? 1 : 0);

  return (
    <div className="w-full h-full relative bg-bg">
      <DeckGL
        views={VIEWS}
        initialViewState={viewState as unknown as Record<string, OrthographicViewState>}
        layers={[...layers, ...drawLayers]}
        controller={drawMode ? { doubleClickZoom: false } : true}
        onClick={handleClick}
        getCursor={drawMode ? () => 'crosshair' : ({ isDragging }) => (isDragging ? 'grabbing' : 'grab')}
      />

      {/* Mode badge — bottom left */}
      {drawMode && (
        <div
          className="absolute bottom-4 left-4 z-10 px-3 py-1.5 rounded text-xs font-mono tracking-wide pointer-events-none"
          style={{
            background: canvasMode === 'annotate' ? 'rgba(72,187,120,0.15)' : 'rgba(124,108,246,0.15)',
            border: `1px solid ${canvasMode === 'annotate' ? 'rgba(72,187,120,0.5)' : 'rgba(124,108,246,0.5)'}`,
            color: canvasMode === 'annotate' ? '#48bb78' : '#7c6cf6',
          }}
        >
          Drawing will: {canvasMode === 'annotate' ? 'label region' : 'arm subset'}
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

        {/* Drawing controls shown when in annotate or subset mode */}
        {drawMode && (
          <div className="border-t border-border pt-2 mt-1 flex flex-col gap-2">
            <p className="text-[10px] text-muted leading-snug">
              Click to add points. {polygons.length} region(s){currentRing.length > 0 ? `, ${currentRing.length} pt drawing` : ''}.
            </p>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={commitRing}
                disabled={currentRing.length < 3}
                className="flex-1 py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent disabled:opacity-40 transition-colors"
              >
                + region
              </button>
              <button
                type="button"
                onClick={clearSelection}
                disabled={polygons.length === 0 && currentRing.length === 0}
                className="flex-1 py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent disabled:opacity-40 transition-colors"
              >
                Clear
              </button>
            </div>

            {canvasMode === 'subset' && (
              <>
                <label className="flex items-center gap-2 text-[11px] text-muted cursor-pointer">
                  <input type="checkbox" checked={saveParent} onChange={(e) => setSaveParent(e.target.checked)} className="accent-accent" />
                  Save parent first
                </label>
                <button
                  type="button"
                  onClick={runSubset}
                  disabled={working || ringCount === 0}
                  className="py-1.5 text-xs bg-accent hover:bg-accent/80 disabled:opacity-40 text-white rounded transition-colors"
                >
                  {working ? 'Subsetting...' : `Subset to selection${ringCount ? ` (${ringCount})` : ''}`}
                </button>
                <p className="text-[10px] text-muted/60 leading-snug">Creates a child session; the parent is evicted.</p>
              </>
            )}

            {canvasMode === 'annotate' && (
              <>
                {annotationTarget ? (
                  <div className="text-[10px] text-muted leading-snug">
                    Labeling into <span className="text-text font-mono">{annotationTarget.regionSetId}</span> as{' '}
                    <span className="font-mono" style={{ color: annotationTarget.color }}>{annotationTarget.category}</span>
                  </div>
                ) : (
                  <div className="text-[10px] text-warn leading-snug">Select a region set and category in the Annotations panel.</div>
                )}
                <button
                  type="button"
                  onClick={runAnnotate}
                  disabled={working || ringCount === 0 || !annotationTarget}
                  className="py-1.5 text-xs disabled:opacity-40 text-white rounded transition-colors"
                  style={{ background: annotationTarget ? '#48bb78' : '#3d9970', opacity: (working || ringCount === 0 || !annotationTarget) ? 0.4 : 1 }}
                >
                  {working ? 'Labeling...' : `Apply label${ringCount ? ` (${ringCount})` : ''}`}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
