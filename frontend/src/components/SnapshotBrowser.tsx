import { useEffect, useState } from 'react';
import { getSnapshots } from '../api';
import { reportError } from '../lib/errors';
import type { Snapshot } from '../lib/snapshots';
import { ModalOverlay, ModalHeader } from './DetailModal';
import SnapshotList from './SnapshotList';

interface Props {
  onClose: () => void;
}

export default function SnapshotBrowser({ onClose }: Props) {
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    getSnapshots()
      .then(({ snapshots: s }) => {
        setSnapshots(s);
        if (s.length) setSelected(s[0].url);
      })
      .catch((err) => { reportError('Failed to load snapshots', err); setFailed(true); });
  }, []);

  return (
    <ModalOverlay onClose={onClose} widthClassName="w-[900px] max-w-[95vw] h-[80vh]">
      <ModalHeader
        title="Snapshots"
        subtitle="Browse saved snapshots and preview or open one."
        onClose={onClose}
      />

      <div className="flex-1 min-h-0 flex">
        <div className="w-64 shrink-0 border-r border-border overflow-y-auto">
          {failed && <div className="px-3 py-2 text-xs text-danger">Failed to load snapshots.</div>}
          {!failed && !snapshots && <div className="px-3 py-2 text-xs text-muted">Loading…</div>}
          {snapshots?.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted/70">No saved snapshots yet.</div>
          )}
          {snapshots && (
            <SnapshotList
              snapshots={snapshots}
              isSelected={(s) => s.url === selected}
              onSelect={(s) => setSelected(s.url)}
            />
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col p-3 gap-2">
          {selected ? (
            <>
              <div className="flex justify-end shrink-0">
                <a
                  href={selected}
                  target="_blank"
                  rel="noopener"
                  className="text-xs text-accent hover:underline"
                >
                  Open in new tab ↗
                </a>
              </div>
              <iframe
                src={selected}
                title="snapshot preview"
                className="flex-1 min-h-0 w-full bg-bg border border-border rounded"
              />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-muted/70">
              Select a snapshot to preview it.
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
