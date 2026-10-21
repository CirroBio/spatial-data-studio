// Unsaved changes, and saving them as a version: what will be written, how small it is
// next to the data it sits on, and where it goes.
import { useState } from 'react';
import { reloadCatalog } from '../app/catalog';
import { openItem } from '../app/route';
import { useStudio } from '../app/studio';
import { formatBytes } from '../app/ui';
import { describeError } from '../cirro/session';
import { LAYER_MANIFEST } from '../stack/manifest';
import { discardDraft, saveDraft, type Workbench } from '../workbench/workbench';
import { describeChange, isRemoval, suggestTitle } from './changes';
import { carryDisplays } from './displayState';

export function DraftBar({ wb, baseSize, datasetName }: { wb: Workbench; baseSize: number; datasetName: string }) {
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Saving empties the draft, which takes the bar away; the dialog keeps its place beside
  // it, so it stays open to report how the save went.
  return (
    <>
      {wb.changes.length > 0 && (
        <div className="draft-bar" role="region" aria-label="Unsaved changes">
          <span className="draft-dot" aria-hidden="true" />
          <span className="draft-summary">
            <strong>{wb.changes.length} unsaved change{wb.changes.length === 1 ? '' : 's'}</strong>
            <span className="muted"> · {formatBytes(wb.draftBytes)} to save</span>
          </span>
          <span className="draft-list">
            {wb.changes.slice(-3).map((c, i) => {
              const text = describeChange(c);
              return <span key={i} className={`chip chip-static ${isRemoval(c) ? 'chip-removed' : ''}`} title={text}>{text}</span>;
            })}
          </span>
          {confirmDiscard ? (
            <span className="button-row">
              <span>Discard {wb.changes.length === 1 ? 'it' : 'them'}?</span>
              <button type="button" className="button" onClick={() => setConfirmDiscard(false)}>Keep</button>
              <button type="button" className="button button-danger" onClick={() => { setConfirmDiscard(false); void discardDraft(wb.key); }}>Discard</button>
            </span>
          ) : (
            <span className="button-row">
              <button type="button" className="button" onClick={() => setConfirmDiscard(true)}>Discard</button>
              <button type="button" className="button button-primary" onClick={() => setSaving(true)}>Save as a version…</button>
            </span>
          )}
        </div>
      )}
      {saving && <SaveDialog wb={wb} baseSize={baseSize} datasetName={datasetName} onClose={() => setSaving(false)} />}
    </>
  );
}

function SaveDialog({ wb, baseSize, datasetName, onClose }: { wb: Workbench; baseSize: number; datasetName: string; onClose: () => void }) {
  const { collection, session } = useStudio();
  const [title, setTitle] = useState(() => suggestTitle(wb.changes));
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ datasetId: string; note: string } | null>(null);
  const depth = wb.levels.length;

  const save = async () => {
    setProblem(null);
    setProgress(0);
    try {
      const { datasetId, key, noteProblem } = await saveDraft(wb.key, {
        title: title.trim() || suggestTitle(wb.changes),
        message: message.trim(),
        createdBy: session?.displayName ?? '',
        name: `${datasetName} · ${title.trim() || suggestTitle(wb.changes)}`,
      }, setProgress);
      carryDisplays(wb.key, key);
      reloadCatalog(collection);
      if (noteProblem) setNotice({ datasetId, note: noteProblem });
      else openItem(datasetId, LAYER_MANIFEST);
    } catch (e) {
      setProgress(null);
      setProblem(describeError(e, 'create datasets'));
    }
  };

  if (notice) {
    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Version saved">
        <div className="modal">
          <h2>Version saved</h2>
          <p>{notice.note}</p>
          <button type="button" className="button button-primary" onClick={() => openItem(notice.datasetId, LAYER_MANIFEST)}>Open it</button>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Save as a version">
      <form className="modal" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h2>Save as a version</h2>
        <label className="field">
          <span>Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} autoFocus />
        </label>
        <label className="field">
          <span>What and why <span className="muted">(optional)</span></span>
          <textarea className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <ul className="save-changes">
          {wb.changes.map((c, i) => <li key={i} className={isRemoval(c) ? 'removed' : ''}>{describeChange(c)}</li>)}
        </ul>
        <p className="save-explain">
          Writes <strong>{formatBytes(wb.draftBytes)}</strong>, only what changed, to {collection.saveTarget}, as version {depth} on top
          of {depth > 1 ? 'the version open now' : 'the original store'}
          {baseSize > 0 && <> ({formatBytes(baseSize)}, which is not copied)</>}. Anyone who can open both sees the full dataset.
        </p>
        {problem && <p className="notice notice-danger">{problem}</p>}
        {progress !== null && <progress max={1} value={progress} aria-label="Saving" />}
        <div className="button-row">
          <button type="button" className="button" onClick={onClose} disabled={progress !== null}>Cancel</button>
          <button type="submit" className="button button-primary" disabled={progress !== null}>Save version</button>
        </div>
      </form>
    </div>
  );
}
