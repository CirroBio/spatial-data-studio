// The visitor's own settings, kept in this browser: which public projects the app lists.
import { useEffect, useState, type FormEvent } from 'react';
import {
  addPublicProject, removePublicProject, restoreDefaultPublicProject, usePublicProjects, type PublicProjectEntry,
} from '../data/publicProjects';
import { APP_NAME, DOCS_URL } from './appInfo';

// The guide's section on publishing a folder of one's own as a public project.
const OWN_DATA_URL = `${DOCS_URL}docs/guide/public-data#show-your-own-data`;

function ProjectRow({ entry, onRemove }: { entry: PublicProjectEntry; onRemove: () => void }) {
  return (
    <li className="settings-project">
      <div className="settings-project-text">
        <span className="settings-project-name">
          {entry.status === 'ready' ? entry.project.name : entry.status === 'loading' ? 'Checking…' : 'Not reachable'}
        </span>
        <span className="settings-project-origin muted">
          {entry.status === 'ready' && (entry.project.kind === 'index' ? 'Folder listed by index.json · ' : 'Cirro publication · ')}
          {entry.isDefault ? `${APP_NAME}'s own` : 'Added by you · not reviewed by this app'}
        </span>
        {entry.status === 'ready' && entry.project.description && <span className="muted">{entry.project.description}</span>}
        {entry.status === 'error' && <span className="settings-project-error">{entry.error}</span>}
        <code className="settings-project-url">{entry.url}</code>
      </div>
      <button type="button" className="button" onClick={onRemove}>Remove</button>
    </li>
  );
}

export function Settings({ onClose }: { onClose: () => void }) {
  const projects = usePublicProjects();
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setProblem(null);
    try {
      await addPublicProject(text);
      setText('');
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings">
        <h2>Settings</h2>
        <section className="settings-section">
          <h3>Public projects</h3>
          <p className="muted">
            Projects anyone can open without an account. They are read-only: what you save in one stays in this browser.
            {' '}<a href={OWN_DATA_URL} target="_blank" rel="noreferrer">Show your own data this way ↗</a>
          </p>
          {projects.length ? (
            <ul className="settings-projects">
              {projects.map((p) => <ProjectRow key={p.url} entry={p} onRemove={() => { setProblem(null); removePublicProject(p.url); }} />)}
            </ul>
          ) : <p className="muted">No public project is listed.</p>}
          {!projects.some((p) => p.isDefault) && (
            <button type="button" className="button" onClick={restoreDefaultPublicProject}>Bring back {APP_NAME}'s public project</button>
          )}
          <form className="settings-add" onSubmit={add}>
            <label className="field">
              <span>Add one by its address</span>
              <input className="input" type="url" required placeholder="https://…/published/<name> or https://…/<folder>" value={text}
                onChange={(e) => setText(e.target.value)} disabled={adding} />
            </label>
            <button type="submit" className="button button-primary" disabled={adding || !text.trim()}>{adding ? 'Checking…' : 'Add'}</button>
          </form>
          {problem && <p role="alert" className="notice notice-danger">{problem}</p>}
        </section>
        <div className="button-row">
          <button type="button" className="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
