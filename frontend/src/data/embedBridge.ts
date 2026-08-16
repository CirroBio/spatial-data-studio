// Embed mode: the viewer runs inside an iframe hosted by a Cirro dashboard that
// owns the display settings (docs/EMBED_PROTOCOL.md, v1). Once the checkpoint is
// open the viewer posts `ready` with the checkpoint's inventory, streams debounced
// `display-changed` events as the user edits in-canvas, answers `search-vars`
// through the checkpoint DataSource, and applies the parent's `apply-display` /
// `select-display` to the store exactly as local edits would land.
import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/sessionStore';
import {
  isEmbeddingDisplay,
  isSpatialDisplay,
  type DisplayEncoding,
  type DisplaySpec,
  type EmbeddingEncoding,
  type EmbeddingDisplaySpec,
  type SpatialDisplaySpec,
  type Viewport,
} from '@cirrobio/spatial-viewer';
import type { CheckpointSession } from './useCheckpointSession';

const EMBED_MESSAGE_SOURCE = 'sds-embed';
const PARENT_MESSAGE_SOURCE = 'cirro-dashboard';
const PROTOCOL_VERSION = 1;
// Matches the display-persistence debounce: a slider drag or pan collapses into one event.
const DISPLAY_CHANGED_DEBOUNCE_MS = 500;

// The persisted display shape (DisplaySpec without id), keyed `kind` per the protocol.
export type EmbedDisplayPayload =
  | { kind: 'spatial_canvas'; encoding: DisplayEncoding; viewport: Viewport | null }
  | { kind: 'embedding_canvas'; encoding: EmbeddingEncoding; viewport: Viewport | null };

export interface EmbedInventory {
  displays: Array<{ id: string; name: string } & EmbedDisplayPayload>;
  obsColumns: Array<{ name: string; kind: 'categorical' | 'numeric' }>;
  images: Array<{
    element: string;
    channelNames: string[];
    isRgb: boolean;
    contrastRange: [number, number][];
  }>;
  obsmKeys: Array<{ key: string; nComponents: number }>;
}

type ViewerMessage =
  | { type: 'ready'; inventory: EmbedInventory }
  | { type: 'display-changed'; display: EmbedDisplayPayload }
  | { type: 'search-vars-result'; requestId: string; names: string[] }
  | { type: 'refresh-checkpoint-url'; requestId: string }
  | { type: 'error'; message: string };

type ParentMessage =
  | { type: 'apply-display'; display: EmbedDisplayPayload }
  | { type: 'select-display'; displayId: string }
  | { type: 'search-vars'; requestId: string; query: string; limit?: number };

function postToParent(message: ViewerMessage): void {
  // targetOrigin '*' for v1 — the parent validates event.source (see the protocol doc).
  window.parent.postMessage(
    { source: EMBED_MESSAGE_SOURCE, version: PROTOCOL_VERSION, ...message },
    '*',
  );
}

function isParentMessage(data: unknown): data is ParentMessage {
  const msg = data as { source?: unknown; version?: unknown; type?: unknown } | null;
  return (
    !!msg &&
    msg.source === PARENT_MESSAGE_SOURCE &&
    msg.version === PROTOCOL_VERSION &&
    (msg.type === 'apply-display' || msg.type === 'select-display' || msg.type === 'search-vars')
  );
}

// How long the host gets to answer a re-sign request before the read that
// triggered it gives up. Generous: the host may round-trip to its own API.
const CHECKPOINT_URL_TIMEOUT_MS = 15_000;

let checkpointUrlRequests = 0;

/**
 * Ask the embed host for a freshly signed checkpoint URL. Wired into the
 * checkpoint reader (`CheckpointUrlRefresher`), which calls this when a range
 * read comes back expired — the host's URLs are short-lived and a session
 * outlives them. Each call listens for its own `requestId` only, so concurrent
 * requests can't cross-resolve.
 */
export function requestFreshCheckpointUrl(): Promise<string> {
  checkpointUrlRequests += 1;
  const requestId = `checkpoint-url-${checkpointUrlRequests}`;
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as {
        source?: unknown; version?: unknown; type?: unknown; requestId?: unknown; url?: unknown;
      } | null;
      if (
        !msg || msg.source !== PARENT_MESSAGE_SOURCE || msg.version !== PROTOCOL_VERSION ||
        msg.type !== 'checkpoint-url' || msg.requestId !== requestId
      ) return;
      cleanup();
      if (typeof msg.url === 'string' && msg.url) resolve(msg.url);
      else reject(new Error('The dashboard could not refresh the checkpoint URL'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for a refreshed checkpoint URL'));
    }, CHECKPOINT_URL_TIMEOUT_MS);
    function cleanup(): void {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
    }
    window.addEventListener('message', onMessage);
    postToParent({ type: 'refresh-checkpoint-url', requestId });
  });
}

function payloadFromSpec(spec: DisplaySpec): EmbedDisplayPayload {
  return spec.type === 'spatial_canvas'
    ? { kind: 'spatial_canvas', encoding: spec.encoding, viewport: spec.viewport }
    : { kind: 'embedding_canvas', encoding: spec.encoding, viewport: spec.viewport };
}

// Displays carry no persisted name (DisplaySpec has none); label them by what
// they show, the way the view switcher does.
function displayName(spec: DisplaySpec): string {
  return spec.type === 'spatial_canvas'
    ? `Spatial (${spec.encoding.coords})`
    : `Embedding (${spec.encoding.obsm_key})`;
}

/** The display the embed host is editing: the one the main view renders (App
 * shows the first display of the active kind). */
function activeDisplay(state = useAppStore.getState()): DisplaySpec | null {
  const displays = state.sessionState?.app_state.displays ?? [];
  return (
    (state.mainView === 'embedding'
      ? displays.find(isEmbeddingDisplay)
      : displays.find(isSpatialDisplay)) ?? null
  );
}

/** Viewer side of the embed protocol. `enabled` is the embed-mode gate — the hook
 * is inert (no listener, no messages) when false. */
export function useEmbedBridge(enabled: boolean, checkpoint: CheckpointSession): void {
  // Serialized payload of the last display-changed sent (or apply-display received):
  // a store change that round-trips to the same payload is an echo, not an edit.
  const lastSent = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !checkpoint.error) return;
    postToParent({ type: 'error', message: checkpoint.error });
  }, [enabled, checkpoint.error]);

  useEffect(() => {
    if (!enabled || !checkpoint.source) return;
    const source = checkpoint.source;
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const sendDisplayChanged = () => {
      const display = activeDisplay();
      if (!display) return;
      const payload = payloadFromSpec(display);
      const json = JSON.stringify(payload);
      if (json === lastSent.current) return;
      lastSent.current = json;
      postToParent({ type: 'display-changed', display: payload });
    };

    // Full replacement of the active display of the payload's kind, exactly as a
    // user edit lands: optimistic store write (persistence PUTs are already
    // no-oped read-only), main view switched to the display's kind, and the
    // isolated category re-seeded from the spatial encoding. `lastSent` is primed
    // with the resulting payload first so the store subscription below sees the
    // change as an echo and does not re-emit display-changed.
    const applyDisplay = (payload: EmbedDisplayPayload) => {
      const store = useAppStore.getState();
      const displays = store.sessionState?.app_state.displays ?? [];
      if (payload.kind === 'spatial_canvas') {
        const target = displays.find(isSpatialDisplay);
        if (!target) return;
        const updated: SpatialDisplaySpec = {
          ...target,
          encoding: payload.encoding,
          viewport: payload.viewport,
        };
        lastSent.current = JSON.stringify(payloadFromSpec(updated));
        store.updateDisplay(updated);
        store.setMainView('canvas');
        store.setIsolatedCategory(payload.encoding.isolated_category ?? null);
      } else {
        const target = displays.find(isEmbeddingDisplay);
        if (!target) return;
        const updated: EmbeddingDisplaySpec = {
          ...target,
          encoding: payload.encoding,
          viewport: payload.viewport,
        };
        lastSent.current = JSON.stringify(payloadFromSpec(updated));
        store.updateDisplay(updated);
        store.setMainView('embedding');
      }
    };

    // The main view renders the first display of each kind, so promote the
    // selected one to the front of its kind, then switch the view to it.
    const selectDisplay = (displayId: string): boolean => {
      const store = useAppStore.getState();
      const state = store.sessionState;
      const target = state?.app_state.displays.find((d) => d.id === displayId);
      if (!state || !target) return false;
      const displays = [target, ...state.app_state.displays.filter((d) => d !== target)];
      store.setSessionState({ ...state, app_state: { ...state.app_state, displays } });
      store.setMainView(isSpatialDisplay(target) ? 'canvas' : 'embedding');
      if (isSpatialDisplay(target)) {
        store.setIsolatedCategory(target.encoding.isolated_category ?? null);
      }
      return true;
    };

    // `ready`: useCheckpointSession installs the session state before resolving
    // `source`, so the inventory reads synchronously from the store — only the
    // per-image channel metadata needs fetching.
    (async () => {
      const state = useAppStore.getState().sessionState;
      if (!state) return;
      const images = await Promise.all(
        state.fields.images.map(async (element) => {
          try {
            const info = await source.getImageInfo(element);
            return {
              element,
              channelNames: info.channel_names,
              isRgb: info.is_rgb ?? false,
              contrastRange: info.contrast_range ?? info.contrast_limits ?? [],
            };
          } catch {
            // A broken image element degrades its inventory entry, not the handshake.
            return { element, channelNames: [], isRgb: false, contrastRange: [] };
          }
        }),
      );
      if (cancelled) return;
      // Prime the echo guard so mounting the first display doesn't immediately
      // repeat what the inventory already carries.
      const active = activeDisplay();
      if (active) lastSent.current = JSON.stringify(payloadFromSpec(active));
      postToParent({
        type: 'ready',
        inventory: {
          displays: state.app_state.displays.map((d) => ({
            id: d.id,
            name: displayName(d),
            ...payloadFromSpec(d),
          })),
          obsColumns: state.fields.obs.map(({ name, kind }) => ({ name, kind })),
          images,
          obsmKeys: state.fields.obsm.map((f) => ({ key: f.name, nComponents: f.n_components })),
        },
      });
    })();

    const unsubscribe = useAppStore.subscribe((state) => {
      const display = activeDisplay(state);
      if (!display) return;
      if (JSON.stringify(payloadFromSpec(display)) === lastSent.current) return;
      if (debounce) clearTimeout(debounce);
      // Re-read the store at fire time: whatever landed last is what gets posted,
      // and an apply-display that arrives mid-debounce cancels the emission via
      // the lastSent re-check.
      debounce = setTimeout(() => {
        debounce = null;
        sendDisplayChanged();
      }, DISPLAY_CHANGED_DEBOUNCE_MS);
    });

    const onMessage = (event: MessageEvent) => {
      if (!isParentMessage(event.data)) return;
      const msg = event.data;
      if (msg.type === 'apply-display') {
        applyDisplay(msg.display);
      } else if (msg.type === 'select-display') {
        if (selectDisplay(msg.displayId)) {
          // Respond immediately with the newly active display's payload — always,
          // even when the selection was already active (drop the echo guard).
          if (debounce) {
            clearTimeout(debounce);
            debounce = null;
          }
          lastSent.current = null;
          sendDisplayChanged();
        }
      } else if (msg.type === 'search-vars') {
        source
          .searchVarNames(msg.query, msg.limit)
          .then((names) => postToParent({ type: 'search-vars-result', requestId: msg.requestId, names }))
          .catch(() => postToParent({ type: 'search-vars-result', requestId: msg.requestId, names: [] }));
      }
    };
    window.addEventListener('message', onMessage);

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      unsubscribe();
      window.removeEventListener('message', onMessage);
    };
  }, [enabled, checkpoint.source]);
}
