import { useEffect, useMemo, useState } from 'react';
import { getSnapshots, deleteSnapshot, snapshotFileUrl, snapshotThumbnailUrl } from '../api';
import { reportError } from '../lib/errors';
import { useAppStore } from '../store/sessionStore';
import { formatCreated, type Snapshot } from '../lib/snapshots';
import { ModalOverlay, ModalHeader } from './DetailModal';

interface Props {
  onClose: () => void;
  initialSelect?: string | null;  // snapshot name to preselect (e.g. a just-saved one)
}

// A gallery of saved snapshot figures: a thumbnail grid plus a detail panel showing the
// selected figure's provenance and download links (the PDF/PNG the user rendered). A
// snapshot is a rendered artifact, not a re-openable session — this only browses and
// downloads them.
export default function SnapshotBrowser({ onClose, initialSelect }: Props) {
  const { pushNotification } = useAppStore();
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    getSnapshots()
      .then(({ snapshots: s }) => {
        setSnapshots(s);
        const target = (initialSelect && s.find((x) => x.name === initialSelect)) || s[0];
        if (target) setSelected(target.name);
      })
      .catch((err) => { reportError('Failed to load snapshots', err); setFailed(true); });
  }, [initialSelect]);

  const current = useMemo(() => snapshots?.find((s) => s.name === selected) ?? null, [snapshots, selected]);

  async function remove(s: Snapshot) {
    try {
      await deleteSnapshot(s.name);
      setSnapshots((list) => {
        const next = (list ?? []).filter((x) => x.name !== s.name);
        setSelected((sel) => (sel === s.name ? next[0]?.name ?? null : sel));
        return next;
      });
    } catch (err) {
      reportError('Failed to delete snapshot', err);
      pushNotification({ kind: 'error', message: 'Could not delete snapshot.' });
    }
  }

  return (
    <ModalOverlay onClose={onClose} widthClassName="w-[820px] max-w-[95vw] h-[70vh]">
      <ModalHeader title="Snapshots" subtitle="Saved figures — download a PDF/PNG or review how it was generated." onClose={onClose} />

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-h-0 overflow-y-auto border-t border-r border-border p-3">
          {failed && <div className="px-1 py-2 text-xs text-danger">Failed to load snapshots.</div>}
          {!failed && !snapshots && <div className="px-1 py-2 text-xs text-muted">Loading…</div>}
          {snapshots?.length === 0 && (
            <div className="px-1 py-2 text-xs text-muted/70">No saved snapshots yet — use Save snapshot on a canvas.</div>
          )}
          <div className="grid grid-cols-2 gap-3">
            {snapshots?.map((s) => (
              <button
                key={s.name}
                onClick={() => setSelected(s.name)}
                title={s.label}
                className={`flex flex-col rounded border overflow-hidden text-left transition-colors ${
                  s.name === selected ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-accent/60'
                }`}
              >
                <img src={snapshotThumbnailUrl(s.name)} alt={s.label}
                  className="w-full aspect-[4/3] object-contain bg-black/20" loading="lazy" />
                <span className="px-2 py-1.5 min-w-0">
                  <span className="block text-xs font-medium truncate text-text">{s.label}</span>
                  <span className="block text-[10px] text-muted/70">{s.kind} · {formatCreated(s.created)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="w-72 shrink-0 border-t border-border overflow-y-auto">
          {current ? (
            <SnapshotDetail snapshot={current} onDelete={() => remove(current)} />
          ) : (
            <div className="p-3 text-xs text-muted/70">Select a snapshot.</div>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}

function SnapshotDetail({ snapshot, onDelete }: { snapshot: Snapshot; onDelete: () => void }) {
  const m = snapshot.metadata;
  const vp = m.viewport ?? {};
  return (
    <div className="p-3 flex flex-col gap-3 text-xs">
      <div>
        <div className="text-sm font-medium text-text truncate">{snapshot.label}</div>
        <div className="text-[11px] text-muted/70">{formatCreated(snapshot.created)}</div>
      </div>

      <div className="flex flex-wrap gap-2">
        {snapshot.formats.map((f) => (
          <a key={f} href={snapshotFileUrl(snapshot.name, f)} download
            className="px-3 py-1.5 bg-accent hover:bg-accent/80 text-white rounded text-xs transition-colors">
            Download {f.toUpperCase()}
          </a>
        ))}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted">Dataset</dt><dd className="text-text truncate" title={m.dataset}>{m.dataset ?? '—'}</dd>
        <dt className="text-muted">Kind</dt><dd className="text-text">{snapshot.kind}</dd>
        <dt className="text-muted">Size</dt><dd className="text-text tabular-nums">{snapshot.output.width_px}×{snapshot.output.height_px} · {snapshot.output.dpi} DPI</dd>
        <dt className="text-muted">Zoom</dt><dd className="text-text tabular-nums">{typeof vp.zoom === 'number' ? vp.zoom.toFixed(2) : '—'}</dd>
        {m.render?.image_element && (<><dt className="text-muted">Image</dt><dd className="text-text truncate">{m.render.image_element}</dd></>)}
        {m.render?.rasterized_points && (<><dt className="text-muted">Points</dt><dd className="text-warn">rasterized</dd></>)}
        {typeof m.encoding?.color_by === 'string' && (<><dt className="text-muted">Color by</dt><dd className="text-text truncate">{String(m.encoding.color_by)}</dd></>)}
      </dl>

      <div>
        <div className="text-muted mb-1">Analysis ({m.recipe?.length ?? 0} steps)</div>
        <div className="max-h-40 overflow-y-auto rounded border border-border/60 divide-y divide-border/40">
          {(m.recipe ?? []).length === 0 && <div className="px-2 py-1 text-muted/60">No recorded steps.</div>}
          {(m.recipe ?? []).map((step, i) => (
            <div key={i} className="px-2 py-1 text-[11px] text-text truncate" title={`${step.namespace}.${step.function}`}>
              {step.namespace}.{step.function}
            </div>
          ))}
        </div>
      </div>

      <button onClick={onDelete}
        className="mt-1 px-3 py-1.5 border border-danger/50 text-danger hover:bg-danger/10 rounded text-xs transition-colors self-start">
        Delete snapshot
      </button>
    </div>
  );
}
