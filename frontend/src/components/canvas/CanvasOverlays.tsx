import { VIRIDIS_CSS_GRADIENT } from './colorUtils';
import type { Channel } from './useImageChannels';
import type { ColorLegend } from './useSpotColors';

/* Recalculation cue — top left. Visible while spatial coords, colors, or
   image tiles for the current view are still loading/rendering. */
export function LoadingCue({
  coordsLoading,
  colorLoading,
  tilesLoading,
}: {
  coordsLoading: boolean;
  colorLoading: boolean;
  tilesLoading: boolean;
}) {
  if (!(coordsLoading || colorLoading || tilesLoading)) return null;
  return (
    <div className="absolute top-3 left-3 z-20 flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface/95 border border-accent/60 text-xs text-text backdrop-blur-sm shadow-lg pointer-events-none">
      <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <span>
        {coordsLoading ? 'Loading cells…' : colorLoading ? 'Loading colors…' : 'Rendering image…'}
      </span>
    </div>
  );
}

/* Channel legend — bottom left, only while the image and legend are shown. */
export function ChannelLegend({
  show,
  showLegend,
  channels,
}: {
  show: boolean;
  showLegend: boolean;
  channels: Channel[];
}) {
  if (!(show && showLegend && channels.some((c) => c.visible))) return null;
  return (
    <div className="absolute bottom-3 left-3 z-10 bg-surface/90 border border-border rounded p-2 flex flex-col gap-1 max-w-[180px] backdrop-blur-sm pointer-events-none">
      {channels.filter((c) => c.visible).map((c) => (
        <div key={c.index} className="flex items-center gap-1.5 text-[11px] text-text">
          <span className="w-2.5 h-2.5 rounded-sm shrink-0 border border-border/50" style={{ background: c.color }} />
          <span className="truncate">{c.name}</span>
        </div>
      ))}
    </div>
  );
}

/* Cell-color legend — bottom right. Colorbar for numeric, swatches for categorical. */
export function CellColorLegend({
  visible,
  legend,
  title,
}: {
  visible: boolean;
  legend: ColorLegend | null;
  title: string;
}) {
  if (!(visible && legend)) return null;
  return (
    <div className="absolute bottom-3 right-3 z-10 bg-surface/90 border border-border rounded p-2 max-w-[200px] backdrop-blur-sm">
      <div className="text-[11px] font-medium text-text mb-1 truncate" title={title}>{title}</div>
      {legend.kind === 'categorical' ? (
        <div className="flex flex-col gap-1 max-h-[220px] overflow-y-auto">
          {legend.items.map((it) => (
            <div key={it.label} className="flex items-center gap-1.5 text-[11px] text-text">
              <span
                className="w-2.5 h-2.5 rounded-sm shrink-0 border border-border/50"
                style={{ background: `rgb(${it.color[0]},${it.color[1]},${it.color[2]})` }}
              />
              <span className="truncate">{it.label}</span>
            </div>
          ))}
        </div>
      ) : legend.kind === 'too-many-categories' ? (
        <div className="text-[11px] text-muted">
          {legend.count.toLocaleString()} categories — too many to color (limit {legend.limit}).
        </div>
      ) : (
        <div className="flex flex-col gap-1 w-[150px]">
          <div className="h-2.5 w-full rounded-sm border border-border/50" style={{ background: VIRIDIS_CSS_GRADIENT }} />
          <div className="flex justify-between text-[10px] text-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <span>{legend.min.toLocaleString(undefined, { maximumSignificantDigits: 3 })}</span>
            <span>{legend.max.toLocaleString(undefined, { maximumSignificantDigits: 3 })}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* Draw-mode hint — top center. All actions live in the active tab's panel. */
export function DrawHint({
  drawMode,
  canvasMode,
  annotationTarget,
}: {
  drawMode: boolean;
  canvasMode: 'regions' | 'shapes' | 'subset' | null;
  annotationTarget: { regionSetId: string; category: string; color: string } | null;
}) {
  // The shape-annotation editor (canvasMode === 'shapes') shows its own toolbar
  // hints in the AnnotationsPanel; this hint is only for the lasso-drag modes.
  if (!drawMode || canvasMode === 'shapes') return null;
  return (
    <div
      className="absolute top-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded text-xs tracking-wide pointer-events-none backdrop-blur-sm whitespace-nowrap"
      style={{
        background: 'rgba(26,29,39,0.92)',
        border: `1px solid ${canvasMode === 'regions' ? 'rgba(72,187,120,0.7)' : 'rgba(124,108,246,0.7)'}`,
        color: canvasMode === 'regions' ? '#6fd99a' : '#a99bff',
      }}
    >
      {canvasMode === 'regions'
        ? annotationTarget
          ? `Annotating ${annotationTarget.regionSetId} / ${annotationTarget.category} — click to add points, then Apply on the left`
          : 'Annotating — set a region set and category on the left, then click to add points'
        : 'Subsetting — draw a region, then Subset to selection on the left'}
    </div>
  );
}
