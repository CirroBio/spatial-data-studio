import { useEffect, useState } from 'react';
import type { loadOmeZarr } from '@vivjs/loaders';

type Loader = Awaited<ReturnType<typeof loadOmeZarr>>['data'];

// deck.gl's TileLayer (visible viewport) and the idle look-ahead prefetch both fetch pyramid
// chunks through `loader[level].getTile` — deck exposes no request-start callback (onTileLoad
// / onTileError only fire on completion), so wrapping that one method on each pyramid level is
// the one place that sees every tile fetch the moment it begins. A cache hit never calls
// getTile, so this reflects real network/decode work, not repaints.
//
// Viv fetches one chunk per channel per tile (getTileData does `Promise.all(selections.map…)`),
// so we refcount by spatial tile `level:x:y` and count distinct tiles — the granularity the
// user expects, not one-per-channel (up to 6x for fluorescence).
type Source = { getTile: (opts: { x?: number; y?: number }) => Promise<unknown> };

// A loading "session" opens when the first tile starts and stays open until no tiles are in
// flight AND at least this long has passed since it opened (so a burst that finishes in a few
// hundred ms still shows a readable bar). `value` is completed/requested over the open session.
const MIN_OPEN_MS = 1000;

export interface TileLoadProgress {
  active: boolean;
  value: number; // 0..1: completed tiles / total requested this session
}

/** Progress of the current image-tile loading session (viewport + prefetch fetches). */
export function useTileLoadProgress(loader: Loader | null): TileLoadProgress {
  const [progress, setProgress] = useState<TileLoadProgress>({ active: false, value: 0 });

  useEffect(() => {
    setProgress({ active: false, value: 0 });
    if (!loader) return;

    const inFlight = new Map<string, number>(); // level:x:y -> channel fetches outstanding
    let requested = 0;   // distinct tiles requested since the session opened
    let completed = 0;   // distinct tiles finished since the session opened
    let open = false;
    let startedAt = 0;
    let minTimer = 0;
    let raf = 0;

    // Coalesce request/settle bursts into one state update per frame.
    const emit = () => {
      raf = 0;
      setProgress({ active: open, value: requested > 0 ? completed / requested : 0 });
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(emit); };

    const tryClose = () => {
      if (!open || inFlight.size > 0) return;
      const elapsed = performance.now() - startedAt;
      if (elapsed >= MIN_OPEN_MS) {
        open = false;
        requested = 0;
        completed = 0;
        if (minTimer) { clearTimeout(minTimer); minTimer = 0; }
        schedule();
      } else if (!minTimer) {
        minTimer = window.setTimeout(() => { minTimer = 0; tryClose(); }, MIN_OPEN_MS - elapsed);
      }
    };

    const restores = (loader as unknown as Source[]).map((src, level) => {
      const original = src.getTile.bind(src);
      src.getTile = (opts) => {
        const key = `${level}:${opts?.x}:${opts?.y}`;
        const priorForKey = inFlight.get(key) ?? 0;
        if (priorForKey === 0) {
          // A distinct tile begins. Open the session on the first one.
          if (!open) { open = true; startedAt = performance.now(); requested = 0; completed = 0; }
          requested += 1;
        }
        inFlight.set(key, priorForKey + 1);
        schedule();
        const settle = () => {
          const remaining = (inFlight.get(key) ?? 1) - 1;
          if (remaining <= 0) { inFlight.delete(key); completed += 1; } else inFlight.set(key, remaining);
          schedule();
          tryClose();
        };
        return original(opts).then(
          (v) => { settle(); return v; },
          (e) => { settle(); throw e; },
        );
      };
      return () => { src.getTile = original; };
    });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (minTimer) clearTimeout(minTimer);
      restores.forEach((restore) => restore());
    };
  }, [loader]);

  return progress;
}
