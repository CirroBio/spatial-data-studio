import { useEffect, useRef } from 'react';
import type { OrthographicViewState } from '@deck.gl/core';
import { getImageSize, type loadOmeZarr } from '@vivjs/loaders';

// Idle look-ahead tile prefetch for the Viv image path. deck.gl's TileLayer only ever
// requests the current viewport, so the first frames of a zoom/pan stall while the newly
// needed tiles fetch. This hook, once the camera has been still for a beat, warms the two
// tiles sets a gesture is about to need — the next finer pyramid level over the viewport
// (a zoom-in) and a one-tile ring at the current level (a pan) — by calling the same
// `loader[level].getTile` deck will call. The decoded result is discarded; the point is the
// browser HTTP cache entry, which the backend serves back to deck's real request as a cheap
// 304 revalidation (raster route sends `Cache-Control: no-cache` + a weak ETag), turning a
// full chunk download into a validator round-trip. Biggest win on slow/remote stores.
//
// It never rebuilds the image layer (a separate effect keyed on the camera, not the memo),
// aborts in flight the instant the camera moves again, and skips tiles it has already warmed.

type Loader = Awaited<ReturnType<typeof loadOmeZarr>>['data'];

interface Params {
  loader: Loader | null;
  selections: { c: number }[];
  viewState: OrthographicViewState | null;
  size: { width: number; height: number } | null;
  enabled: boolean;
  // The store URL — when it changes the image changed, so the warmed-tile set is stale.
  resetKey: string | null;
}

// Wait for the camera to settle before prefetching, so a continuous gesture doesn't fire
// (and immediately abort) a prefetch on every frame, and deck gets the connections first.
const PREFETCH_SETTLE_MS = 350;
// Cap tiles warmed per pass so a zoomed-out view of a huge pyramid can't enqueue hundreds
// of fetches; the finer-level set is filled first (the primary zoom-in win).
const MAX_PREFETCH_TILES = 24;
// Bound on the warmed-tile memo so it can't grow without limit over a long session.
const SEEN_LIMIT = 4000;

function scheduleIdle(cb: () => void): () => void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (ric) {
    const handle = ric(cb);
    const cancel = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
    return () => cancel?.(handle);
  }
  const t = setTimeout(cb, 0);
  return () => clearTimeout(t);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function useImageTilePrefetch(
  { loader, selections, viewState, size, enabled, resetKey }: Params,
): void {
  const seenRef = useRef<Set<string>>(new Set());
  const seenKeyRef = useRef<string | null>(null);

  const zoom = viewState
    ? (Array.isArray(viewState.zoom) ? viewState.zoom[0] : viewState.zoom) ?? 0
    : 0;
  const target = (viewState?.target as number[] | undefined) ?? undefined;
  const cx = target?.[0];
  const cy = target?.[1];

  useEffect(() => {
    if (resetKey !== seenKeyRef.current) {
      seenRef.current = new Set();
      seenKeyRef.current = resetKey;
    }
    if (!enabled || !loader || !loader.length || !size
        || cx === undefined || cy === undefined || !selections.length) {
      return;
    }

    const controller = new AbortController();
    let cancelIdle: (() => void) | null = null;
    const timer = setTimeout(() => {
      cancelIdle = scheduleIdle(() => {
        const seen = seenRef.current;
        const levels = loader.length;
        const currentLevel = clamp(-Math.ceil(zoom), 0, levels - 1);
        const unitsPerPixel = 2 ** -zoom;             // level-0 px per screen px
        const halfW0 = (size.width / 2) * unitsPerPixel;
        const halfH0 = (size.height / 2) * unitsPerPixel;

        // Fill the finer level first (the zoom-in look-ahead), then the current-level pan
        // ring, so the cap favors the primary win. currentLevel-1 clamps to currentLevel at
        // the finest level, and the dedup collapses that to a single pass.
        const finer = Math.max(0, currentLevel - 1);
        const tiles: Array<{ level: number; x: number; y: number }> = [];
        for (const level of finer === currentLevel ? [currentLevel] : [finer, currentLevel]) {
          const src = loader[level];
          const { width: W, height: H } = getImageSize(src);
          const ts = src.tileSize;
          const nx = Math.max(1, Math.ceil(W / ts));
          const ny = Math.max(1, Math.ceil(H / ts));
          const scale = 2 ** level;                   // level-0 px per level-`level` px
          const pad = level === currentLevel ? 1 : 0; // ring for pan; finer set is already ~4x area
          const tx0 = clamp(Math.floor((cx - halfW0) / scale / ts) - pad, 0, nx - 1);
          const tx1 = clamp(Math.floor((cx + halfW0) / scale / ts) + pad, 0, nx - 1);
          const ty0 = clamp(Math.floor((cy - halfH0) / scale / ts) - pad, 0, ny - 1);
          const ty1 = clamp(Math.floor((cy + halfH0) / scale / ts) + pad, 0, ny - 1);
          for (let y = ty0; y <= ty1; y++) {
            for (let x = tx0; x <= tx1; x++) tiles.push({ level, x, y });
          }
        }

        let budget = MAX_PREFETCH_TILES;
        for (const { level, x, y } of tiles) {
          if (budget <= 0) break;
          const key = `${level}:${x}:${y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          budget -= 1;
          for (const selection of selections) {
            loader[level].getTile({ x, y, selection, signal: controller.signal })
              .catch(() => { /* aborted, 404 fill chunk, or transient — deck will refetch */ });
          }
        }
        // Bound the memo: drop the oldest keys once it overflows (Set preserves insert order).
        if (seen.size > SEEN_LIMIT) {
          const excess = seen.size - SEEN_LIMIT;
          const it = seen.values();
          for (let i = 0; i < excess; i++) seen.delete(it.next().value as string);
        }
      });
    }, PREFETCH_SETTLE_MS);

    return () => {
      clearTimeout(timer);
      cancelIdle?.();
      controller.abort();
    };
  }, [enabled, loader, selections, cx, cy, zoom, size?.width, size?.height, resetKey]);
}
