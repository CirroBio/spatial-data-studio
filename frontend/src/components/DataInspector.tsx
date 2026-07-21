import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import {
  getElements,
  getTablePreview,
  getImageInfo,
  getImageThumbnailUrl,
  type ElementInventory,
  type TablePreview,
} from '../api';
import { formatError } from '../lib/format';
import type { ImageInfo } from '../types';

const PAGE_SIZE = 50;

// A selected element in the navigator. Tables get a sub-field (obs/var); shapes
// and points are previewed directly; images show metadata + a thumbnail.
type Selection =
  | { kind: 'table'; name: string; field: 'obs' | 'var' }
  | { kind: 'shapes'; name: string }
  | { kind: 'points'; name: string }
  | { kind: 'image'; name: string }
  | { kind: 'labels'; name: string };

function fieldPath(sel: Selection): string | null {
  if (sel.kind === 'table') return sel.field;
  if (sel.kind === 'shapes') return `shapes:${sel.name}`;
  if (sel.kind === 'points') return `points:${sel.name}`;
  return null;
}

function selectionPresent(sel: Selection, inv: ElementInventory): boolean {
  const group =
    sel.kind === 'table' ? inv.tables
      : sel.kind === 'shapes' ? inv.shapes
        : sel.kind === 'points' ? inv.points
          : sel.kind === 'image' ? inv.images
            : inv.labels;
  return group.some((g) => g.name === sel.name);
}

function isNumericDtype(dtype: string): boolean {
  return /int|float|uint/.test(dtype);
}

export default function DataInspector() {
  const { activeSessionId } = useAppStore();
  const dataVersions = useAppStore((s) => s.sessionState?.data_versions);
  const [inv, setInv] = useState<ElementInventory | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [invError, setInvError] = useState<string | null>(null);

  // Load the element inventory; default-select the active table's obs.
  useEffect(() => {
    if (!activeSessionId) return;
    setInv(null);
    setSel(null);
    setInvError(null);
    let cancelled = false;
    getElements(activeSessionId)
      .then((data) => {
        if (cancelled) return;
        setInv(data);
        const active = data.tables.find((t) => t.active) ?? data.tables[0];
        if (active) setSel({ kind: 'table', name: active.name, field: 'obs' });
      })
      .catch((err) => !cancelled && setInvError(formatError(err)));
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  // A compute can add/remove obs columns or whole elements. When data_versions bumps,
  // refresh the loaded inventory in place — keeping the current selection unless the
  // compute removed the element it points at — so the navigator doesn't go stale.
  useEffect(() => {
    if (!activeSessionId) return;
    let cancelled = false;
    getElements(activeSessionId)
      .then((data) => {
        if (cancelled) return;
        setInv(data);
        setSel((cur) => (cur && !selectionPresent(cur, data) ? null : cur));
      })
      .catch(() => { /* keep the current view if the refresh fails */ });
    return () => {
      cancelled = true;
    };
    // Session changes are handled by the effect above; only re-run on a data change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersions]);

  if (!activeSessionId) return null;

  return (
    <div className="flex h-full overflow-hidden">
      <ElementNavigator inv={inv} error={invError} sel={sel} onSelect={setSel} />
      <div className="flex-1 min-w-0 overflow-hidden">
        {sel?.kind === 'image' ? (
          <ImagePanel sessionId={activeSessionId} element={sel.name} />
        ) : sel?.kind === 'labels' ? (
          <div className="flex items-center justify-center h-full text-muted text-sm">
            Labels element "{sel.name}" — no tabular preview.
          </div>
        ) : sel ? (
          <TableView
            sessionId={activeSessionId}
            sel={sel}
            onField={(field) => sel.kind === 'table' && setSel({ ...sel, field })}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-muted text-sm">
            {invError ? `Failed to load elements: ${invError}` : 'Select an element to inspect.'}
          </div>
        )}
      </div>
    </div>
  );
}

function NavGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="px-3 py-1 text-[10px] font-mono text-muted uppercase tracking-wide">{title}</div>
      {children}
    </div>
  );
}

function NavItem({
  label,
  detail,
  selected,
  onClick,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 transition-colors ${
        selected ? 'bg-accent-lo text-text' : 'text-text/80 hover:bg-accent-lo/30'
      }`}
    >
      <div className="text-xs font-mono truncate">{label}</div>
      {detail && <div className="text-[10px] text-muted/70 truncate">{detail}</div>}
    </button>
  );
}

function ElementNavigator({
  inv,
  error,
  sel,
  onSelect,
}: {
  inv: ElementInventory | null;
  error: string | null;
  sel: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  return (
    // pt-12 clears the Spatial/Tables switcher floating at the viewer's top-left
    <aside className="w-56 shrink-0 bg-surface border-r border-border overflow-y-auto pt-12 pb-2">
      {!inv && !error && <div className="px-3 py-2 text-xs text-muted">Loading elements…</div>}
      {error && <div className="px-3 py-2 text-xs text-danger">{error}</div>}
      {inv && (
        <>
          <NavGroup title="Tables">
            {inv.tables.map((t) => (
              <NavItem
                key={t.name}
                label={t.name}
                detail={`${t.n_obs.toLocaleString()} obs × ${t.n_vars.toLocaleString()} vars`}
                selected={sel?.kind === 'table' && sel.name === t.name}
                onClick={() => onSelect({ kind: 'table', name: t.name, field: 'obs' })}
              />
            ))}
          </NavGroup>
          {inv.shapes.length > 0 && (
            <NavGroup title="Shapes">
              {inv.shapes.map((s) => (
                <NavItem
                  key={s.name}
                  label={s.name}
                  detail={`${s.count.toLocaleString()} ${s.geometry.join('/') || 'rows'}`}
                  selected={sel?.kind === 'shapes' && sel.name === s.name}
                  onClick={() => onSelect({ kind: 'shapes', name: s.name })}
                />
              ))}
            </NavGroup>
          )}
          {inv.points.length > 0 && (
            <NavGroup title="Points">
              {inv.points.map((p) => (
                <NavItem
                  key={p.name}
                  label={p.name}
                  detail={`${p.columns.length} cols`}
                  selected={sel?.kind === 'points' && sel.name === p.name}
                  onClick={() => onSelect({ kind: 'points', name: p.name })}
                />
              ))}
            </NavGroup>
          )}
          {inv.images.length > 0 && (
            <NavGroup title="Images">
              {inv.images.map((im) => (
                <NavItem
                  key={im.name}
                  label={im.name}
                  selected={sel?.kind === 'image' && sel.name === im.name}
                  onClick={() => onSelect({ kind: 'image', name: im.name })}
                />
              ))}
            </NavGroup>
          )}
          {inv.labels.length > 0 && (
            <NavGroup title="Labels">
              {inv.labels.map((l) => (
                <NavItem
                  key={l.name}
                  label={l.name}
                  selected={sel?.kind === 'labels' && sel.name === l.name}
                  onClick={() => onSelect({ kind: 'labels', name: l.name })}
                />
              ))}
            </NavGroup>
          )}
        </>
      )}
    </aside>
  );
}

function TableView({
  sessionId,
  sel,
  onField,
}: {
  sessionId: string;
  sel: Selection;
  onField: (field: 'obs' | 'var') => void;
}) {
  const [offset, setOffset] = useState(0);
  const [preview, setPreview] = useState<TablePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dataVersions = useAppStore((s) => s.sessionState?.data_versions);

  const path = fieldPath(sel);

  // Reset paging when the selected element/field changes.
  useEffect(() => {
    setOffset(0);
  }, [path]);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getTablePreview(sessionId, path, offset, PAGE_SIZE)
      .then((p) => !cancelled && setPreview(p))
      .catch((err) => !cancelled && setError(formatError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // dataVersions bump re-reads the preview so new obs columns from a compute appear.
  }, [sessionId, path, offset, dataVersions]);

  const total = preview?.total_rows ?? 0;
  const shown = preview?.rows.length ?? 0;
  const atEnd = offset + shown >= total;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-mono text-text truncate">{sel.name}</span>
          {sel.kind === 'table' && (
            <div className="flex rounded border border-border overflow-hidden text-xs">
              {(['obs', 'var'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => onField(f)}
                  className={`px-2.5 py-0.5 font-mono transition-colors ${
                    sel.field === f ? 'bg-accent text-white' : 'bg-bg text-muted hover:text-text'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-muted font-mono">
            {total > 0 ? `${(offset + 1).toLocaleString()}–${(offset + shown).toLocaleString()} of ${total.toLocaleString()}` : '0 rows'}
            {preview ? ` · ${preview.columns.length} cols` : ''}
          </span>
          <button
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0 || loading}
            className="px-2 py-0.5 text-xs rounded border border-border bg-bg text-text hover:border-accent disabled:opacity-40 transition-colors"
          >
            Prev
          </button>
          <button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={atEnd || loading}
            className="px-2 py-0.5 text-xs rounded border border-border bg-bg text-text hover:border-accent disabled:opacity-40 transition-colors"
          >
            Next
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto relative">
        {error ? (
          <div className="p-4 text-xs text-danger">{error}</div>
        ) : !preview ? (
          <div className="p-4 text-xs text-muted">Loading…</div>
        ) : (
          <DataGrid preview={preview} />
        )}
        {loading && preview && (
          <div className="absolute inset-0 bg-bg/40 flex items-start justify-center pt-10 text-xs text-accent">
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}

function DataGrid({ preview }: { preview: TablePreview }) {
  return (
    <table className="border-collapse text-xs font-mono">
      <thead className="sticky top-0 z-10">
        <tr>
          <th className="sticky left-0 z-20 bg-surface border-b border-r border-border px-2 py-1.5 text-left text-muted font-medium">
            {preview.index_name}
          </th>
          {preview.columns.map((col) => (
            <th
              key={col.name}
              className={`bg-surface border-b border-border px-3 py-1.5 whitespace-nowrap ${
                isNumericDtype(col.dtype) ? 'text-right' : 'text-left'
              }`}
            >
              <div className="text-text font-medium">{col.name}</div>
              <div className="text-[10px] text-muted/70 font-normal">{col.dtype}</div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {preview.rows.map((row, r) => (
          <tr key={r} className={`${r % 2 ? '' : 'bg-surface/40'} hover:bg-accent-lo/20`}>
            <td className="sticky left-0 z-10 bg-bg border-b border-r border-border px-2 py-1 text-muted whitespace-nowrap">
              {preview.index[r]}
            </td>
            {row.map((cell, c) => {
              const numeric = isNumericDtype(preview.columns[c].dtype);
              return (
                <td
                  key={c}
                  className={`border-b border-border/60 px-3 py-1 whitespace-nowrap ${
                    numeric ? 'text-right tabular-nums text-text/90' : 'text-text/80'
                  } ${cell === null ? 'text-muted/40 italic' : ''}`}
                >
                  {cell === null
                    ? 'NA'
                    : typeof cell === 'number'
                    ? formatNumber(cell)
                    : String(cell)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) return n.toExponential(3);
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function ImagePanel({ sessionId, element }: { sessionId: string; element: string }) {
  const [info, setInfo] = useState<ImageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setError(null);
    getImageInfo(sessionId, element)
      .then((i) => !cancelled && setInfo(i))
      .catch((err) => !cancelled && setError(formatError(err)));
    return () => {
      cancelled = true;
    };
  }, [sessionId, element]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 py-2 border-b border-border shrink-0">
        <span className="text-sm font-mono text-text">{element}</span>
      </div>
      <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
        {error && <div className="text-xs text-danger">{error}</div>}
        {info && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs font-mono w-fit">
            <dt className="text-muted">dimensions</dt>
            <dd className="text-text">{info.width} × {info.height}</dd>
            <dt className="text-muted">channels</dt>
            <dd className="text-text">{info.channels} ({info.channel_names.join(', ')})</dd>
            <dt className="text-muted">bounds</dt>
            <dd className="text-text">[{info.bounds.map((b) => Math.round(b)).join(', ')}]</dd>
          </dl>
        )}
        <div className="border border-border rounded overflow-hidden bg-surface w-fit max-w-full">
          <img
            src={getImageThumbnailUrl(sessionId, element)}
            alt={element}
            className="max-w-full max-h-[60vh] object-contain"
          />
        </div>
      </div>
    </div>
  );
}
