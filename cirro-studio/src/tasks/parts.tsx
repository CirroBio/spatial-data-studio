// Pieces the task panels share: a job's progress, choosing a column or a group of cells,
// writing a column into the draft, and a sortable result table.
import { useMemo, useState } from 'react';
import type { CheckpointHandle } from '@cirrobio/spatial-viewer';
import { ObsFieldSelect } from '@cirrobio/studio-ui';
import { formatCount } from '../app/ui';
import { describeError } from '../cirro/session';
import { updateEncoding } from '../item/displayState';
import { useSelection } from '../item/selection';
import type { ObsColumn } from '../stack/editor';
import { applyEdit } from '../workbench/workbench';
import { readGroups } from './data';
import type { Job } from './useJob';

export function JobStatus({ job, label }: { job: Job; label: string }) {
  if (job.error) return <p className="notice notice-danger">{job.error}</p>;
  if (!job.running) return null;
  return (
    <div className="job-status" role="status">
      <span>{job.message || label}…</span>
      <progress max={1} value={job.progress} aria-label={label} />
      <button type="button" className="link-button" onClick={job.cancel}>Cancel</button>
    </div>
  );
}

export function ColumnSelect({ handle, value, onChange, label }: {
  handle: CheckpointHandle; value: string; onChange: (v: string) => void; label: string;
}) {
  return (
    <label className="field studio-ui">
      <span>{label}</span>
      <ObsFieldSelect fields={handle.fields.obs.filter((f) => f.kind === 'categorical')} value={value} onChange={onChange} placeholder="Choose…" />
    </label>
  );
}

/** Write a column into the draft and color the tissue by it. */
export async function writeObsColumn(wbKey: string, handle: CheckpointHandle, name: string, column: ObsColumn, note?: string): Promise<void> {
  await applyEdit(wbKey, async (e) => ({ ...(await e.setObs(handle.tableKey, name, column)), note }));
  updateEncoding(wbKey, 'spatial', { color_by: `obs:${name}` });
}

/** A group of cells: one category of a column, every cell not in the other group, or the
 * cells selected on the tissue. */
export type GroupSpec =
  | { kind: 'category'; column: string; category: string }
  | { kind: 'rest' }
  | { kind: 'selection' };

export const groupLabel = (g: GroupSpec) => (g.kind === 'category' ? g.category : g.kind === 'rest' ? 'the rest' : 'the selected cells');

/** Membership for compareGroups: 1 for group A, 2 for group B, 0 for neither. */
export async function membership(handle: CheckpointHandle, a: GroupSpec, b: GroupSpec, selected: number[] | null): Promise<Uint8Array> {
  const n = handle.fields.n_obs;
  const inGroup = async (g: GroupSpec): Promise<Uint8Array | null> => {
    if (g.kind === 'rest') return null;
    const mask = new Uint8Array(n);
    if (g.kind === 'selection') {
      for (const c of selected ?? []) mask[c] = 1;
      return mask;
    }
    const obs = await readGroups(handle, g.column);
    const code = obs.categories.indexOf(g.category);
    for (let i = 0; i < n; i++) if (obs.codes[i] === code) mask[i] = 1;
    return mask;
  };
  const [aMask, bMask] = await Promise.all([inGroup(a), inGroup(b)]);
  // B as "the rest" is every cell outside A; it needs A to be a mask to be outside of.
  const bIsRest = !bMask && aMask !== null;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (aMask?.[i]) out[i] = 1;
    else if (bIsRest || bMask?.[i]) out[i] = 2;
  }
  return out;
}

export function GroupPicker({ handle, wbKey, value, onChange, label, allowRest }: {
  handle: CheckpointHandle; wbKey: string; value: GroupSpec | null; onChange: (g: GroupSpec | null) => void; label: string; allowRest: boolean;
}) {
  const selection = useSelection(wbKey);
  const [column, setColumn] = useState(value?.kind === 'category' ? value.column : '');
  const [categories, setCategories] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const columns = handle.fields.obs.filter((f) => f.kind === 'categorical');
  const chooseColumn = async (c: string) => {
    setColumn(c);
    setCategories([]);
    setProblem(null);
    // A group of the old column is not one of the new column's.
    if (value?.kind === 'category') onChange(null);
    if (!c) return;
    try {
      setCategories((await readGroups(handle, c)).categories);
    } catch (e) {
      setProblem(describeError(e));
    }
  };
  const current = value?.kind === 'category' ? `c:${value.category}` : value?.kind ?? '';
  return (
    <fieldset className="group-picker">
      <legend>{label}</legend>
      <div className="group-picker-row">
        <label className="studio-ui">
          <span className="visually-hidden">{label}: column</span>
          <ObsFieldSelect fields={columns} value={column} onChange={(c) => void chooseColumn(c)}
            placeholder={`Cells selected on the tissue${allowRest ? ', or the rest' : ''}`} />
        </label>
        <select className="select" value={current} aria-label={`${label}: group`}
          onChange={(e) => {
            const v = e.target.value;
            // The column picker has no empty choice: picking the selected cells is what
            // clears it.
            if (v === 'selection') void chooseColumn('');
            if (v === 'selection' || v === 'rest') onChange({ kind: v });
            else if (v.startsWith('c:')) onChange({ kind: 'category', column, category: v.slice(2) });
          }}>
          <option value="" disabled>Choose…</option>
          <option value="selection">Selected cells ({formatCount(selection.cells?.length ?? 0)})</option>
          {allowRest && <option value="rest">All other cells</option>}
          {categories.map((c) => <option key={c} value={`c:${c}`}>{c}</option>)}
        </select>
      </div>
      {problem && <p className="notice notice-danger">{problem}</p>}
    </fieldset>
  );
}

export interface Column<R> {
  key: keyof R & string;
  label: string;
  format?: (v: number) => string;
}

// A p-value below what a double holds underflows to 0; it is that small, not certain.
const formatP = (v: number) => (v === 0 ? '< 1e-300' : v < 1e-3 ? v.toExponential(1) : v.toPrecision(2));
export const FORMATS = {
  p: formatP,
  num: (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(3)),
  pct: (v: number) => `${(100 * v).toFixed(0)}%`,
};

/** The rows as a sortable table; clicking a row picks it (to color by that gene). */
export function ResultTable<R extends object>({ rows, columns, rowKey, onPick, picked, limit = 200 }: {
  rows: R[]; columns: Column<R>[]; rowKey: (r: R) => string; onPick?: (r: R) => void; picked?: string | null; limit?: number;
}) {
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const dir = sort.desc ? -1 : 1;
    return [...rows].sort((a, b) => {
      const x = (a as Record<string, unknown>)[sort.key];
      const y = (b as Record<string, unknown>)[sort.key];
      // Numeric-aware, so group labels 0, 1, 2… sort before 10.
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir;
    });
  }, [rows, sort]);
  return (
    <div className="result-scroll">
      <table className="result-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} aria-sort={sort?.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                <button type="button" className="link-button" onClick={() => setSort((s) => ({ key: c.key, desc: s?.key === c.key ? !s.desc : true }))}>{c.label}</button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, limit).map((r) => (
            <tr key={rowKey(r)} aria-selected={picked === rowKey(r)} onClick={() => onPick?.(r)}>
              {columns.map((c) => {
                const v = (r as Record<string, unknown>)[c.key];
                return <td key={c.key}>{typeof v === 'number' && c.format ? c.format(v) : String(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && <p className="muted result-more">Showing {limit} of {formatCount(rows.length)}; sort to see others.</p>}
    </div>
  );
}
