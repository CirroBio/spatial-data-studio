import { useState, useEffect, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { BitmapLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer, OrthographicViewState } from '@deck.gl/core';
import { useAppStore } from '../../store/sessionStore';
import { useArrowField } from '../../hooks/useArrowField';
import { getImageInfo, putDisplay } from '../../api';
import type { DisplaySpec, ImageInfo } from '../../types';
import { useArrowPositions } from './useArrowPositions';
import { buildCategoricalPalette, buildNumericColormap } from './colorUtils';

const VIEWS = [new OrthographicView({ id: 'main', flipY: false })];

interface Props {
  display: DisplaySpec;
  sessionId: string;
}

export default function SpatialCanvas({ display, sessionId }: Props) {
  const { sessionState, updateDisplay } = useAppStore();
  const fields = sessionState?.fields;
  const dataVersions = sessionState?.data_versions ?? {};

  const coordsPath = display.encoding.coords; // "obsm:spatial"
  const coordsVersion = dataVersions[coordsPath] ?? 0;
  const colorByPath = display.encoding.color_by; // e.g. "obs:leiden"
  const colorVersion = dataVersions[colorByPath] ?? 0;

  const { table: coordsTable, loading: coordsLoading } = useArrowField(sessionId, coordsPath, coordsVersion);
  const { table: colorTable } = useArrowField(sessionId, colorByPath, colorVersion);

  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [showImage, setShowImage] = useState(display.encoding.image_layer !== null);
  const [viewState, setViewState] = useState<OrthographicViewState | null>(null);

  const positions = useArrowPositions(coordsTable);

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

  // Build color array
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
        const [r, g, b] = categoryColors[code] ?? [128, 128, 128];
        result[i * 4] = r;
        result[i * 4 + 1] = g;
        result[i * 4 + 2] = b;
        result[i * 4 + 3] = Math.round(display.encoding.opacity * 255);
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
  }, [colorTable, positions, display.encoding.opacity, display.encoding.colormap]);

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
      // Radius is in world (coordinate-space) units so a spot keeps a constant
      // spatial footprint at every zoom; zooming out shrinks spots on screen rather
      // than packing fixed-pixel dots into overlap. point_size is scaled against the
      // median inter-spot spacing (point_size 8 ~= touching).
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

  // Debounced display update
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

  const obsFields = fields?.obs ?? [];
  const colorOptions: string[] = [
    ...obsFields.map((f) => `obs:${f.name}`),
  ];

  if (!viewState) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-bg text-muted text-sm">
        {coordsLoading ? 'Loading spatial coordinates...' : 'Initializing canvas...'}
      </div>
    );
  }

  return (
    <div className="w-full h-full relative bg-bg">
      <DeckGL
        views={VIEWS}
        initialViewState={viewState as unknown as Record<string, OrthographicViewState>}
        layers={layers}
        controller={true}
      />

      {/* On-canvas controls */}
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
      </div>
    </div>
  );
}
