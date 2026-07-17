import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import * as arrow from 'apache-arrow';
import type { Layer, OrthographicViewState } from '@deck.gl/core';
// Follow-up: 0.3.2 warns it is renamed to @geoarrow/deck.gl-geoarrow (0.4.x).
// Pinned here because 0.4.x may drift the API and needs re-testing; not migrated.
import { GeoArrowSolidPolygonLayer } from '@geoarrow/deck.gl-layers';
import type { GeoArrowSolidPolygonLayerProps } from '@geoarrow/deck.gl-layers';
import { getShapesGeoArrow } from '../../api';

// Cap features per viewport request so the main-thread earcut triangulation can't
// stall on a pathological bbox; the backend logs when it truncates.
const POLYGON_LIMIT = 20000;
// Debounce viewport moves before firing a fetch, and pad the fetched bbox past the
// viewport so a small pan reuses the cached table instead of refetching.
const SETTLE_MS = 180;
const BBOX_PAD = 0.5;

type Bbox = [number, number, number, number];

// Module-level LRU of fetched GeoArrow tables (geometry only — color is applied at
// render time, so a recolor never refetches). Keyed by session:element:version:bbox.
const CACHE_MAX = 48;
const cache = new Map<string, arrow.Table>();
const pending = new Set<string>();

function getTable(key: string, sessionId: string, element: string, bbox: Bbox, onLoad: () => void): arrow.Table | null {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);  // LRU bump
    return hit;
  }
  if (!pending.has(key)) {
    pending.add(key);
    getShapesGeoArrow(sessionId, element, bbox, POLYGON_LIMIT)
      .then((t) => {
        pending.delete(key);
        cache.set(key, t);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
        onLoad();
      })
      .catch(() => { pending.delete(key); });  // transient/404 → the field/points fallback still renders
  }
  return null;
}

// Build a per-feature RGBA color Vector (arrow FixedSizeList<Uint8, 4>) by
// gathering from the full per-cell color buffer via each row's cell_index. Chunked
// to match the geometry table's record batches, which is how the GeoArrow layer
// pairs the color attribute to each geometry chunk. cell_index < 0 (no matching
// table row) or out of range → transparent.
function buildFillColors(table: arrow.Table, colors: Uint8Array): arrow.Vector {
  const idxCol = table.getChild('cell_index');
  const nCells = colors.length / 4;
  const listType = new arrow.FixedSizeList(4, new arrow.Field('item', new arrow.Uint8(), false));
  const chunks: arrow.Data<arrow.FixedSizeList<arrow.Uint8>>[] = [];
  let row = 0;
  for (const batch of table.batches) {
    const n = batch.numRows;
    const buf = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const ci = idxCol ? Number(idxCol.get(row)) : -1;
      if (ci >= 0 && ci < nCells) buf.set(colors.subarray(ci * 4, ci * 4 + 4), i * 4);
      row++;
    }
    const child = arrow.makeData({ type: new arrow.Uint8(), data: buf });
    chunks.push(arrow.makeData({ type: listType, length: n, child }));
  }
  return arrow.makeVector(chunks);
}

function viewportBbox(vs: OrthographicViewState, size: { width: number; height: number }): Bbox {
  const zoom = Array.isArray(vs.zoom) ? vs.zoom[0] : vs.zoom ?? 0;
  const target = vs.target as number[];
  const worldPerPx = Math.pow(2, -zoom);
  const hw = (size.width / 2) * worldPerPx * (1 + BBOX_PAD);
  const hh = (size.height / 2) * worldPerPx * (1 + BBOX_PAD);
  return [target[0] - hw, target[1] - hh, target[0] + hw, target[1] + hh];
}

interface Params {
  sessionId: string;
  element: string | null;
  version: number;
  viewState: OrthographicViewState | null;
  size: { width: number; height: number } | null;
  colors: Uint8Array | null;
  opacity: number;
  enabled: boolean;  // zoomed in past the threshold AND a polygon element is available
}

// Fetches the cell polygons intersecting the current viewport (debounced,
// LRU-cached, versioned by data_version) and returns a GeoArrowSolidPolygonLayer
// filled by each cell's mapped color. Mirrors useImageTiles: a module cache + a
// bump reducer so a settled fetch re-renders. No polygon element / not zoomed in →
// { layer: null }, so the session-without-polygons path is a no-op.
export function usePolygonBbox(
  { sessionId, element, version, viewState, size, colors, opacity, enabled }: Params,
): { layer: Layer | null; loading: boolean } {
  const [tick, bump] = useReducer((x: number) => x + 1, 0);
  const [settled, setSettled] = useState<Bbox | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last successfully built layer, kept on screen while the next viewport's
  // polygons load so the canvas never flips back to the point scatter mid-pan
  // (the flicker). Dropped when the geometry identity (session/element/version)
  // changes, since stale geometry from a different dataset must not linger.
  const lastLayer = useRef<Layer | null>(null);
  const lastIdentity = useRef<string>('');

  const zoom = viewState ? (Array.isArray(viewState.zoom) ? viewState.zoom[0] : viewState.zoom) ?? 0 : 0;
  const target = viewState?.target as number[] | undefined;
  const tx = target ? target[0] : 0;
  const ty = target ? target[1] : 0;

  useEffect(() => {
    if (!enabled || !viewState || !size) { setSettled(null); return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSettled(viewportBbox(viewState, size)), SETTLE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // viewState/size are read at fire time; the primitive deps drive re-arming.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, zoom, tx, ty, size?.width, size?.height]);

  return useMemo(() => {
    const identity = `${sessionId}:${element}:${version}`;
    if (lastIdentity.current !== identity) lastLayer.current = null;  // new dataset/element → drop stale geometry
    if (!enabled || !element || !colors) { lastLayer.current = null; return { layer: null, loading: false }; }
    // While the next bbox is settling or fetching, keep the previous polygons up.
    if (!settled) return { layer: lastLayer.current, loading: false };
    // Round the bbox to integers so sub-unit jitter doesn't churn the cache key.
    const b = settled.map(Math.round) as Bbox;
    const key = `${sessionId}:${element}:${version}:${b.join(',')}`;
    const table = getTable(key, sessionId, element, b, bump);
    if (!table) return { layer: lastLayer.current, loading: true };

    const layer = new GeoArrowSolidPolygonLayer({
      id: `cell-polygons-${element}`,
      data: table,
      getFillColor: buildFillColors(table, colors) as GeoArrowSolidPolygonLayerProps['getFillColor'],
      opacity,
      pickable: false,
      _validate: false,
      earcutWorkerUrl: null,  // triangulate on the main thread — no CDN worker fetch
    });
    lastLayer.current = layer;
    lastIdentity.current = identity;
    return { layer, loading: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, element, settled, colors, version, sessionId, opacity, tick]);
}
