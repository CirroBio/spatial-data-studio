import { useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { promoteObsColumn, annotateSession } from '../api';
import type { RegionSet } from '../types';

const NEW_CAT_COLORS = [
  '#e05c5c', '#e08a3a', '#d4c84a', '#5cb85c', '#4ab8c4', '#5c7ae0', '#a05ce0', '#e05cba',
];

export default function AnnotationsPanel() {
  const {
    activeSessionId,
    sessionState,
    activeRegionSetId,
    setActiveRegionSetId,
    isolatedCategory,
    setIsolatedCategory,
    annotationNewSetName,
    annotationCategoryName,
    annotationColor,
    setAnnotationTarget,
    drawPolygons,
    drawRing,
    commitDrawRing,
    clearDraw,
  } = useAppStore();

  const regions: RegionSet[] = sessionState?.app_state.regions ?? [];
  const obsFields = sessionState?.fields.obs ?? [];
  const categoricalObs = obsFields.filter((f) => f.kind === 'categorical');

  const [promoteColumn, setPromoteColumn] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [applying, setApplying] = useState(false);

  const activeSet = regions.find((r) => r.id === activeRegionSetId) ?? regions[0] ?? null;

  const regionCount = drawPolygons.length + (drawRing.length >= 3 ? 1 : 0);
  const regionSetTarget = annotationNewSetName || activeRegionSetId || '';
  const canApply = regionCount > 0 && !!regionSetTarget && !!annotationCategoryName;

  async function handleApplyLabel() {
    if (!activeSessionId || !canApply) return;
    const all = drawRing.length >= 3 ? [...drawPolygons, drawRing] : drawPolygons;
    setApplying(true);
    try {
      await annotateSession(activeSessionId, {
        polygons: all,
        region_set: regionSetTarget,
        category: annotationCategoryName,
        color: annotationColor,
      });
      clearDraw();
    } catch (err) {
      useAppStore.getState().pushNotification({
        kind: 'error',
        message: `Annotate failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setApplying(false);
    }
  }

  async function handlePromote() {
    if (!activeSessionId || !promoteColumn) return;
    setPromoting(true);
    try {
      await promoteObsColumn(activeSessionId, promoteColumn);
      setPromoteColumn('');
    } catch (err) {
      useAppStore.getState().pushNotification({
        kind: 'error',
        message: `Promote failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setPromoting(false);
    }
  }

  if (!activeSessionId) {
    return <div className="px-3 py-4 text-xs text-muted/60 text-center">No session open</div>;
  }

  return (
    <div className="flex flex-col gap-0">
      {/* Active region set selector */}
      <div className="px-3 py-2 border-b border-border/50">
        <label className="text-[10px] text-muted font-mono uppercase tracking-wide block mb-1">Active region set</label>
        {regions.length === 0 ? (
          <div className="text-[11px] text-muted/60">No region sets yet</div>
        ) : (
          <select
            value={activeSet?.id ?? ''}
            onChange={(e) => setActiveRegionSetId(e.target.value)}
            className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:border-accent"
          >
            {regions.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Annotation drawing target — region set name + category + color */}
      <div className="px-3 py-2 border-b border-border/50">
        <label className="text-[10px] text-muted font-mono uppercase tracking-wide block mb-1.5">Draw label</label>
        <div className="flex flex-col gap-1.5">
          <input
            type="text"
            list="obs-field-names"
            placeholder="Region set name (pick an obs field or type a new one)"
            value={annotationNewSetName}
            onChange={(e) => setAnnotationTarget(e.target.value, annotationCategoryName, annotationColor)}
            className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text placeholder:text-muted/40 focus:outline-none focus:border-accent"
          />
          <datalist id="obs-field-names">
            {obsFields.map((f) => (
              <option key={f.name} value={f.name} />
            ))}
          </datalist>
          <input
            type="text"
            placeholder="Category label"
            value={annotationCategoryName}
            onChange={(e) => setAnnotationTarget(annotationNewSetName, e.target.value, annotationColor)}
            className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text placeholder:text-muted/40 focus:outline-none focus:border-accent"
          />
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={annotationColor}
              onChange={(e) => setAnnotationTarget(annotationNewSetName, annotationCategoryName, e.target.value)}
              className="w-7 h-6 rounded border border-border bg-bg cursor-pointer"
            />
            <div className="flex gap-1 flex-wrap">
              {NEW_CAT_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setAnnotationTarget(annotationNewSetName, annotationCategoryName, c)}
                  className="w-4 h-4 rounded-sm border transition-all"
                  style={{
                    background: c,
                    borderColor: annotationColor === c ? 'white' : 'transparent',
                    outline: annotationColor === c ? `1px solid ${c}` : 'none',
                  }}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>
          <p className="text-[10px] text-muted/60 leading-snug">
            Draw on the canvas, then Apply label.
          </p>
        </div>

        {/* Draw controls — drawing happens on the canvas; actions live here. */}
        <div className="mt-2 flex flex-col gap-1.5">
          <p className="text-[10px] text-muted leading-snug">
            {regionCount} region{regionCount === 1 ? '' : 's'}
            {drawRing.length > 0 ? `, ${drawRing.length}-pt drawing` : ''}.
          </p>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={commitDrawRing}
              disabled={drawRing.length < 3}
              className="flex-1 py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent disabled:opacity-40 transition-colors"
            >
              Finish region
            </button>
            <button
              type="button"
              onClick={clearDraw}
              disabled={drawPolygons.length === 0 && drawRing.length === 0}
              className="flex-1 py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent disabled:opacity-40 transition-colors"
            >
              Clear
            </button>
          </div>
          <button
            type="button"
            onClick={handleApplyLabel}
            disabled={applying || !canApply}
            className="py-1.5 text-xs text-white rounded transition-colors disabled:opacity-40"
            style={{ background: '#3d9970' }}
          >
            {applying ? 'Labeling...' : `Apply label${regionCount ? ` (${regionCount})` : ''}`}
          </button>
          {regionCount > 0 && !canApply && (
            <p className="text-[10px] text-warn leading-snug">Set a region set name and category above.</p>
          )}
        </div>
      </div>

      {/* Region sets with category legend */}
      {regions.length > 0 && (
        <div className="border-b border-border/50">
          <div className="px-3 py-1.5">
            <span className="text-[10px] text-muted font-mono uppercase tracking-wide">Legend</span>
          </div>
          {regions.map((rset) => (
            <div key={rset.id} className={`border-b border-border/30 ${activeSet?.id === rset.id ? 'bg-accent-lo/20' : ''}`}>
              <button
                onClick={() => setActiveRegionSetId(rset.id)}
                className="w-full text-left px-3 py-1.5 flex items-center justify-between group"
              >
                <span className="text-xs font-mono text-text truncate">{rset.name}</span>
                <span className="text-[9px] font-mono shrink-0 text-muted/50">{rset.obs_column}</span>
              </button>

              {rset.categories.length > 0 && (
                <ul className="pb-1">
                  {rset.categories.map((cat) => (
                    <li key={cat.label}>
                      <button
                        onClick={() => setIsolatedCategory(isolatedCategory === cat.label ? null : cat.label)}
                        className={`w-full text-left px-4 py-1 flex items-center gap-2 hover:bg-accent-lo/20 transition-colors ${
                          isolatedCategory === cat.label ? 'bg-accent-lo/30' : ''
                        }`}
                      >
                        <span
                          className="w-3 h-3 rounded-sm shrink-0 border border-black/20"
                          style={{ background: cat.color }}
                        />
                        <span className="text-[11px] text-text/90 truncate flex-1">{cat.label}</span>
                        <span
                          className="text-[10px] shrink-0"
                          style={{ color: cat.color, fontVariantNumeric: 'tabular-nums' }}
                        >
                          {cat.n_cells.toLocaleString()}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {rset.categories.length === 0 && (
                <div className="px-4 pb-1.5 text-[10px] text-muted/50">No categories yet</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Promote obs categorical to region set */}
      <div className="px-3 py-2">
        <label className="text-[10px] text-muted font-mono uppercase tracking-wide block mb-1.5">Promote obs column</label>
        {categoricalObs.length === 0 ? (
          <div className="text-[11px] text-muted/60">No categorical obs fields</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <select
              value={promoteColumn}
              onChange={(e) => setPromoteColumn(e.target.value)}
              className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:border-accent"
            >
              <option value="">Select column...</option>
              {categoricalObs.map((f) => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </select>
            <button
              onClick={handlePromote}
              disabled={promoting || !promoteColumn}
              className="py-1 text-xs bg-accent/20 hover:bg-accent/30 text-accent rounded disabled:opacity-40 transition-colors"
            >
              {promoting ? 'Promoting...' : 'Promote to region set'}
            </button>
          </div>
        )}
        {isolatedCategory && (
          <button
            onClick={() => setIsolatedCategory(null)}
            className="mt-3 w-full py-1 text-[10px] bg-bg border border-border rounded text-muted hover:text-text transition-colors"
          >
            Clear isolation filter
          </button>
        )}
      </div>
    </div>
  );
}
