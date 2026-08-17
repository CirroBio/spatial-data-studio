import { useEffect, useId, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import {
  getCirroFolders, getCirroProjects, getDatasets, uploadToCirro,
  type CirroProject, type DatasetEntry,
} from '../api';
import { formatError, reportError } from '@cirrobio/spatial-viewer';
import { ModalOverlay, ModalHeader } from './DetailModal';

interface Props {
  onClose: () => void;
}

function toggle(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  next.has(key) ? next.delete(key) : next.add(key);
  return next;
}

function savedAt(mtime: number): string {
  return mtime ? new Date(mtime * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

export default function CirroUploadDialog({ onClose }: Props) {
  const { pushNotification, cirroAuth } = useAppStore();
  const folderListId = useId();

  const [projects, setProjects] = useState<CirroProject[] | null>(null);
  const [sessions, setSessions] = useState<DatasetEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [projectId, setProjectId] = useState('');
  const [datasetName, setDatasetName] = useState('');
  const [description, setDescription] = useState('');
  const [folder, setFolder] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([getCirroProjects(), getDatasets()])
      .then(([p, d]) => {
        setProjects(p.projects);
        setSessions(d.datasets);
      })
      .catch((err) => setError(formatError(err)));
  }, []);

  useEffect(() => {
    if (!projectId) { setFolders([]); return; }
    getCirroFolders(projectId).then((f) => setFolders(f.folders)).catch((err) => setError(formatError(err)));
  }, [projectId]);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      await uploadToCirro({
        project_id: projectId, dataset_name: datasetName.trim(),
        description: description.trim(), session_paths: [...selectedSessions],
        folder: folder.trim() || undefined,
      });
      pushNotification({ kind: 'info', message: `Uploading "${datasetName.trim()}" to Cirro…` });
      onClose();
    } catch (err) {
      reportError('Cirro upload failed', err);
      setSubmitting(false);
    }
  }

  const loaded = projects && sessions;
  const canSubmit = !!projectId && !!datasetName.trim() && selectedSessions.size > 0 && !submitting;

  const fieldClass = 'w-full bg-bg border border-border rounded px-3 py-2 text-sm text-text placeholder-muted/50 focus:outline-none focus:border-accent';

  return (
    <ModalOverlay onClose={onClose} widthClassName="w-[860px] max-w-[94vw] h-[620px]">
      <ModalHeader
        title="Upload to Cirro"
        subtitle={cirroAuth?.username
          ? `Signed in as ${cirroAuth.username} at ${cirroAuth.domain}.`
          : 'Upload saved sessions as one dataset.'}
        onClose={onClose}
      />

      <div className="flex flex-1 min-h-0">
        {/* Left: dataset destination */}
        <aside className="w-72 shrink-0 border-r border-border p-4 flex flex-col gap-4 overflow-y-auto">
          {error && (
            <div className="text-xs text-danger bg-danger/10 border border-danger/20 rounded px-3 py-2">
              {error}
            </div>
          )}
          {!loaded && !error && <div className="text-xs text-muted">Loading…</div>}

          {loaded && (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-mono text-muted">
                  Project <span className="text-danger">*</span>
                </label>
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className={fieldClass}
                >
                  <option value="">Select a project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-mono text-muted">
                  Dataset name <span className="text-danger">*</span>
                </label>
                <input
                  value={datasetName}
                  onChange={(e) => setDatasetName(e.target.value)}
                  autoComplete="off"
                  role="presentation"
                  className={fieldClass}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-mono text-muted">Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  className={`${fieldClass} resize-y`}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-mono text-muted">Destination folder</label>
                <input
                  type="text"
                  list={folderListId}
                  placeholder={projectId ? 'Pick or type a folder…' : 'Select a project first'}
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  disabled={!projectId}
                  autoComplete="off"
                  role="presentation"
                  spellCheck={false}
                  className={`${fieldClass} font-mono disabled:opacity-50`}
                />
                <datalist id={folderListId}>
                  {folders.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
                <span className="text-[10px] text-muted/60">
                  Optional — pick an existing folder or type a new path. Blank uploads to the project root.
                </span>
              </div>
            </>
          )}
        </aside>

        {/* Right: pick the saved sessions to bundle */}
        {loaded && (
          <section className="flex-1 min-w-0 flex flex-col bg-bg/40">
            <div className="shrink-0 border-b border-border px-3 py-2 flex items-baseline gap-2">
              <span className="text-xs font-semibold text-text">Saved sessions</span>
              <span className="text-[11px] text-muted/70">select any to include</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {sessions.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-muted/60">No saved sessions.</div>
              )}
              {sessions.map((d) => (
                <button
                  key={d.path}
                  onClick={() => setSelectedSessions(toggle(selectedSessions, d.path))}
                  title={d.path}
                  className={`w-full text-left px-3 py-2 border-b border-border/50 transition-colors flex items-center gap-2 ${
                    selectedSessions.has(d.path) ? 'bg-accent/20 text-accent' : 'text-text hover:bg-accent-lo/30'
                  }`}
                >
                  <input type="checkbox" checked={selectedSessions.has(d.path)} readOnly tabIndex={-1} className="shrink-0 pointer-events-none" />
                  <span className="flex flex-col min-w-0 flex-1">
                    <span className="text-xs font-medium truncate">{d.name}</span>
                    {savedAt(d.mtime) && <span className="text-[10px] text-muted/70 mt-0.5">{savedAt(d.mtime)}</span>}
                  </span>
                </button>
              ))}
            </div>
            {/* The bundle is a serverless deployment (DESIGN 14.3): the checkpoints, an
                index.json listing them, and the viewer itself — but only where a built
                SPA is on disk, which it isn't in local dev. Say which upload this is. */}
            <div className="shrink-0 border-t border-border px-3 py-2 text-[10px] text-muted/70">
              {cirroAuth?.viewer_bundled
                ? 'The viewer (index.html) and an index.json manifest are uploaded alongside the sessions, so the dataset opens as a browsable collection.'
                : 'No built viewer is available on this server, so only the sessions and an index.json manifest are uploaded.'}
            </div>
          </section>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-4 py-3 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-muted hover:text-text border border-border rounded hover:bg-bg transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="px-4 py-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-on-accent rounded text-sm transition-colors"
        >
          {submitting ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </ModalOverlay>
  );
}
