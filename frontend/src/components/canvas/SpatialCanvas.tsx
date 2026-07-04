import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { ScatterplotLayer, PolygonLayer, PathLayer } from '@deck.gl/layers';
import type { Layer, OrthographicViewState, PickingInfo } from '@deck.gl/core';
import { useAppStore } from '../../store/sessionStore';
import { useArrowField } from '../../hooks/useArrowField';
import { getImageInfo, putDisplay, saveSnapshot } from '../../api';
import { reportError } from '../../lib/errors';
import TransformEditor from '../TransformEditor';
import type { SpatialDisplaySpec, ImageInfo } from '../../types';
import { useArrowPositions } from './useArrowPositions';
import { useImageTiles } from './useImageTiles';
import { useCanvasViewState } from './useCanvasViewState';
import { useSpotColors } from './useSpotColors';
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
  const [showPoints, setShowPoints] = useState(true);
  const [showImage, setShowImage] = useState(display.encoding.image_layer !== null);
  const [showLegend, setShowLegend] = useState(true);
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

  const { colors, colorLegend } = useSpotColors({
    colorTable,
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

  const layers = useMemo(() => {
    const result: Layer[] = [...imageLayers];

    if (showPoints && positions && colors) {
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
  }, [imageLayers, positions, colors, showPoints, display.encoding.point_size, display.encoding.opacity]);

  const [pendingUpdate, setPendingUpdate] = useState<ReturnType<typeof setTimeout> | null>(null);

  function updateEncoding(patch: Partial<typeof display.encoding>) {
    const updated: SpatialDisplaySpec = {
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
        onViewStateChange={({ viewState: vs }) => setViewState(vs as OrthographicViewState)}
        layers={[...layers, ...drawLayers]}
        controller={drawMode ? { doubleClickZoom: false } : true}
        onClick={handleClick}
        getCursor={drawMode ? () => 'crosshair' : ({ isDragging }) => (isDragging ? 'grabbing' : 'grab')}
      />

      <LoadingCue coordsLoading={coordsLoading} colorLoading={colorLoading} tilesLoading={tilesLoading} />

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
        setShowPoints={setShowPoints}
        showImage={showImage}
        setShowImage={setShowImage}
        showLegend={showLegend}
        setShowLegend={setShowLegend}
        channels={channels}
        setChannel={setChannel}
        openColorPicker={openColorPicker}
        setOpenColorPicker={setOpenColorPicker}
        panelCollapsed={panelCollapsed}
        setPanelCollapsed={setPanelCollapsed}
        onFit={() => { const fit = fitToData(); if (fit) setViewState(fit); }}
        onEditTransform={() => setTransformOpen(true)}
        onSnapshot={handleSnapshot}
      />

      {transformOpen && <TransformEditor sessionId={sessionId} onClose={() => setTransformOpen(false)} />}
    </div>
  );
}
