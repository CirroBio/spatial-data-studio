// Label cells by drawing around them: each label lands in a group column of the draft
// (a new one, or one this dataset already has), so the next version carries it.
import { useState } from 'react';
import { SELECTION_SHAPE_KINDS, type SelectionTool } from '@cirrobio/spatial-viewer';
import { ObsFieldSelect } from '@cirrobio/studio-ui';
import { formatCount } from '../app/ui';
import { describeError } from '../cirro/session';
import { clearSelection, commitShape, setTool, useArmedSelection, useSelection } from '../item/selection';
import { freeName, readGroups } from './data';
import { writeObsColumn } from './parts';
import type { TaskProps } from './TaskPanel';

const TOOL_LABELS: Record<SelectionTool, string> = { lasso: 'Lasso', circle: 'Circle', ellipse: 'Ellipse', square: 'Square', rectangle: 'Rectangle' };

export default function LabelTask({ wb }: TaskProps) {
  const handle = wb.handle!;
  const selection = useSelection(wb.key);
  useArmedSelection(wb.key, true);
  const groupColumns = handle.fields.obs.filter((f) => f.kind === 'categorical');
  const taken = handle.fields.obs.map((f) => f.name);
  const [column, setColumn] = useState(() => freeName('regions', taken));
  const [label, setLabel] = useState('region 1');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cells = selection.cells ?? [];
  const target = column.trim();

  const apply = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const n = handle.fields.n_obs;
      let codes = new Int32Array(n).fill(-1);
      let categories: string[] = [];
      if (handle.fields.obs.some((f) => f.name === target)) {
        const current = await readGroups(handle, target);
        codes = Int32Array.from(current.codes);
        categories = [...current.categories];
      }
      let code = categories.indexOf(label.trim());
      if (code < 0) {
        categories.push(label.trim());
        code = categories.length - 1;
      }
      for (const c of cells) codes[c] = code;
      await writeObsColumn(wb.key, handle, target, { kind: 'categorical', categories, codes });
      clearSelection(wb.key);
      setColumn(target);
      const next = /^(.*?)(\d+)$/.exec(label.trim());
      setLabel(next ? `${next[1]}${Number(next[2]) + 1}` : `${label.trim()} 2`);
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="task-body">
      <p className="muted">Draw on the tissue: click around cells with the lasso, or drag a shape. Then name them.</p>
      <div className="seg seg-wrap" role="group" aria-label="Drawing tool">
        {(['lasso', ...SELECTION_SHAPE_KINDS] as SelectionTool[]).map((t) => (
          <button key={t} type="button" aria-pressed={selection.tool === t} onClick={() => setTool(wb.key, t)}>{TOOL_LABELS[t]}</button>
        ))}
      </div>
      <p className="answer-small" aria-live="polite">{cells.length ? `${formatCount(cells.length)} cells selected` : 'No cells selected yet'}</p>
      <div className="button-row">
        <button type="button" className="button button-small" onClick={() => commitShape(wb.key)} disabled={!selection.ring.length && !selection.shape}>Keep shape, draw another</button>
        <button type="button" className="button button-small" onClick={() => clearSelection(wb.key)}
          disabled={!cells.length && !selection.polygons.length && !selection.ring.length && !selection.shape}>Clear</button>
      </div>
      <label className="field studio-ui">
        <span>Into the column</span>
        <ObsFieldSelect fields={groupColumns} value={column} onChange={setColumn} creatable placeholder="Name a new column, or pick one" />
      </label>
      <label className="field">
        <span>Label</span>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      {problem && <p className="notice notice-danger">{problem}</p>}
      <button type="button" className="button button-primary" disabled={busy || !cells.length || !label.trim() || !target}
        onClick={() => void apply()}>
        {busy ? 'Labelling…' : `Label ${cells.length ? formatCount(cells.length) : ''} cells “${label.trim()}”`}
      </button>
      <p className="muted task-about">Cells that already had a label in this column take the new one. Unlabelled cells stay empty.</p>
    </div>
  );
}
