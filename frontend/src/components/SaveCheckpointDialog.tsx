import { useEffect, useMemo, useState } from 'react';
import { getElements, saveSession, type SdataFacet, type SizedElements } from '../api';
import { formatError, isSpatialDisplay, reportError } from '@cirrobio/spatial-viewer';
import { useAppStore } from '../store/sessionStore';
import { ModalHeader, ModalOverlay } from './DetailModal';

interface Props {
  sessionId: string;
  onClose: () => void;
}

interface Row {
  facet: SdataFacet;
  name: string;
  detail: string;
  size: number | null;
  // The active table anchors every field path and display in the checkpoint, so it
  // can't be dropped — the backend rejects that too.
  locked?: boolean;
}

const FACET_LABELS: Record<SdataFacet, string> = {
  tables: 'Tables', images: 'Images', labels: 'Labels', shapes: 'Shapes', points: 'Points',
};

const rowKey = (r: Row) => `${r.facet}/${r.name}`;

// Tables first — everything else annotates them. Element details mirror what the data
// inspector shows for the same facet (DataInspector.tsx).
function buildRows(inv: SizedElements): Row[] {
  return [
    ...inv.tables.map((t) => ({
      facet: 'tables' as const, name: t.name, size: t.size_mb, locked: t.active,
      detail: `${t.n_obs.toLocaleString()} obs × ${t.n_vars.toLocaleString()} vars`,
    })),
    ...inv.images.map((i) => ({ facet: 'images' as const, name: i.name, size: i.size_mb, detail: '' })),
    ...inv.labels.map((l) => ({ facet: 'labels' as const, name: l.name, size: l.size_mb, detail: '' })),
    ...inv.shapes.map((s) => ({
      facet: 'shapes' as const, name: s.name, size: s.size_mb,
      detail: `${s.count.toLocaleString()} ${s.geometry.join('/') || 'rows'}`,
    })),
    ...inv.points.map((p) => ({
      facet: 'points' as const, name: p.name, size: p.size_mb,
      detail: `${p.columns.length} cols`,
    })),
  ];
}

/** Sizes arrive in MB rounded to 0.1, so anything under that floor reads as "0.0 MB"
 * unless it's called out as small. `null` is the backend's "not estimable". */
function formatSize(mb: number | null): string {
  if (mb === null) return 'unknown';
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  if (mb < 0.1) return '<0.1 MB';
  return `${mb.toFixed(1)} MB`;
}

export default function SaveCheckpointDialog({ sessionId, onClose }: Props) {
  const sessionState = useAppStore((s) => s.sessionState);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    getElements(sessionId, { sizes: true })
      .then((inv) => {
        if (!live) return;
        const next = buildRows(inv);
        setRows(next);
        setSelected(Object.fromEntries(next.map((r) => [rowKey(r), true])));
      })
      .catch((err) => { if (live) setError(formatError(err)); });
    return () => { live = false; };
  }, [sessionId]);

  // Elements a spatial display points at. Dropping one leaves the saved display with
  // no image / no boundaries — worth saying before the save, not after.
  const referenced = useMemo(() => {
    const refs = new Set<string>();
    for (const d of sessionState?.app_state.displays ?? []) {
      if (!isSpatialDisplay(d)) continue;
      if (d.encoding.image_layer) refs.add(`images/${d.encoding.image_layer}`);
      if (d.encoding.shapes_layer) refs.add(`shapes/${d.encoding.shapes_layer}`);
    }
    return refs;
  }, [sessionState]);

  const kept = rows?.filter((r) => selected[rowKey(r)]) ?? [];
  const total = kept.reduce((sum, r) => sum + (r.size ?? 0), 0);
  const droppedAny = !!rows && kept.length < rows.length;
  // An unsized element makes the total a floor rather than an estimate. "<0.1 MB"
  // already reads as approximate, so it takes no extra qualifier.
  const totalLabel = kept.some((r) => r.size === null)
    ? `at least ${formatSize(total)}`
    : total < 0.1 ? formatSize(total) : `~${formatSize(total)}`;

  function handleSave() {
    if (!rows) return;
    // Nothing deselected means the ordinary whole-object save: send no `include` at
    // all, so the backend keeps its incremental fast path and adopts the result as
    // this session's checkpoint.
    let include: Partial<Record<SdataFacet, string[]>> | undefined;
    if (droppedAny) {
      include = {};
      // Every facet that has elements must appear, even when it kept none: a facet
      // left out of `include` is kept whole, so an omitted empty facet would silently
      // save everything in it.
      for (const r of rows) include[r.facet] ??= [];
      for (const r of kept) include[r.facet]!.push(r.name);
    }
    setSaving(true);
    saveSession(sessionId, undefined, include)
      .then(({ job_id }) => {
        useAppStore.getState().setBlockingJob({ id: job_id, label: 'Saving session…' });
        onClose();
      })
      .catch((err) => { setSaving(false); reportError('Save failed', err); });
  }

  return (
    <ModalOverlay onClose={onClose} widthClassName="w-[32rem]">
      <ModalHeader
        title="Save session"
        subtitle="Choose what the checkpoint file contains. The session itself keeps everything."
        onClose={onClose}
      />

      <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
        {error && <p className="text-xs text-warn">Could not list elements: {error}</p>}
        {!rows && !error && <p className="text-xs text-muted">Measuring elements…</p>}
        {rows && rows.length === 0 && <p className="text-xs text-muted">This session has no elements to save.</p>}
        {rows && (['tables', 'images', 'labels', 'shapes', 'points'] as SdataFacet[]).map((facet) => {
          const group = rows.filter((r) => r.facet === facet);
          if (!group.length) return null;
          return (
            <div key={facet} className="mb-3 last:mb-0">
              <div className="text-[11px] text-muted font-mono uppercase tracking-wide mb-1">
                {FACET_LABELS[facet]}
              </div>
              {group.map((r) => {
                const key = rowKey(r);
                const locked = !!r.locked;
                const on = !!selected[key];
                return (
                  <label
                    key={key}
                    title={locked ? 'The active table is always saved.' : undefined}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded ${
                      locked ? 'opacity-70' : 'cursor-pointer hover:bg-accent-lo/20'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="accent-accent"
                      checked={on}
                      disabled={locked}
                      onChange={() => setSelected((s) => ({ ...s, [key]: !s[key] }))}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="text-xs text-text truncate">{r.name}</span>
                      {r.detail && <span className="text-[11px] text-muted ml-2">{r.detail}</span>}
                      {!on && referenced.has(key) && (
                        <span className="block text-[11px] text-warn">
                          Used by the Spatial view — that layer will be empty in the saved file.
                        </span>
                      )}
                    </span>
                    <span className="text-[11px] text-muted font-mono shrink-0">{formatSize(r.size)}</span>
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border shrink-0">
        <span className="text-[11px] text-muted">
          {rows ? `${kept.length} of ${rows.length} elements · ${totalLabel}` : ''}
        </span>
        <button
          type="button"
          onClick={handleSave}
          disabled={!rows || saving}
          className="px-3 py-1.5 text-xs rounded bg-accent text-bg font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : droppedAny ? 'Save selected' : 'Save'}
        </button>
      </div>
    </ModalOverlay>
  );
}
