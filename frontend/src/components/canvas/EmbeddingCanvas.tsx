import { useState, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView, OrbitView } from '@deck.gl/core';
import { ScatterplotLayer, PointCloudLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { useAppStore } from '../../store/sessionStore';
import { useArrowField } from '../../hooks/useArrowField';
import { putDisplay, addDisplay as postDisplay } from '../../api';
import { reportError } from '../../lib/errors';
import type { EmbeddingDisplaySpec, ObsField, ObsmField } from '../../types';
import { useArrowPositions } from './useArrowPositions';
import { useEmbeddingViewState, type EmbeddingViewState } from './useEmbeddingViewState';
import { useSpotColors } from './useSpotColors';
import EmbeddingControls from './EmbeddingControls';
import { colorByLabel } from './colorBy';
import { LoadingCue, CellColorLegend } from './CanvasOverlays';

interface Props {
  display: EmbeddingDisplaySpec | null;
  sessionId: string;
  obsmFields: ObsmField[];
  obsFields: ObsField[];
  layerNames: string[];
}

export default function EmbeddingCanvas({ display, sessionId, obsmFields, obsFields, layerNames }: Props) {
  const { addDisplay } = useAppStore();

  if (!display) {
    return (
      <EmbeddingEmptyState
        sessionId={sessionId}
        obsmFields={obsmFields.filter((f) => f.name !== 'spatial')}
        obsFields={obsFields}
        onCreated={addDisplay}
      />
    );
  }

  return (
    <EmbeddingCanvasView
      display={display}
      sessionId={sessionId}
      obsFields={obsFields}
      layerNames={layerNames}
      obsmFields={obsmFields}
    />
  );
}

function EmbeddingEmptyState({
  sessionId,
  obsmFields,
  obsFields,
  onCreated,
}: {
  sessionId: string;
  obsmFields: ObsmField[];
  obsFields: ObsField[];
  onCreated: (display: EmbeddingDisplaySpec) => void;
}) {
  const [selectedKey, setSelectedKey] = useState(obsmFields[0]?.name ?? '');
  const [creating, setCreating] = useState(false);

  if (obsmFields.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm text-center px-8">
        No embeddings found — run a dimensionality reduction (e.g. UMAP, PCA) to populate this view.
      </div>
    );
  }

  async function handleCreate() {
    const field = obsmFields.find((f) => f.name === selectedKey);
    const n = field?.n_components ?? 2;
    const firstCategorical = obsFields.find((f) => f.kind === 'categorical');
    setCreating(true);
    try {
      const spec = await postDisplay(sessionId, {
        type: 'embedding_canvas',
        encoding: {
          obsm_key: selectedKey,
          x_component: 0,
          y_component: Math.min(1, n - 1),
          z_component: Math.min(2, n - 1),
          is_3d: false,
          color_by: firstCategorical ? `obs:${firstCategorical.name}` : '',
          point_size: 4,
          opacity: 0.85,
          colormap: 'viridis',
          legend_visible: true,
          legend_title: '',
        },
        viewport: null,
      });
      onCreated(spec as EmbeddingDisplaySpec);
    } catch (e) {
      reportError('Could not create embedding view', e);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-muted">
      <span className="text-sm">No embedding view configured for this session yet.</span>
      <div className="flex items-center gap-2">
        <select
          value={selectedKey}
          onChange={(e) => setSelectedKey(e.target.value)}
          className="bg-bg border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:border-accent"
        >
          {obsmFields.map((f) => (
            <option key={f.name} value={f.name}>{f.name}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="px-3 py-1 bg-accent hover:bg-accent/80 text-white rounded text-xs transition-colors disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create embedding view'}
        </button>
      </div>
    </div>
  );
}

function EmbeddingCanvasView({
  display,
  sessionId,
  obsFields,
  layerNames,
  obsmFields,
}: {
  display: EmbeddingDisplaySpec;
  sessionId: string;
  obsFields: ObsField[];
  layerNames: string[];
  obsmFields: ObsmField[];
}) {
  const { sessionState, updateDisplay, isolatedCategory } = useAppStore();
  const dataVersions = sessionState?.data_versions ?? {};

  const { is_3d, x_component, y_component, z_component } = display.encoding;
  const coordsPath = `obsm:${display.encoding.obsm_key}`;
  const coordsVersion = dataVersions[coordsPath] ?? 0;
  const colorByPath = display.encoding.color_by;
  const colorVersion = dataVersions[colorByPath] ?? 0;

  const { table: coordsTable, loading: coordsLoading } = useArrowField(sessionId, coordsPath, coordsVersion);
  const { table: colorTable, loading: colorLoading } = useArrowField(sessionId, colorByPath, colorVersion);

  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<ReturnType<typeof setTimeout> | null>(null);

  const positions = useArrowPositions(coordsTable, {
    xIndex: x_component,
    yIndex: y_component,
    zIndex: is_3d ? z_component : undefined,
  });

  const { containerRef, viewState, setViewState, fitToData } = useEmbeddingViewState({
    positions,
    is3d: is_3d,
    display,
  });

  const { colors, colorLegend } = useSpotColors({
    colorTable,
    positions,
    opacity: display.encoding.opacity,
    isolatedCategory,
  });

  const legendVisible = display.encoding.legend_visible !== false;
  const legendTitle = display.encoding.legend_title || colorByLabel(colorByPath);

  const views = useMemo(
    () => (is_3d ? [new OrbitView({ id: 'main' })] : [new OrthographicView({ id: 'main', flipY: false })]),
    [is_3d],
  );

  const layers = useMemo(() => {
    if (!positions || !colors) return [] as Layer[];
    const b = positions.bounds;
    const area = Math.max(1, (b.d0max - b.d0min) * (b.d1max - b.d1min));
    const spacing = Math.sqrt(area / Math.max(1, positions.numRows));
    if (is_3d) {
      return [
        new PointCloudLayer({
          id: 'embedding-points',
          data: {
            length: positions.numRows,
            attributes: {
              getPosition: { value: positions.positions, size: 3 },
              getColor: { value: colors, size: 4, normalized: true },
            },
          },
          pointSize: Math.max(1, display.encoding.point_size),
          opacity: display.encoding.opacity,
          updateTriggers: { getColor: colors, getPosition: positions.positions },
        }),
      ];
    }
    const worldRadius = (display.encoding.point_size / 8) * spacing;
    return [
      new ScatterplotLayer({
        id: 'embedding-points',
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
        updateTriggers: { getFillColor: colors, getPosition: positions.positions, getRadius: worldRadius },
      }),
    ];
  }, [positions, colors, is_3d, display.encoding.point_size, display.encoding.opacity]);

  function updateEncoding(patch: Partial<EmbeddingDisplaySpec['encoding']>) {
    const updated: EmbeddingDisplaySpec = { ...display, encoding: { ...display.encoding, ...patch } };
    updateDisplay(updated);
    if (pendingUpdate) clearTimeout(pendingUpdate);
    const t = setTimeout(() => {
      putDisplay(sessionId, updated).catch(console.error);
    }, 500);
    setPendingUpdate(t);
  }

  const colorByName = colorByLabel(colorByPath);

  if (!viewState) {
    return (
      <div ref={containerRef} className="w-full h-full flex items-center justify-center bg-bg text-muted text-sm">
        {coordsLoading ? 'Loading embedding coordinates...' : 'Initializing canvas...'}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full relative bg-bg">
      <DeckGL
        views={views}
        viewState={viewState as unknown as Record<string, EmbeddingViewState>}
        onViewStateChange={({ viewState: vs }) => setViewState(vs as EmbeddingViewState)}
        layers={layers}
        controller={true}
        getCursor={({ isDragging }) => (isDragging ? 'grabbing' : 'grab')}
      />

      <LoadingCue coordsLoading={coordsLoading} colorLoading={colorLoading} tilesLoading={false} />

      <CellColorLegend visible={legendVisible} legend={colorLegend} title={legendTitle} />

      <EmbeddingControls
        display={display}
        sessionId={sessionId}
        obsFields={obsFields}
        layers={layerNames}
        obsmFields={obsmFields}
        colorByName={colorByName}
        legendVisible={legendVisible}
        updateEncoding={updateEncoding}
        panelCollapsed={panelCollapsed}
        setPanelCollapsed={setPanelCollapsed}
        onFit={() => { const fit = fitToData(); if (fit) setViewState(fit); }}
      />
    </div>
  );
}
