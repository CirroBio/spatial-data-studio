import { useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { annotateSession, createShapeAnnotation } from '../api';
import { defaultStroke, defaultFill, type ShapeAnnotation } from '../schemas/annotations';
import { reportError } from '../lib/errors';
import { resolveRegionSetColumn } from '../lib/regions';
import { useDrawSelection } from '../hooks/useDrawSelection';
import ColorSwatchPicker from './ColorSwatchPicker';
import DrawControls from './DrawControls';
import ObsFieldSelect from './ObsFieldSelect';
import type { RegionSet } from '../types';

const NEW_CAT_COLORS = [
  '#e05c5c', '#e08a3a', '#d4c84a', '#5cb85c', '#4ab8c4', '#5c7ae0', '#a05ce0', '#e05cba',
];

// Draw the just-labelled region as shape annotations: one faintly-filled outline per
// ring plus a single text label at the region's centre. The label's world-space
// fontSize is scaled to the region's extent (10% of its larger span) so it reads at a
// sensible size whatever the dataset's coordinate scale, without needing the live zoom.
async function createRegionAnnotations(
  sessionId: string, rings: [number, number][][], label: string, color: string,
): Promise<void> {
  const closed = rings.filter((r) => r.length >= 3);
  if (!closed.length) return;
  const verts = closed.flat();
  const xs = verts.map((p) => p[0]);
  const ys = verts.map((p) => p[1]);
  const cx = xs.reduce((s, v) => s + v, 0) / verts.length;
  const cy = ys.reduce((s, v) => s + v, 0) / verts.length;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
  for (const ring of closed) {
    const poly: Omit<ShapeAnnotation, 'id'> = {
      label,
      geometry: { kind: 'polygon', vertices: ring },
      stroke: { ...defaultStroke(), color },
      fill: { ...defaultFill(), color, alpha: 0.15 },
    };
    await createShapeAnnotation(sessionId, poly);
  }
  const text: Omit<ShapeAnnotation, 'id'> = {
    label,
    geometry: { kind: 'text', position: [cx, cy], text: label, fontSize: span * 0.1, rotation: 0 },
    stroke: { ...defaultStroke(), color },
  };
  await createShapeAnnotation(sessionId, text);
}

export default function RegionsPanel() {
  const {
    activeSessionId,
    sessionState,
    activeRegionSetId,
    setActiveRegionSetId,
    isolatedCategory,
    setIsolatedCategory,
    regionNewSetName,
    regionCategoryName,
    regionColor,
    setRegionTarget,
    regionCellCount,
    regionCellIndices,
  } = useAppStore();
  const { drawPolygons, drawRing, regionCount, allPolygons, commitDrawRing, clearDraw } = useDrawSelection();

  const regions: RegionSet[] = sessionState?.app_state.regions ?? [];
  const obsFields = sessionState?.fields.obs ?? [];

  const [applying, setApplying] = useState(false);
  // When set, applying a label also draws the region as a shape annotation (outline +
  // a text label at its centre). Only offered on the spatial canvas — shape annotations
  // live in tissue coordinates, so they don't apply to an embedding selection.
  const [annotateRegion, setAnnotateRegion] = useState(false);
  const canAnnotateRegion = regionCellIndices == null;

  const activeSet = regions.find((r) => r.id === activeRegionSetId) ?? regions[0] ?? null;

  // Resolve against the set the dropdown actually shows (activeSet, which falls back
  // to regions[0]); activeRegionSetId stays null until the user changes the select,
  // so using it directly would leave Apply disabled on a freshly opened session.
  const regionSetTarget = resolveRegionSetColumn(regionNewSetName, activeSet?.id ?? null, regions);
  const canApply = regionCount > 0 && !!regionSetTarget && !!regionCategoryName;

  async function handleApplyLabel() {
    if (!activeSessionId || !canApply) return;
    setApplying(true);
    try {
      await annotateSession(activeSessionId, {
        // Embedding view resolves the lasso to cell indices client-side; spatial sends
        // the rings for the backend polygon_query.
        ...(regionCellIndices ? { cell_indices: regionCellIndices } : { polygons: allPolygons }),
        region_set: regionSetTarget,
        category: regionCategoryName,
        color: regionColor,
      });
      if (annotateRegion && canAnnotateRegion && allPolygons.length) {
        await createRegionAnnotations(activeSessionId, allPolygons, regionCategoryName, regionColor);
      }
      clearDraw();
    } catch (err) {
      reportError('Annotate failed', err);
    } finally {
      setApplying(false);
    }
  }

  if (!activeSessionId) {
    return <div className="px-3 py-4 text-xs text-muted/60 text-center">No session open</div>;
  }

  return (
    <div className="flex flex-col gap-0">
      {/* Draw + label a region. This is the primary action, so it leads the panel;
          existing region sets are listed below in the legend. A "region set" is a
          categorical obs column (e.g. tissue_regions); a "category" is one label
          within it (e.g. tumor). Drawing paints the enclosed cells with that label. */}
      <div className="px-3 py-2 border-b border-border/50">
        <label className="text-[10px] text-muted font-mono uppercase tracking-wide block mb-1.5">Draw a region</label>
        <ol className="text-[10px] text-muted/70 leading-snug list-decimal pl-3.5 mb-2 space-y-0.5">
          <li>Name a region set &amp; category, pick a color.</li>
          <li>Click points on the canvas to outline the area.</li>
          <li>Apply label (Finish region first to start a second area).</li>
        </ol>
        <div className="flex flex-col gap-1.5">
          <ObsFieldSelect
            fields={obsFields}
            value={regionNewSetName}
            onChange={(v) => setRegionTarget(v, regionCategoryName, regionColor)}
            creatable
            placeholder="Region set (pick or create)"
          />
          <input
            type="text"
            placeholder="Category label (e.g. tumor)"
            value={regionCategoryName}
            onChange={(e) => setRegionTarget(regionNewSetName, e.target.value, regionColor)}
            className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text placeholder:text-muted/40 focus:outline-none focus:border-accent"
          />
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={regionColor}
              onChange={(e) => setRegionTarget(regionNewSetName, regionCategoryName, e.target.value)}
              className="w-7 h-6 rounded border border-border bg-bg cursor-pointer"
            />
            <ColorSwatchPicker
              colors={NEW_CAT_COLORS}
              selected={regionColor}
              onSelect={(c) => setRegionTarget(regionNewSetName, regionCategoryName, c)}
            />
          </div>
          {canAnnotateRegion && (
            <label className="flex items-center gap-2 text-[11px] text-text cursor-pointer">
              <input
                type="checkbox"
                checked={annotateRegion}
                onChange={(e) => setAnnotateRegion(e.target.checked)}
                className="accent-accent"
              />
              Annotate region (outline + label on the canvas)
            </label>
          )}
        </div>

        {/* Draw controls — drawing happens on the canvas; actions live here. */}
        <div className="mt-2 flex flex-col gap-1.5">
          <DrawControls
            regionCount={regionCount}
            drawRingLength={drawRing.length}
            drawPolygonsLength={drawPolygons.length}
            onFinish={commitDrawRing}
            onClear={clearDraw}
          />
          <button
            type="button"
            onClick={handleApplyLabel}
            disabled={applying || !canApply}
            className="py-1.5 text-xs text-white rounded transition-colors disabled:opacity-40"
            style={{ background: '#3d9970' }}
          >
            {applying ? 'Labeling...' : `Apply label${regionCount ? ` (n=${regionCellCount.toLocaleString()})` : ''}`}
          </button>
          {regionCount === 0 && (
            <p className="text-[10px] text-muted/60 leading-snug">Click at least 3 points on the canvas to outline a region.</p>
          )}
          {regionCount > 0 && !canApply && (
            <p className="text-[10px] text-warn leading-snug">Set a region set and category above.</p>
          )}
        </div>
      </div>

      {/* Region sets with category legend. Clicking a set highlights it (and its
          categories drive the isolate-one-category filter). */}
      {regions.length > 0 && (
        <div className="border-b border-border/50">
          <div className="px-3 py-1.5">
            <span className="text-[10px] text-muted font-mono uppercase tracking-wide">Region sets</span>
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

      {isolatedCategory && (
        <div className="px-3 py-2">
          <button
            onClick={() => setIsolatedCategory(null)}
            className="w-full py-1 text-[10px] bg-bg border border-border rounded text-muted hover:text-text transition-colors"
          >
            Clear isolation filter
          </button>
        </div>
      )}
    </div>
  );
}
