import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import {
  getCirroProjects, getCirroProcesses, getSnapshots, uploadToCirro,
  type CirroProject, type CirroProcess,
} from '../api';
import { formatError, reportError } from '../lib/errors';

interface Props {
  sessionId: string;
  onClose: () => void;
}

export default function CirroUploadDialog({ sessionId, onClose }: Props) {
  const { sessions, pushNotification } = useAppStore();
  const session = sessions.find((s) => s.id === sessionId);

  const [projects, setProjects] = useState<CirroProject[] | null>(null);
  const [processes, setProcesses] = useState<CirroProcess[] | null>(null);
  const [snapshots, setSnapshots] = useState<{ name: string; url: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [projectId, setProjectId] = useState('');
  const [processId, setProcessId] = useState('');
  const [datasetName, setDatasetName] = useState(session?.name ?? '');
  const [selectedSnapshots, setSelectedSnapshots] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([getCirroProjects(), getCirroProcesses(), getSnapshots()])
      .then(([p, pr, s]) => {
        setProjects(p.projects);
        setProcesses(pr.processes);
        setSnapshots(s.snapshots);
      })
      .catch((err) => setError(formatError(err)));
  }, []);

  function toggleSnapshot(name: string) {
    setSelectedSnapshots((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      await uploadToCirro(sessionId, {
        project_id: projectId, process_id: processId, dataset_name: datasetName.trim(),
        snapshot_names: [...selectedSnapshots],
      });
      pushNotification({ kind: 'info', message: `Uploading "${datasetName.trim()}" to Cirro…` });
      onClose();
    } catch (err) {
      reportError('Cirro upload failed', err);
      setSubmitting(false);
    }
  }

  const canSubmit = !!projectId && !!processId && !!datasetName.trim() && !submitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-lg shadow-xl w-[480px] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-text">Upload to Cirro</h2>
            <p className="text-xs text-muted">Upload the saved session (and any selected snapshots) as a dataset.</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text transition-colors" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {error && <div className="text-xs text-danger px-1">{error}</div>}
          {(!projects || !processes || !snapshots) && !error && (
            <div className="text-xs text-muted px-1">Loading…</div>
          )}

          {projects && processes && snapshots && (
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
                Ingest process
                <select
                  value={processId}
                  onChange={(e) => setProcessId(e.target.value)}
                  className="bg-bg border border-border rounded px-2 py-1.5 text-sm text-text"
                >
                  <option value="">Select a process…</option>
                  {processes.map((p) => (
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

              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted">Snapshots to include (optional)</span>
                {snapshots.length === 0 && <span className="text-xs text-muted/70 px-1">No saved snapshots.</span>}
                <div className="flex flex-col gap-1 max-h-40 overflow-y-auto border border-border rounded p-1.5">
                  {snapshots.map((s) => (
                    <label key={s.name} className="flex items-center gap-2 text-xs text-text px-1 py-0.5">
                      <input
                        type="checkbox"
                        checked={selectedSnapshots.has(s.name)}
                        onChange={() => toggleSnapshot(s.name)}
                      />
                      <span className="truncate">{s.name}</span>
                    </label>
                  ))}
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
      </div>
    </div>
  );
}
