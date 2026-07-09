import { useEffect, useState } from 'react';
import { getSnapshots } from '../api';
import { reportError } from '../lib/errors';
import type { Snapshot } from '../lib/snapshots';
import { ModalOverlay, ModalHeader } from './DetailModal';
import SnapshotList from './SnapshotList';
import SnapshotViewer from './SnapshotViewer';

interface Props {
  onClose: () => void;
  initialSelect?: string | null;  // snapshot name to preselect (e.g. a just-saved one)
}

export default function SnapshotBrowser({ onClose, initialSelect }: Props) {
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    getSnapshots()
      .then(({ snapshots: s }) => {
        setSnapshots(s);
        const target = (initialSelect && s.find((x) => x.name === initialSelect)) || s[0];
        if (target) setSelected(target.url);
      })
      .catch((err) => { reportError('Failed to load snapshots', err); setFailed(true); });
  }, [initialSelect]);

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
            <div className="flex-1 min-h-0 w-full bg-bg border border-border rounded overflow-hidden">
              <SnapshotViewer key={selected} url={selected} />
            </div>
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
