import { useEffect, useMemo, useState } from 'react';
import {
  browsePath, getElements, saveSession, type ImageLevel, type SdataFacet, type SizedElements,
  type TableSlot,
} from '../api';
import {
  formatError, isEmbeddingDisplay, isSpatialDisplay, reportError,
} from '@cirrobio/spatial-viewer';
import { useAppStore } from '../store/sessionStore';
import { figureBytes, figureFormats } from '../lib/figures';
import type { SessionState } from '../types';
import { ModalHeader, ModalOverlay } from './DetailModal';
import FsPicker from './forms/FsPicker';

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
  // Tables only: the AnnData slots the table is made of, each separately droppable.
  slots?: TableSlot[];
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
// Slots live in the same `selected` map as the rows; `::` can't occur in a row key,
// whose parts are a facet and an element name.
const slotKey = (r: Row, path: string) => `${rowKey(r)}::${path}`;

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
      slots: t.slots,
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

// The extension every checkpoint carries, between the stem's content hash and the end
// of the name (backend: persistence/store.CHECKPOINT_EXT). Shown in the filename preview.
const CHECKPOINT_EXT = '.sdata.zarr.zip';

/** A session name turned into the filename stem it suggests. Only characters that make
 * a filename awkward to handle are folded away — the backend rejects a prefix with a
 * path separator or a leading dot outright, and everything else is the user's call. */
function suggestedPrefix(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
}

/** What a row contributes to the file: for an image, only the pyramid levels from
 * `finest` down to the coarsest; for a table, only the slots still ticked. Both are the
 * slice the save actually writes. */
function keptSize(r: Row, finest: number, slotOn: (path: string) => boolean): number | null {
  if (r.levels) return r.levels.slice(finest).reduce((sum, l) => sum + l.size_mb, 0);
  if (r.slots) return r.slots.filter((s) => slotOn(s.path)).reduce((sum, s) => sum + s.size_mb, 0);
  return r.size;
}

/** Why a slot can't be unticked, or null when it can. The required ones hold the
 * table's shape and its SpatialData linkage; an obsm key a display reads its
 * coordinates or embedding from can't be dropped either, because unlike a coloring
 * those references have no null form to fall back to — the backend rejects both. */
function slotLock(slot: TableSlot, usedObsm: Set<string>): string | null {
  if (slot.required) return 'The table\'s shape and linkage live here, so it is always saved.';
  if (usedObsm.has(slot.path)) return 'A display is drawn from here, so it is always saved.';
  return null;
}

/** Picks which parts of one table the file keeps. A table is an AnnData: an expression
 * matrix, the cell and gene frames, and named embeddings, layers and graphs — of which
 * only `X` is usually large enough to be worth the file it costs. Dropping it writes a
 * table with no matrix at all rather than a fabricated empty one, and the reader then
 * offers no gene coloring instead of showing zeros. */
function SlotList({ slots, usedObsm, on, onToggle }: {
  slots: TableSlot[];
  usedObsm: Set<string>;
  on: (path: string) => boolean;
  onToggle: (path: string) => void;
}) {
  return (
    <div className="pl-7 pr-2 pb-2">
      <div className="text-[10px] text-muted font-mono uppercase tracking-wide">Contents</div>
      {slots.map((slot) => {
        const lock = slotLock(slot, usedObsm);
        const kept = on(slot.path);
        return (
          <label
            key={slot.path}
            title={lock ?? undefined}
            className={`flex items-center gap-2 py-0.5 text-[11px] font-mono ${
              lock ? 'opacity-70' : 'cursor-pointer'
            }`}
          >
            <input
              type="checkbox"
              className="accent-accent"
              checked={kept}
              disabled={!!lock}
              onChange={() => onToggle(slot.path)}
            />
            <span className={`flex-1 min-w-0 truncate ${kept ? 'text-text' : 'text-muted'}`}>
              {slot.path}
            </span>
            <span className="text-muted shrink-0">{formatSize(slot.size_mb)}</span>
          </label>
        );
      })}
      {!on('X') && slots.some((s) => s.path === 'X') && (
        <p className="text-[11px] text-warn pt-1">
          Saved without X: the file keeps every annotation, but nothing in it can be
          colored by gene expression.
        </p>
      )}
    </div>
  );
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
  // Destination. `name` is what the file records as its own name; `folder` is relative
  // to the data directory (`''` for the directory itself); `prefix` is the filename
  // stem, left null while it should keep following the name.
  const [name, setName] = useState(sessionState?.summary.name ?? '');
  const [folder, setFolder] = useState('');
  const [prefix, setPrefix] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  // The data directory itself: the folder field stays relative to it (which is what the
  // save body wants), so its absolute path is needed only to root the browser and to
  // spell out the full destination. `browsePath()` with no path lists the roots, of
  // which there is exactly one.
  const [dataRoot, setDataRoot] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    browsePath()
      .then((listing) => { if (live) setDataRoot(listing.entries[0]?.path ?? null); })
      .catch(() => { /* the folder field falls back to relative-only display */ });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    getElements(sessionId, { sizes: true })
      .then((inv) => {
        if (!live) return;
        // Figure sizes are already in the session state; only the elements need measuring.
        const next = [...buildRows(inv), ...figureRows(useAppStore.getState().sessionState)];
        setRows(next);
        setSelected(Object.fromEntries([
          ...next.map((r) => [rowKey(r), true]),
          ...next.flatMap((r) => (r.slots ?? []).map((slot) => [slotKey(r, slot.path), true])),
        ]));
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

  // The obsm slots a display resolves against: a spatial canvas's `coords` (an
  // `obsm:<key>` path) and an embedding's `obsm_key`. `slotLock` keeps them ticked.
  const usedObsm = useMemo(() => {
    const keys = new Set<string>();
    for (const d of sessionState?.app_state.displays ?? []) {
      if (isSpatialDisplay(d)) {
        const [element, key] = d.encoding.coords.split(':');
        if (element === 'obsm' && key) keys.add(`obsm/${key}`);
      } else if (isEmbeddingDisplay(d)) {
        keys.add(`obsm/${d.encoding.obsm_key}`);
      }
    }
    return keys;
  }, [sessionState]);

  // The stem the file is written under: the name's suggestion until the user types their
  // own. Empty is not saveable — the backend rejects it, and there'd be no filename.
  const filePrefix = prefix ?? suggestedPrefix(name);
  const folderLabel = dataRoot ? [dataRoot, folder].filter(Boolean).join('/') : folder || '.';

  const finestOf = (r: Row) => (r.levels ? finestLevel[r.name] ?? 0 : 0);
  const slotOn = (r: Row) => (path: string) => !!selected[slotKey(r, path)];
  const kept = rows?.filter((r) => selected[rowKey(r)]) ?? [];
  const total = kept.reduce((sum, r) => sum + (keptSize(r, finestOf(r), slotOn(r)) ?? 0), 0);
  const droppedAny = !!rows
    && (kept.length < rows.length
      || kept.some((r) => (r.slots ?? []).some((slot) => !slotOn(r)(slot.path))));
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
    // Same rule one level down: only tables missing a slot are named, and a named table
    // lists every slot it keeps.
    const trimmed = kept.filter((r) => (r.slots ?? []).some((slot) => !slotOn(r)(slot.path)));
    const slots = Object.fromEntries(trimmed.map((r) => [
      r.name, r.slots!.filter((slot) => slotOn(r)(slot.path)).map((slot) => slot.path),
    ]));
    // Unlike `include`, an omitted `figures` keeps every drawn plot's figure, so the
    // list only has to be sent when one was deselected.
    const figureRowCount = rows.length - elements.length;
    const keptFigures = kept.filter((r) => r.facet === 'figures');
    const figures = keptFigures.length < figureRowCount
      ? keptFigures.map((r) => r.plotId!)
      : undefined;
    setSaving(true);
    saveSession(sessionId, {
      folder, prefix: filePrefix, name: name.trim(),
      include, levels: coarsenedAny ? levels : undefined,
      slots: trimmed.length ? slots : undefined, figures,
    })
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
        subtitle="Name the session, choose where the checkpoint file goes, and choose what it contains — which elements, which parts of a table, and at what resolution. The session itself keeps everything."
        onClose={onClose}
      />

      <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
        <div className="mb-4 flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted font-mono uppercase tracking-wide">
              Session name
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text placeholder-muted/50 focus:outline-none focus:border-accent"
            />
            <span className="text-[11px] text-muted">
              Stored in the file, so reopening it shows this name whatever the file is called.
            </span>
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted font-mono uppercase tracking-wide">Folder</span>
            <div className="flex items-center gap-2 min-w-0">
              <input
                type="text"
                value={folder}
                onChange={(e) => setFolder(e.target.value.replace(/^\/+/, ''))}
                placeholder="data directory"
                spellCheck={false}
                className="flex-1 min-w-0 bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text placeholder-muted/50 focus:outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => setBrowsing((b) => !b)}
                className="shrink-0 px-2 py-1 text-[11px] rounded border border-border text-muted hover:text-text hover:bg-bg transition-colors"
              >
                {browsing ? 'Done' : 'Browse…'}
              </button>
            </div>
            {browsing && dataRoot && (
              <FsPicker mode="folder" value={folder} onSelect={setFolder} rootDir={dataRoot} />
            )}
            <span className="text-[11px] text-muted">
              Under the data directory; created if it doesn't exist yet.
            </span>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted font-mono uppercase tracking-wide">
              File prefix
            </span>
            <input
              type="text"
              value={filePrefix}
              onChange={(e) => setPrefix(e.target.value)}
              spellCheck={false}
              className="w-full bg-bg border border-border rounded px-2 py-1 text-xs font-mono text-text placeholder-muted/50 focus:outline-none focus:border-accent"
            />
            <span className="text-[11px] text-muted font-mono break-all">
              {filePrefix
                ? `${folderLabel}/${filePrefix}-<content hash>${CHECKPOINT_EXT}`
                : 'A file prefix is required.'}
            </span>
          </label>
        </div>

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
                        {formatSize(keptSize(r, finest, slotOn(r)))}
                      </span>
                    </label>
                    {on && r.levels && r.levels.length > 1 && (
                      <LevelSlider
                        levels={r.levels}
                        finest={finest}
                        onChange={(level) => setFinestLevel((f) => ({ ...f, [r.name]: level }))}
                      />
                    )}
                    {on && r.slots && (
                      <SlotList
                        slots={r.slots}
                        usedObsm={usedObsm}
                        on={slotOn(r)}
                        onToggle={(path) => setSelected(
                          (sel) => ({ ...sel, [slotKey(r, path)]: !sel[slotKey(r, path)] }),
                        )}
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
          disabled={!rows || saving || !filePrefix || !name.trim()}
          className="px-3 py-1.5 text-xs rounded bg-accent text-bg font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : droppedAny || coarsenedAny ? 'Save selected' : 'Save'}
        </button>
      </div>
    </ModalOverlay>
  );
}
