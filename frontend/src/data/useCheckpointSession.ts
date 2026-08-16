// Serverless mode: open a `.zarr.zip` checkpoint and present it to the rest of the
// app as a read-only session, so the canvas, pickers and settings panel work exactly
// as they do against a live one (DESIGN §14).
//
// `read_only: true` on the synthetic summary is the whole edit gate — `editBlockReason`
// already blocks every mutating action for a read-only session, so nothing here needs
// a second notion of "can't write".
import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import {
  isSpatialDisplay, openCheckpoint,
  type CheckpointUrlRefresher, type DataSource,
} from '@cirrobio/spatial-viewer';
import type { AppState, SessionState } from '../types';

function displayName(url: string): string {
  const last = url.split('/').pop() ?? url;
  return decodeURIComponent(last.split('?')[0]) || 'Checkpoint';
}

export interface CheckpointSession {
  source: DataSource | null;
  loading: boolean;
  error: string | null;
}

/** Open `target` and install it as the active (read-only) session. Returns the data
 * source the canvas should read through. `refreshUrl` (embed mode) re-signs the
 * checkpoint URL when it expires mid-session. */
export function useCheckpointSession(
  target: string | File | null,
  refreshUrl?: CheckpointUrlRefresher,
): CheckpointSession {
  const [source, setSource] = useState<DataSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!target);

  useEffect(() => {
    if (!target) {
      setSource(null);
      setLoading(false);
      return;
    }
    let stale = false;
    setLoading(true);
    setError(null);

    openCheckpoint(target, refreshUrl)
      .then(({ source: opened, appState, fields }) => {
        if (stale) return;
        const summary = {
          id: opened.id,
          name: displayName(typeof target === 'string' ? target : target.name),
          status: 'ready' as const,
          resident_mb: 0,
          parent_id: null,
          created_at: new Date().toISOString(),
          saved: true,
          read_only: true,
          error: null,
        };
        const state: SessionState = {
          summary,
          app_state: appState as unknown as AppState,
          queue: [],
          fields,
          // Nothing can recompute a checkpoint, so no field is ever invalidated and
          // every version stays at the useArrowField cache's default.
          data_versions: {},
        };
        const store = useAppStore.getState();
        store.upsertSession(summary);
        // Same order as the live path (`refreshSessionState`): activate first —
        // `setActiveSessionId` clears the isolated category — then apply the state
        // and restore the isolate the display was saved with.
        store.setActiveSessionId(summary.id);
        store.setSessionState(state);
        const spatial = state.app_state.displays.find(isSpatialDisplay);
        store.setIsolatedCategory(spatial?.encoding.isolated_category ?? null);
        setSource(opened);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (stale) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => { stale = true; };
  }, [target]);

  return { source, loading, error };
}
