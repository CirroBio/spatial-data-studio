// Every annotation the cells carry: color by one, or remove one from the next version.
// Removing writes a deletion into the draft; the versions below keep it, so it comes
// back by opening one of them.
import { useState } from 'react';
import { describeError } from '../cirro/session';
import { applyEdit } from '../workbench/workbench';
import { updateEncoding } from '../item/displayState';
import type { TaskProps } from './TaskPanel';

export default function AnnotationsTask({ wb }: TaskProps) {
  const handle = wb.handle!;
  const [confirm, setConfirm] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const table = handle.tableKey;
  const added = new Set(wb.changes.flatMap((c) => (c.op === 'set-obs' ? [c.column] : [])));
  const remove = async (name: string) => {
    setConfirm(null);
    setProblem(null);
    try {
      await applyEdit(wb.key, (e) => e.deleteObs(table, name));
    } catch (e) {
      setProblem(describeError(e));
    }
  };
  return (
    <div className="task-body">
      <p className="muted">{handle.fields.obs.length} annotations on {handle.fields.n_obs.toLocaleString()} cells{handle.fields.obsm.length ? `, and ${handle.fields.obsm.length} embeddings` : ''}.</p>
      {problem && <p className="notice notice-danger">{problem}</p>}
      <ul className="field-list">
        {handle.fields.obs.map((f) => (
          <li key={f.name} className="field-row">
            <span className="field-name">{f.name}{added.has(f.name) && <span className="pill pill-draft">unsaved</span>}</span>
            <span className="muted">{f.kind === 'categorical' ? 'groups' : 'values'}</span>
            <span className="field-actions">
              <button type="button" className="link-button" onClick={() => updateEncoding(wb.key, 'spatial', { color_by: `obs:${f.name}` })}>Color</button>
              {confirm === f.name ? (
                <>
                  <button type="button" className="link-button danger" onClick={() => void remove(f.name)}>Remove it</button>
                  <button type="button" className="link-button" onClick={() => setConfirm(null)}>Keep</button>
                </>
              ) : (
                <button type="button" className="link-button" onClick={() => setConfirm(f.name)}>Remove…</button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {handle.fields.obsm.length > 0 && (
        <>
          <p className="task-heading">Embeddings</p>
          <ul className="field-list">
            {handle.fields.obsm.map((f) => (
              <li key={f.name} className="field-row"><span className="field-name">{f.name}</span><span className="muted">{f.n_components} dimensions</span></li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
