import { useCallback, useRef } from 'react';
import { putDisplay } from '../../api';
import { useAppStore } from '../../store/sessionStore';
import type { DisplaySpec } from '../../types';

/** Shared display-persistence machinery for the spatial and embedding canvases.
 *
 * `persistDisplay` mirrors the change into the store immediately, then debounces the
 * PUT (500ms) so a slider drag or pan/rotate collapses into one write; a ref holds the
 * timer so back-to-back events during a drag reset the same debounce. A read-only
 * (snapshot) session stays interactive locally but never persists — the backend would
 * 403 the PUT anyway. `currentSpec` re-reads the latest stored spec (not the possibly
 * stale prop) so an encoding edit and a camera move in the same window don't clobber
 * each other. `updateEncoding` patches the encoding of that latest spec.
 */
export function useDisplayPersistence<T extends DisplaySpec>(
  display: T,
  sessionId: string,
  readOnly: boolean,
  isKind: (d: DisplaySpec) => d is T,
) {
  const updateDisplay = useAppStore((s) => s.updateDisplay);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistDisplay = useCallback((updated: T) => {
    updateDisplay(updated);
    if (readOnly) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      putDisplay(sessionId, updated).catch(console.error);
    }, 500);
  }, [updateDisplay, readOnly, sessionId]);

  const currentSpec = useCallback((): T => {
    const stored = useAppStore.getState().sessionState?.app_state.displays.find((d) => d.id === display.id);
    return stored && isKind(stored) ? stored : display;
  }, [display, isKind]);

  const updateEncoding = useCallback((patch: Partial<T['encoding']>) => {
    const base = currentSpec();
    persistDisplay({ ...base, encoding: { ...base.encoding, ...patch } } as T);
  }, [currentSpec, persistDisplay]);

  return { persistDisplay, currentSpec, updateEncoding };
}
