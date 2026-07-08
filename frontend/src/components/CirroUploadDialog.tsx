import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import {
  getCirroFolders, getCirroProjects, getDatasets, getSnapshots, uploadToCirro,
  type CirroProject, type DatasetEntry,
} from '../api';
import { formatError, reportError } from '../lib/errors';
import type { Snapshot } from '../lib/snapshots';
import { ModalOverlay, ModalHeader } from './DetailModal';
import SnapshotList from './SnapshotList';

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
  const { pushNotification } = useAppStore();

  const [projects, setProjects] = useState<CirroProject[] | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [sessions, setSessions] = useState<DatasetEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [projectId, setProjectId] = useState('');
  const [datasetName, setDatasetName] = useState('');
  const [folder, setFolder] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [selectedSnapshots, setSelectedSnapshots] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([getCirroProjects(), getSnapshots(), getDatasets()])
      .then(([p, s, d]) => {
        setProjects(p.projects);
        setSnapshots(s.snapshots);
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
        session_paths: [...selectedSessions], snapshot_names: [...selectedSnapshots],
        folder: folder.trim() || undefined,
      });
      pushNotification({ kind: 'info', message: `Uploading "${datasetName.trim()}" to Cirro…` });
      onClose();
    } catch (err) {
      reportError('Cirro upload failed', err);
      setSubmitting(false);
    }
  }

  const loaded = projects && snapshots && sessions;
  const canSubmit = !!projectId && !!datasetName.trim()
    && (selectedSessions.size > 0 || selectedSnapshots.size > 0) && !submitting;

  return (
    <ModalOverlay onClose={onClose} widthClassName="w-[560px] max-h-[85vh]">
      <ModalHeader
        title="Upload to Cirro"
        subtitle="Upload selected saved sessions and snapshots as a dataset."
        onClose={onClose}
      />

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {error && <div className="text-xs text-danger px-1">{error}</div>}
        {!loaded && !error && <div className="text-xs text-muted px-1">Loading…</div>}

        {loaded && (
          <>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Project
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="bg-bg border border-border rounded px-2 py-1.5 text-sm text-text"
              >
                <option value="">Select a project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-muted">
              Dataset name
              <input
                value={datasetName}
                onChange={(e) => setDatasetName(e.target.value)}
                className="bg-bg border border-border rounded px-2 py-1.5 text-sm text-text"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs text-muted">
              Folder (optional)
              <input
                list="cirro-folder-options"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="e.g. experiments/2024"
                autoComplete="off"
                className="bg-bg border border-border rounded px-2 py-1.5 text-sm text-text"
              />
              <datalist id="cirro-folder-options">
                {folders.map((f) => <option key={f} value={f} />)}
              </datalist>
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted">Saved sessions to include</span>
              {sessions.length === 0 && <span className="text-xs text-muted/70 px-1">No saved sessions.</span>}
              <div className="max-h-40 overflow-y-auto border border-border rounded">
                {sessions.map((d) => (
                  <button
                    key={d.path}
                    onClick={() => setSelectedSessions((s) => toggle(s, d.path))}
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
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted">Snapshots to include</span>
              {snapshots.length === 0 && <span className="text-xs text-muted/70 px-1">No saved snapshots.</span>}
              <div className="max-h-40 overflow-y-auto border border-border rounded">
                <SnapshotList
                  snapshots={snapshots}
                  multi
                  isSelected={(s) => selectedSnapshots.has(s.name)}
                  onSelect={(s) => setSelectedSnapshots((prev) => toggle(prev, s.name))}
                />
              </div>
            </div>
          </>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
        <button onClick={onClose} className="px-3 py-1.5 text-xs text-muted hover:text-text transition-colors">
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="px-3 py-1.5 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white rounded text-xs transition-colors"
        >
          {submitting ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </ModalOverlay>
  );
}
