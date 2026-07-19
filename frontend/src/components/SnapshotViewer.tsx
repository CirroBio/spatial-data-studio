import { useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView, OrbitView } from '@deck.gl/core';
import { BitmapLayer } from '@deck.gl/layers';
import type { Layer, OrthographicViewState, OrbitViewState } from '@deck.gl/core';
import { fetchSnapshotConfig } from '../lib/snapshots';
import { formatError } from '../lib/errors';
import type { EmbeddingEncoding, SnapshotConfig } from '../types';
import {
  openCheckpoint, readObsm, readColorSource, readImageLevelWhole, readImageWindow,
  compositeChannels, type CheckpointRoot, type ObsmResult,
} from '../lib/checkpointStore';
import type { ScatterPositions } from './canvas/useArrowPositions';
import { useSpotColors, type ColorSource } from './canvas/useSpotColors';
import { buildSpotLayer } from './canvas/buildSpotLayer';
import { quad, worldToPixel, type Affine } from './canvas/imageAffine';
import { defaultChannelColor } from './canvas/colorUtils';
import { colorByLabel } from './canvas/colorBy';
import { CellColorLegend, ChannelLegend, LoadingCue } from './canvas/CanvasOverlays';
import type { Channel } from './canvas/useImageChannels';

const ZOOM_LIMITS = { minZoom: -8, maxZoom: 8 };
const DEFAULT_ROTATION_X = 25;
const SETTLE_MS = 200;

type ViewState = OrthographicViewState | OrbitViewState;
interface Bitmap { image: ImageData; bounds: ReturnType<typeof quad> }

// Slice a flat row-major obsm array into stride-2/3 positions + bounds, selecting
// the axis components the snapshot was saved with (mirrors useArrowPositions).
// `affine` (6 floats [a,b,c,d,e,f]) is the points->global transform the live canvas
// applies to obsm:spatial; apply it here so nudged alignments render identically.
function obsmToPositions(
  obsm: ObsmResult, x: number, y: number, z?: number, affine?: number[],
): ScatterPositions {
  const { data, n, d } = obsm;
  const is3d = z !== undefined;
  const stride = is3d ? 3 : 2;
  const positions = new Float32Array(n * stride);
  let d0min = Infinity, d0max = -Infinity, d1min = Infinity, d1max = -Infinity;
  let d2min = Infinity, d2max = -Infinity;
  for (let i = 0; i < n; i++) {
    let xv = data[i * d + x];
    let yv = data[i * d + y];
    if (affine) {
      const nx = affine[0] * xv + affine[1] * yv + affine[2];
      const ny = affine[3] * xv + affine[4] * yv + affine[5];
      xv = nx; yv = ny;
    }
    positions[i * stride] = xv;
    positions[i * stride + 1] = yv;
    if (xv < d0min) d0min = xv;
    if (xv > d0max) d0max = xv;
    if (yv < d1min) d1min = yv;
    if (yv > d1max) d1max = yv;
    if (is3d) {
      const zv = data[i * d + (z as number)];
      positions[i * stride + 2] = zv;
      if (zv < d2min) d2min = zv;
      if (zv > d2max) d2max = zv;
    }
  }
  const bounds = is3d
    ? { d0min, d0max, d1min, d1max, d2min, d2max }
    : { d0min, d0max, d1min, d1max };
  return { positions, numRows: n, bounds };
}

function initialViewState(cfg: SnapshotConfig, is3d: boolean): ViewState {
  const vp = cfg.viewport;
  if (is3d) {
    return {
      target: [vp.target[0], vp.target[1], vp.target[2] ?? 0],
      zoom: vp.zoom,
      rotationX: vp.rotationX ?? DEFAULT_ROTATION_X,
      rotationOrbit: vp.rotationOrbit ?? 0,
      ...ZOOM_LIMITS,
    };
  }
  return { target: [vp.target[0], vp.target[1], 0], zoom: vp.zoom, ...ZOOM_LIMITS };
}

// Pass the per-channel color/contrast to the compositor; an empty dict falls back
// to default palette colors (compositeChannels always additively tints).
function channelsArg(cfg: SnapshotConfig): SnapshotConfig['render']['channels'] | null {
  const ch = cfg.render.channels;
  return ch && Object.keys(ch).length ? ch : null;
}

function zoomOf(vs: ViewState): number {
  const z = vs.zoom;
  return Array.isArray(z) ? z[0] : z ?? 0;
}

interface Props {
  url: string;  // snapshot config URL (/snapshots/<name>.sview.json)
  // Maps the app-relative URLs baked into a snapshot (its config URL and the
  // config's /api/checkpoints/<name> checkpoint URL) to wherever they actually
  // live. Identity in the app; the standalone bundle rewrites them to relative paths.
  resolveUrl?: (url: string) => string;
}

// Read-only deck.gl view of an immutable checkpoint, driven by a SnapshotConfig.
// Reuses the live canvas layers (buildSpotLayer, useSpotColors, image affine,
// overlays); reads pixels/positions/colors directly from the checkpoint zarr.
// Parent must remount per snapshot via key={url}. zarrita has no AbortSignal, so
// effects use an ignore-stale flag and decoded bitmaps live in component state.
export default function SnapshotViewer({ url, resolveUrl }: Props) {
  const resolve = resolveUrl ?? ((u: string) => u);
  const [config, setConfig] = useState<SnapshotConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [positions, setPositions] = useState<ScatterPositions | null>(null);
  const [colorSource, setColorSource] = useState<ColorSource | null>(null);
  const [base, setBase] = useState<Bitmap | null>(null);
  const [detail, setDetail] = useState<Bitmap | null>(null);
  const [viewState, setViewState] = useState<ViewState | null>(null);
  const [settled, setSettled] = useState<ViewState | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);

  const rootRef = useRef<CheckpointRoot | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const is3d = config?.kind === 'embedding' && (config.encoding as EmbeddingEncoding).is_3d === true;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setCanvasSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Load config + checkpoint, then positions / colors / coarse base image.
  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const cfg = await fetchSnapshotConfig(resolve(url));
        if (stale) return;
        setConfig(cfg);
        const embed = cfg.kind === 'embedding' ? (cfg.encoding as EmbeddingEncoding) : null;
        const initial = initialViewState(cfg, embed?.is_3d === true);
        setViewState(initial);
        setSettled(initial);  // load detail at the saved viewport without waiting for a pan

        const { root } = await openCheckpoint(resolve(cfg.checkpoint.url));
        if (stale) return;
        rootRef.current = root;

        const coordsKey = cfg.render.coords.slice(cfg.render.coords.indexOf(':') + 1);
        const obsm = await readObsm(root, cfg.table, coordsKey);
        if (stale) return;
        const sel = embed
          ? { x: embed.x_component, y: embed.y_component, z: embed.is_3d ? embed.z_component : undefined }
          : { x: 0, y: 1, z: undefined };
        // The points->global affine is applied by the live canvas only to obsm:spatial.
        const affine = !embed && cfg.render.coords === 'obsm:spatial'
          ? cfg.render.coords_transform : undefined;
        setPositions(obsmToPositions(obsm, sel.x, sel.y, sel.z, affine));

        const cs = await readColorSource(root, cfg.table, cfg.render.color_by);
        if (stale) return;
        setColorSource(cs);

        const img = cfg.render.image;
        if (img) {
          const coarsest = img.levels[img.levels.length - 1].level;
          const win = await readImageLevelWhole(root, img.element, coarsest);
          if (stale) return;
          setBase({
            image: compositeChannels(win, channelsArg(cfg)),
            bounds: quad(img.pixel_to_world as Affine, 0, 0, img.width, img.height),
          });
        }
      } catch (e) {
        if (!stale) setError(formatError(e));
      }
    })();
    return () => { stale = true; };
  }, [url]);

  // On viewport settle, overlay a detail window read at a zoom-appropriate level.
  useEffect(() => {
    const root = rootRef.current;
    const img = config?.render.image;
    if (!root || !img || !settled || !canvasSize) return;
    let stale = false;
    (async () => {
      const m = img.pixel_to_world as Affine;
      const W0 = img.width;
      const H0 = img.height;
      const levels = img.levels;
      const maxLevel = levels.length - 1;
      const zoom = zoomOf(settled);
      const worldPerScreenPx = Math.pow(2, -zoom);
      const worldPerPx0 = Math.abs(img.bounds[2] - img.bounds[0]) / W0;
      let li = Math.floor(Math.log2(Math.max(worldPerScreenPx / worldPerPx0, 1e-9)));
      li = Math.max(0, Math.min(maxLevel, li));
      if (li >= maxLevel) { setDetail(null); return; }  // coarse base already covers this

      const { level: L, width: WL, height: HL } = levels[li];
      const sx = W0 / WL;
      const sy = H0 / HL;
      const target = settled.target as number[];
      const hw = (canvasSize.width / 2) * worldPerScreenPx;
      const hh = (canvasSize.height / 2) * worldPerScreenPx;
      const corners: [number, number][] = [
        [target[0] - hw, target[1] - hh], [target[0] + hw, target[1] - hh],
        [target[0] + hw, target[1] + hh], [target[0] - hw, target[1] + hh],
      ];
      let pxMin = Infinity, pyMin = Infinity, pxMax = -Infinity, pyMax = -Infinity;
      for (const [cx, cy] of corners) {
        const [px, py] = worldToPixel(m, cx, cy);
        pxMin = Math.min(pxMin, px); pxMax = Math.max(pxMax, px);
        pyMin = Math.min(pyMin, py); pyMax = Math.max(pyMax, py);
      }
      const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
      const xL0 = clamp(Math.floor(pxMin / sx), WL);
      const xL1 = clamp(Math.ceil(pxMax / sx), WL);
      const yL0 = clamp(Math.floor(pyMin / sy), HL);
      const yL1 = clamp(Math.ceil(pyMax / sy), HL);
      if (xL1 <= xL0 || yL1 <= yL0) { setDetail(null); return; }

      try {
        const win = await readImageWindow(root, img.element, L, [yL0, yL1], [xL0, xL1]);
        if (stale) return;
        setDetail({
          image: compositeChannels(win, channelsArg(config)),
          bounds: quad(m, xL0 * sx, yL0 * sy, xL1 * sx, yL1 * sy),
        });
      } catch (e) {
        if (!stale) setError(formatError(e));
      }
    })();
    return () => { stale = true; };
  }, [settled, canvasSize, config]);

  const { colors, colorLegend } = useSpotColors({
    colorSource,
    positions,
    opacity: config?.render.opacity ?? 1,
    isolatedCategory: null,
  });

  const views = useMemo(
    () => (is3d ? [new OrbitView({ id: 'main' })] : [new OrthographicView({ id: 'main', flipY: false })]),
    [is3d],
  );

  // The snapshot has no backend to serve polygon outlines (they'd need geometry read
  // from the bundled zarr), so it draws only the point scatter; the 2D merged scatter
  // handles overlapping cells at every zoom without shipping geometry.
  const layers = useMemo(() => {
    const result: Layer[] = [];
    if (base) result.push(new BitmapLayer({ id: 'snap-base', image: base.image, bounds: base.bounds }));
    if (detail) result.push(new BitmapLayer({ id: 'snap-detail', image: detail.image, bounds: detail.bounds }));
    if (config && positions && colors) {
      result.push(...buildSpotLayer(positions, colors, {
        pointSize: config.render.point_size,
        opacity: config.render.opacity,
        is3d,
      }));
    }
    return result;
  }, [base, detail, config, positions, colors, is3d]);

  const legendChannels = useMemo((): Channel[] => {
    const img = config?.render.image;
    if (!img) return [];
    return Object.entries(config.render.channels).flatMap(([key, ch]) => {
      if (!ch.visible) return [];
      const i = Number(key);
      return [{ index: i, visible: true, name: img.channel_names[i] ?? `ch${i}`, color: ch.color || defaultChannelColor(i) }];
    });
  }, [config]);

  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-bg text-danger text-sm px-6 text-center">
        Failed to load snapshot: {error}
      </div>
    );
  }
  if (!config || !viewState) {
    return (
      <div ref={containerRef} className="w-full h-full flex items-center justify-center bg-bg text-muted text-sm">
        Loading snapshot…
      </div>
    );
  }

  const legendVisible = config.encoding.legend_visible !== false;
  const legendTitle = config.encoding.legend_title || colorByLabel(config.render.color_by);

  return (
    <div ref={containerRef} className="w-full h-full relative bg-bg">
      <DeckGL
        views={views}
        viewState={viewState as unknown as Record<string, ViewState>}
        onViewStateChange={({ viewState: vs }) => {
          const v = vs as ViewState;
          setViewState(v);
          if (settleTimer.current) clearTimeout(settleTimer.current);
          settleTimer.current = setTimeout(() => setSettled(v), SETTLE_MS);
        }}
        layers={layers}
        controller={true}
        getCursor={({ isDragging }) => (isDragging ? 'grabbing' : 'grab')}
      />

      <LoadingCue
        coordsLoading={!positions}
        colorLoading={!!config.render.color_by && !colors}
        tilesLoading={!!config.render.image && !base}
      />

      <ChannelLegend show={!!config.render.image} showLegend channels={legendChannels} />

      <CellColorLegend visible={legendVisible} legend={colorLegend} title={legendTitle} />
    </div>
  );
}
