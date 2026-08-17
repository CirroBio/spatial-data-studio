import { useEffect, useMemo, useState } from 'react';
import {
  getElements, saveSession, type ImageLevel, type SdataFacet, type SizedElements,
} from '../api';
import { formatError, isSpatialDisplay, reportError } from '@cirrobio/spatial-viewer';
import { useAppStore } from '../store/sessionStore';
import { figureBytes, figureFormats } from '../lib/figures';
import type { SessionState } from '../types';
import { ModalHeader, ModalOverlay } from './DetailModal';

interface Props {
  sessionId: string;
  onClose: () => void;
}

// A checkpoint's contents are elements plus the rendered figures of its drawn plots;
// `figures` is not a SpatialData facet, so it rides alongside them here and leaves as
// its own field of the save body.
type RowGroup = SdataFacet | 'figures';

interface Row {
  facet: RowGroup;
  name: string;
  detail: string;
  size: number | null;
  // Images only: their pyramid levels, finest first. What the resolution slider trims.
  levels?: ImageLevel[];
  // The active table anchors every field path and display in the checkpoint, so it
  // can't be dropped — the backend rejects that too.
  locked?: boolean;
  // Set on figure rows: the plot id the save body names.
  plotId?: string;
}

const GROUP_LABELS: Record<RowGroup, string> = {
  tables: 'Tables', images: 'Images', labels: 'Labels', shapes: 'Shapes', points: 'Points',
  figures: 'Plot figures',
};
const GROUP_ORDER: RowGroup[] = ['tables', 'images', 'labels', 'shapes', 'points', 'figures'];

// Two plots of the same function share a label, so figure rows key on the plot id.
const rowKey = (r: Row) => `${r.facet}/${r.plotId ?? r.name}`;

// One row per drawn plot whose figure the file can carry, sized from the bytes the
// session holds (`SessionState.figures`) so the totals below stay honest.
function figureRows(state: SessionState | null): Row[] {
  if (!state) return [];
  return state.app_state.plots
    .filter((p) => p.status === 'drawn' && figureFormats(state.figures, p.id).length)
    .map((p) => ({
      facet: 'figures' as const, name: `${p.namespace}.${p.function}`, plotId: p.id,
      size: figureBytes(state.figures, p.id) / 1e6,
      detail: figureFormats(state.figures, p.id).join('/'),
    }));
}

// Tables first — everything else annotates them. Element details mirror what the data
// inspector shows for the same facet (DataInspector.tsx).
function buildRows(inv: SizedElements): Row[] {
  return [
    ...inv.tables.map((t) => ({
      facet: 'tables' as const, name: t.name, size: t.size_mb, locked: t.active,
      detail: `${t.n_obs.toLocaleString()} obs × ${t.n_vars.toLocaleString()} vars`,
    })),
    // An image's detail line is the finest level it will be saved at, so it follows the
    // resolution slider rather than being fixed here.
    ...inv.images.map((i) => ({
      facet: 'images' as const, name: i.name, size: i.size_mb, levels: i.levels, detail: '',
    })),
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

const formatDims = (l: ImageLevel) => `${l.width.toLocaleString()} × ${l.height.toLocaleString()} px`;

/** What a row contributes to the file: for an image, only the pyramid levels from
 * `finest` down to the coarsest, which is the slice the save actually writes. */
function keptSize(r: Row, finest: number): number | null {
  if (!r.levels) return r.size;
  return r.levels.slice(finest).reduce((sum, l) => sum + l.size_mb, 0);
}

/** Picks how much of one image's pyramid the file keeps, and shows what each level
 * costs. The slider runs coarsest-only (left) to full detail (right), so it reads as a
 * detail control rather than a drop count; the coarsest level is never droppable, since
 * the point is to shrink the file, not to empty it. */
function LevelSlider({ levels, finest, onChange }: {
  levels: ImageLevel[];
  finest: number;
  onChange: (finest: number) => void;
}) {
  const coarsest = levels.length - 1;
  return (
    <div className="pl-7 pr-2 pb-2">
      <div className="flex items-center justify-between text-[10px] text-muted font-mono uppercase tracking-wide">
        <span>Resolution</span>
        <span>{levels.length - finest} of {levels.length} levels</span>
      </div>
      <input
        type="range"
        min={0}
        max={coarsest}
        step={1}
        value={coarsest - finest}
        onChange={(e) => onChange(coarsest - Number(e.target.value))}
        className="w-full accent-accent"
        aria-label="Finest resolution level to save"
      />
      {levels.map((l) => (
        <div
          key={l.level}
          className={`flex items-baseline gap-2 text-[11px] font-mono ${
            l.level < finest ? 'text-muted/50 line-through' : 'text-muted'
          }`}
        >
          <span className="flex-1 truncate">{formatDims(l)}</span>
          <span>{formatSize(l.size_mb)}</span>
        </div>
      ))}
    </div>
  );
}

export default function SaveCheckpointDialog({ sessionId, onClose }: Props) {
  const sessionState = useAppStore((s) => s.sessionState);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  // Image name -> index of the finest pyramid level to save; absent means the whole
  // pyramid. Keyed by name because that is what the save body wants back.
  const [finestLevel, setFinestLevel] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    getElements(sessionId, { sizes: true })
      .then((inv) => {
        if (!live) return;
        // Figure sizes are already in the session state; only the elements need measuring.
        const next = [...buildRows(inv), ...figureRows(useAppStore.getState().sessionState)];
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

  const finestOf = (r: Row) => (r.levels ? finestLevel[r.name] ?? 0 : 0);
  const kept = rows?.filter((r) => selected[rowKey(r)]) ?? [];
  const total = kept.reduce((sum, r) => sum + (keptSize(r, finestOf(r)) ?? 0), 0);
  const droppedAny = !!rows && kept.length < rows.length;
  const coarsenedAny = kept.some((r) => finestOf(r) > 0);
  // An unsized element makes the total a floor rather than an estimate. "<0.1 MB"
  // already reads as approximate, so it takes no extra qualifier.
  const totalLabel = kept.some((r) => r.size === null)
    ? `at least ${formatSize(total)}`
    : total < 0.1 ? formatSize(total) : `~${formatSize(total)}`;

  function handleSave() {
    if (!rows) return;
    const elements = rows.filter((r) => r.facet !== 'figures');
    const keptElements = kept.filter((r) => r.facet !== 'figures');
    // No element deselected means the ordinary whole-object save: send no `include` at
    // all, so the backend keeps its incremental fast path and adopts the result as
    // this session's checkpoint.
    let include: Partial<Record<SdataFacet, string[]>> | undefined;
    if (keptElements.length < elements.length) {
      include = {};
      // Every facet that has elements must appear, even when it kept none: a facet
      // left out of `include` is kept whole, so an omitted empty facet would silently
      // save everything in it.
      for (const r of elements) include[r.facet as SdataFacet] ??= [];
      for (const r of keptElements) include[r.facet as SdataFacet]!.push(r.name);
    }
    // Only images being saved at less than full resolution; an image left at level 0
    // is the same request as not naming it at all.
    const levels = Object.fromEntries(
      kept.filter((r) => finestOf(r) > 0).map((r) => [r.name, finestOf(r)]),
    );
    // Unlike `include`, an omitted `figures` keeps every drawn plot's figure, so the
    // list only has to be sent when one was deselected.
    const figureRowCount = rows.length - elements.length;
    const keptFigures = kept.filter((r) => r.facet === 'figures');
    const figures = keptFigures.length < figureRowCount
      ? keptFigures.map((r) => r.plotId!)
      : undefined;
    setSaving(true);
    saveSession(sessionId, undefined, include, coarsenedAny ? levels : undefined, figures)
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
        subtitle="Choose what the checkpoint file contains, and at what resolution. The session itself keeps everything."
        onClose={onClose}
      />

      <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
        {error && <p className="text-xs text-warn">Could not list elements: {error}</p>}
        {!rows && !error && <p className="text-xs text-muted">Measuring elements…</p>}
        {rows && rows.length === 0 && <p className="text-xs text-muted">This session has no elements to save.</p>}
        {rows && GROUP_ORDER.map((facet) => {
          const group = rows.filter((r) => r.facet === facet);
          if (!group.length) return null;
          return (
            <div key={facet} className="mb-3 last:mb-0">
              <div className="text-[11px] text-muted font-mono uppercase tracking-wide mb-1">
                {GROUP_LABELS[facet]}
              </div>
              {group.map((r) => {
                const key = rowKey(r);
                const locked = !!r.locked;
                const on = !!selected[key];
                const finest = finestOf(r);
                const detail = r.levels ? formatDims(r.levels[finest]) : r.detail;
                return (
                  <div key={key}>
                    <label
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
                        {detail && <span className="text-[11px] text-muted ml-2">{detail}</span>}
                        {!on && referenced.has(key) && (
                          <span className="block text-[11px] text-warn">
                            Used by the Spatial view — that layer will be empty in the saved file.
                          </span>
                        )}
                      </span>
                      <span className="text-[11px] text-muted font-mono shrink-0">
                        {formatSize(keptSize(r, finest))}
                      </span>
                    </label>
                    {on && r.levels && r.levels.length > 1 && (
                      <LevelSlider
                        levels={r.levels}
                        finest={finest}
                        onChange={(level) => setFinestLevel((f) => ({ ...f, [r.name]: level }))}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border shrink-0">
        <span className="text-[11px] text-muted">
          {rows ? `${kept.length} of ${rows.length} items · ${totalLabel}` : ''}
        </span>
        <button
          type="button"
          onClick={handleSave}
          disabled={!rows || saving}
          className="px-3 py-1.5 text-xs rounded bg-accent text-bg font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : droppedAny || coarsenedAny ? 'Save selected' : 'Save'}
        </button>
      </div>
    </ModalOverlay>
  );
}
