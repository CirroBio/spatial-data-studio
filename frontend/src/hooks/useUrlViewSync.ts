// Keeps the address bar in step with the display settings, so the current view can be
// shared as a link (lib/urlViewState.ts holds the schema and the diff).
//
// Subscribes to the store rather than hooking useDisplayPersistence: that hook returns
// early on `!canEdit`, which is exactly the serverless case this feature is for, so its
// debounce never arms. It is also instantiated per canvas and cannot see store-only
// state like `mainView`. `updateDisplay` fires on every encoding and viewport change in
// every mode, so one subscription here sees everything.
//
// The URL is write-only after mount: the overlay is decoded once and memoized, nothing
// re-reads `location.search`, and `replaceState` adds no history entries — so there is
// no feedback loop and deliberately no `popstate` listener.
import { useEffect } from 'react';
import { isEmbeddingDisplay, isSpatialDisplay } from '@cirrobio/spatial-viewer';
import { useAppStore } from '../store/sessionStore';
import { buildOverlay, encodeViewOverlay, urlViewMalformed, viewHref } from '../lib/urlViewState';

// Shorter than the 500 ms display-persistence / embed-bridge debounce so the address
// bar settles first — a link copied right after a slider drag should already be current.
const URL_SYNC_DEBOUNCE_MS = 400;

let flush: (() => void) | null = null;
// The malformed-link notice belongs to the page load, not to a component lifecycle: the
// URL is decoded once, so say so once — StrictMode's double-invoked effects (and any
// remount) would otherwise stack duplicate toasts.
let notifiedMalformed = false;

/** Write the URL now rather than waiting out the debounce. "Copy link" calls this: a
 * link copied within the debounce window would otherwise be one edit stale. */
export function flushUrlViewState(): void {
  flush?.();
}

export function useUrlViewSync(enabled: boolean): void {
  // A truncated or stale link would otherwise show the checkpoint's own view with no
  // hint that the settings it carried were dropped.
  useEffect(() => {
    if (!enabled || notifiedMalformed || !urlViewMalformed()) return;
    notifiedMalformed = true;
    useAppStore.getState().pushNotification({
      kind: 'info',
      message: "This link's display settings couldn't be read — showing the saved view.",
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastWritten: string | null = null;

    const write = () => {
      timer = null;
      const state = useAppStore.getState();
      const displays = state.sessionState?.app_state.displays ?? [];
      const encoded = encodeViewOverlay(buildOverlay({
        spatial: displays.find(isSpatialDisplay) ?? null,
        embedding: displays.find(isEmbeddingDisplay) ?? null,
        mainView: state.mainView,
        leftMenuOpen: state.leftMenuOpen,
        expandedPlotId: state.expandedPlotId,
      }));
      if (encoded === lastWritten) return;
      lastWritten = encoded;
      window.history.replaceState(null, '', viewHref(encoded));
    };

    flush = () => {
      if (timer) clearTimeout(timer);
      write();
    };
    const unsubscribe = useAppStore.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(write, URL_SYNC_DEBOUNCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      flush = null;
      unsubscribe();
    };
  }, [enabled]);
}
