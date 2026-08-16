import { useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { addDisplay as postDisplay } from '../api';
import { useEditGate } from '../hooks/usePresence';
import { reportError } from '@cirrobio/spatial-viewer';
import type { ObsField, ObsmField } from '@cirrobio/spatial-viewer';
import ColorBySelect from './canvas/ColorBySelect';

// Authoring the session's embedding display, shown where the embedding canvas would be
// when the session has none yet. App-level rather than part of the canvas: creating a
// display POSTs it to the session, which is a write the canvas itself never makes.
export default function EmbeddingEmptyState({
  sessionId,
  obsmFields,
  obsFields,
  layers,
}: {
  sessionId: string;
  obsmFields: ObsmField[];
  obsFields: ObsField[];
  layers: string[];
}) {
  const addDisplay = useAppStore((s) => s.addDisplay);
  const firstCategorical = obsFields.find((f) => f.kind === 'categorical');
  const [selectedKey, setSelectedKey] = useState(obsmFields[0]?.name ?? '');
  const [colorBy, setColorBy] = useState(firstCategorical ? `obs:${firstCategorical.name}` : '');
  const [creating, setCreating] = useState(false);
  // Creating the view POSTs a display to the session, so it needs the edit lock even
  // though everything else about this canvas is read-only.
  const { canEdit, reason: editBlockedReason } = useEditGate();

  if (obsmFields.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm text-center px-8">
        No embeddings found — run a dimensionality reduction (e.g. UMAP, PCA) to populate this view.
      </div>
    );
  }

  // selectedKey's initial value is captured before any embedding exists (the
  // empty branch above), so fall back to the first available key if it's stale.
  const embeddingKey = obsmFields.some((f) => f.name === selectedKey) ? selectedKey : obsmFields[0].name;

  async function handleCreate() {
    const field = obsmFields.find((f) => f.name === embeddingKey);
    const n = field?.n_components ?? 2;
    setCreating(true);
    try {
      const spec = await postDisplay(sessionId, {
        type: 'embedding_canvas',
        encoding: {
          obsm_key: embeddingKey,
          x_component: 0,
          y_component: Math.min(1, n - 1),
          z_component: Math.min(2, n - 1),
          is_3d: false,
          color_by: colorBy,
          point_size: 4,
          opacity: 0.85,
          colormap: 'viridis',
          legend_visible: true,
          legend_title: '',
        },
        viewport: null,
      });
      addDisplay(spec);
    } catch (e) {
      reportError('Could not create embedding view', e);
    } finally {
      setCreating(false);
    }
  }

  const labelClass = 'text-[10px] text-muted font-mono uppercase tracking-wide';

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-muted">
      <span className="text-sm">No embedding view configured for this session yet.</span>
      <div className="flex flex-col gap-2 w-60">
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Embedding</label>
          <select
            value={embeddingKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:border-accent"
          >
            {obsmFields.map((f) => (
              <option key={f.name} value={f.name}>{f.name}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Color by</label>
          <ColorBySelect
            value={colorBy}
            obsFields={obsFields}
            layers={layers}
            onChange={setColorBy}
          />
        </div>
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating || !canEdit}
          title={editBlockedReason ?? undefined}
          className="mt-1 w-full px-3 py-1 bg-accent hover:bg-accent/80 text-on-accent rounded text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creating ? 'Creating…' : 'Create embedding view'}
        </button>
      </div>
    </div>
  );
}
