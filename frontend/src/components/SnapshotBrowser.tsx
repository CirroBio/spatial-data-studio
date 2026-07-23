import { useEffect, useState } from 'react';
import { getSnapshots, openSnapshot } from '../api';
import { reportError } from '../lib/errors';
import { formatError } from '../lib/format';
import { useAppStore } from '../store/sessionStore';
import type { Snapshot } from '../lib/snapshots';
import type { SessionSummary } from '../types';
import { ModalOverlay, ModalHeader } from './DetailModal';
import SnapshotList from './SnapshotList';

interface Props {
  onClose: () => void;
  initialSelect?: string | null;  // snapshot name to preselect (e.g. a just-saved one)
}

// Opens a saved snapshot as a read-only session pinned to its saved view — the
// server-delivered replacement for the old standalone browser viewer (a snapshot
// only opens through this running app now). Mirrors NewSessionDialog's async
// checkpoint-load flow: POST returns a `loading` shell, then a client-minted
// `load_id` follows the terminal `session.loading` SSE event before the session
// becomes active.
export default function SnapshotBrowser({ onClose, initialSelect }: Props) {
  const { upsertSession, setActiveSessionId, pushNotification, loadProgress } = useAppStore();
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadId, setLoadId] = useState<string | null>(null);
  const [pendingSession, setPendingSession] = useState<SessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSnapshots()
      .then(({ snapshots: s }) => {
        setSnapshots(s);
        const target = (initialSelect && s.find((x) => x.name === initialSelect)) || s[0];
        if (target) setSelected(target.name);
      })
      .catch((err) => { reportError('Failed to load snapshots', err); setFailed(true); });
  }, [initialSelect]);

  async function openSelected() {
    if (!selected) return;
    setError(null);
    const id = crypto.randomUUID();
    setLoadId(id);
    try {
      const session = await openSnapshot(selected, id);
      setPendingSession(session);  // runs on the worker; finalized by the effect below
    } catch (err) {
      setError(formatError(err));
      setLoadId(null);
    }
  }

  useEffect(() => {
    if (!loadId || !pendingSession) return;
    if (loadProgress?.load_id !== loadId || !loadProgress.done) return;
    if (loadProgress.status === 'errored') {
      setError(loadProgress.error ?? 'Failed to open snapshot');
      setLoadId(null);
      setPendingSession(null);
      return;
    }
    if (loadProgress.hash_check) {
      pushNotification({
        kind: loadProgress.hash_check.ok ? 'info' : 'error',
        message: loadProgress.hash_check.message,
      });
    }
    upsertSession(pendingSession);
    setActiveSessionId(pendingSession.id);
    onClose();
  }, [loadProgress, loadId, pendingSession, onClose, pushNotification, upsertSession, setActiveSessionId]);

  const opening = loadId !== null;

  return (
    <ModalOverlay onClose={onClose} widthClassName="w-[480px] max-w-[95vw] h-[70vh]">
      <ModalHeader
        title="Snapshots"
        subtitle="Open a saved snapshot as a read-only session at its pinned view."
        onClose={onClose}
      />

      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto border-t border-border">
          {failed && <div className="px-3 py-2 text-xs text-danger">Failed to load snapshots.</div>}
          {!failed && !snapshots && <div className="px-3 py-2 text-xs text-muted">Loading…</div>}
          {snapshots?.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted/70">No saved snapshots yet.</div>
          )}
          {snapshots && (
            <SnapshotList
              snapshots={snapshots}
              isSelected={(s) => s.name === selected}
              onSelect={(s) => setSelected(s.name)}
            />
          )}
        </div>

        {error && <div className="px-3 py-2 text-xs text-danger">{error}</div>}

        <div className="p-3 border-t border-border flex justify-end">
          <button
            onClick={openSelected}
            disabled={!selected || opening}
            className="px-4 py-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white rounded text-sm transition-colors"
          >
            {opening ? 'Opening…' : 'Open'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
