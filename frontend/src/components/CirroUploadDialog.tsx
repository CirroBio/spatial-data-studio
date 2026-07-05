import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import {
  getCirroProjects, getSnapshots, uploadToCirro,
  type CirroProject,
} from '../api';
import { formatError, reportError } from '../lib/errors';
import { ModalOverlay, ModalHeader } from './DetailModal';

interface Props {
  sessionId: string;
  onClose: () => void;
}

export default function CirroUploadDialog({ sessionId, onClose }: Props) {
  const { sessions, pushNotification } = useAppStore();
  const session = sessions.find((s) => s.id === sessionId);

  const [projects, setProjects] = useState<CirroProject[] | null>(null);
  const [snapshots, setSnapshots] = useState<{ name: string; url: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [projectId, setProjectId] = useState('');
  const [datasetName, setDatasetName] = useState(session?.name ?? '');
  const [selectedSnapshots, setSelectedSnapshots] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([getCirroProjects(), getSnapshots()])
      .then(([p, s]) => {
        setProjects(p.projects);
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
        project_id: projectId, dataset_name: datasetName.trim(),
        snapshot_names: [...selectedSnapshots],
      });
      pushNotification({ kind: 'info', message: `Uploading "${datasetName.trim()}" to Cirro…` });
      onClose();
    } catch (err) {
      reportError('Cirro upload failed', err);
      setSubmitting(false);
    }
  }

  const canSubmit = !!projectId && !!datasetName.trim() && !submitting;

  return (
    <ModalOverlay onClose={onClose} widthClassName="w-[480px] max-h-[80vh]">
      <ModalHeader
        title="Upload to Cirro"
        subtitle="Upload the saved session (and any selected snapshots) as a dataset."
        onClose={onClose}
      />

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {error && <div className="text-xs text-danger px-1">{error}</div>}
        {(!projects || !snapshots) && !error && (
          <div className="text-xs text-muted px-1">Loading…</div>
        )}

        {projects && snapshots && (
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
    </ModalOverlay>
  );
}
