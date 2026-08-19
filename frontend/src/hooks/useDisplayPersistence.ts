import { useCallback, useEffect, useRef } from 'react';
import { putDisplay } from '../api';
import { useAppStore } from '../store/sessionStore';
import type { DisplaySpec } from '@cirrobio/spatial-viewer';

/** What display persistence means in the Studio app — the `onDisplayChange` /
 * `currentSpec` half of the canvas host (components/canvas/canvas-host.tsx).
 *
 * `onDisplayChange` mirrors the change into the store immediately, then debounces the
 * PUT (500ms) so a slider drag or pan/rotate collapses into one write; a ref holds the
 * timer so back-to-back events during a drag reset the same debounce. Without the edit
 * gate (`canEdit`: a read-only snapshot, or another viewer holds the session's lock) the
 * canvas stays fully interactive but persists nothing — display settings then live on
 * this screen only, and the backend would refuse the PUT anyway. `currentSpec` re-reads
 * the latest stored spec (not the possibly stale one the caller holds) so an encoding
 * edit and a camera move in the same window don't clobber each other.
 *
 * The PUT always sends the latest *stored* spec (`currentSpec()`) at send time, never a
 * value captured when the timer was scheduled: `pending` marks that an edit is unsent
 * (and which display it was), and both the debounce and the flusher re-resolve it
 * through `currentSpec`. Since every edit merges into the store synchronously, whatever
 * landed last is what gets persisted — and the `display.updated` echo the backend
 * broadcasts back carries the current color, not a stale one. Capturing the scheduled
 * value instead would let an in-flight timer PUT (and echo) a pre-edit spec, reverting a
 * just-picked channel color.
 *
 * The hook also registers a flusher with the store so a session refetch
 * (refreshSessionState) can send the pending PUT first — otherwise the refetch reads the
 * server's pre-edit copy and reverts the just-made edit.
 */
export function useDisplayPersistence(sessionId: string, canEdit: boolean): {
  onDisplayChange: (updated: DisplaySpec) => void;
  currentSpec: (display: DisplaySpec) => DisplaySpec;
} {
  const updateDisplay = useAppStore((s) => s.updateDisplay);
  const registerDisplayFlush = useAppStore((s) => s.registerDisplayFlush);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The display an unsent edit belongs to; doubles as the dirty flag. Only its identity
  // is used — the spec itself is re-read from the store at send time.
  const pending = useRef<DisplaySpec | null>(null);

  const currentSpec = useCallback((display: DisplaySpec): DisplaySpec => {
    const stored = useAppStore.getState().sessionState?.app_state.displays.find((d) => d.id === display.id);
    return stored?.type === display.type ? stored : display;
  }, []);

  const send = useCallback((): Promise<void> | null => {
    const display = pending.current;
    if (!display) return null;
    pending.current = null;
    return putDisplay(sessionId, currentSpec(display));
  }, [sessionId, currentSpec]);

  const flush = useCallback(async () => {
    if (persistTimer.current) { clearTimeout(persistTimer.current); persistTimer.current = null; }
    await send();
  }, [send]);

  useEffect(() => {
    const unregister = registerDisplayFlush(flush);
    return () => {
      // Cancel the *unattended* half only. A timer that survives the unmount (or a
      // session switch, which is the other thing that re-runs this effect) fires with no
      // component behind it and re-resolves `currentSpec` against whatever session the
      // store holds by then — writing one session's display onto another. The pending
      // edit itself is deliberately left set: `flush` stays callable, so a
      // refreshSessionState that already took it out of the registry still sends it, and
      // "flush before save" doesn't become a dropped edit. Once unregistered, no later
      // refresh can reach this hook, so nothing else can resurrect the edit either.
      unregister();
      if (persistTimer.current) { clearTimeout(persistTimer.current); persistTimer.current = null; }
    };
  }, [registerDisplayFlush, flush]);

  const onDisplayChange = useCallback((updated: DisplaySpec) => {
    updateDisplay(updated);
    if (!canEdit) return;
    pending.current = updated;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null;
      send()?.catch(console.error);
    }, 500);
  }, [updateDisplay, canEdit, send]);

  return { onDisplayChange, currentSpec };
}
