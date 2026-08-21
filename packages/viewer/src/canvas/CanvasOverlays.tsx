import { VIRIDIS_CSS_GRADIENT } from './colorUtils';
import {
  CELL_LEGEND, CHANNEL_LEGEND, DRAW_HINT, LEGEND_ROW, LOADING_CUE, SWATCH, TILE_STATUS,
  TRUNCATE, themeColor,
} from './overlayStyles';
import type { Channel } from './useImageChannels';
import type { ColorLegend } from './useSpotColors';
import type { TileLoadProgress } from './useTileLoadProgress';
import type { SelectionTool } from '../lib/selectionShapes';

/* Recalculation cue — top left. Visible while the cell layer's own data (spatial
   coordinates, per-cell colors, or cell-boundary polygons) for the current view is
   still loading. The image pyramid has its own indicator (ImageTileStatus). */
export function LoadingCue({
  coordsLoading,
  colorLoading,
  boundariesLoading,
}: {
  coordsLoading: boolean;
  colorLoading: boolean;
  boundariesLoading: boolean;
}) {
  if (!(coordsLoading || colorLoading || boundariesLoading)) return null;
  return (
    <div style={LOADING_CUE}>
      {/* SMIL rather than a CSS animation: the library ships no stylesheet, so it
          cannot declare the keyframes a spinner class would need. */}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M21 12a9 9 0 1 1-6.219-8.56">
          <animateTransform attributeName="transform" type="rotate"
            from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
        </path>
      </svg>
      <span>
        {coordsLoading ? 'Loading cells…' : colorLoading ? 'Loading colors…' : 'Loading cell boundaries…'}
      </span>
    </div>
  );
}

/* Image tile-loading progress — bottom center. Shows a progress bar (completed / requested
   tiles) while the image pyramid streams in, so the user knows image data is loading even
   when the canvas looks settled (e.g. idle look-ahead prefetch). Same bar style as the
   session-load overlay; hidden when no loading session is open. */
export function ImageTileStatus({ progress }: { progress: TileLoadProgress }) {
  if (!progress.active) return null;
  return (
    <div style={TILE_STATUS}>
      <span style={{ fontSize: 11, color: themeColor('muted') }}>Loading image…</span>
      <div style={{ width: 192, height: 6, borderRadius: 9999, background: themeColor('border'), overflow: 'hidden' }}>
        <div style={{
          height: '100%',
          background: themeColor('accent'),
          transition: 'width 150ms cubic-bezier(0.4, 0, 0.2, 1)',
          width: `${Math.round(progress.value * 100)}%`,
        }} />
      </div>
    </div>
  );
}

/* Channel legend — bottom left, only while the image and legend are shown. */
export function ChannelLegend({
  show,
  showLegend,
  channels,
  scale = 1,
}: {
  show: boolean;
  showLegend: boolean;
  channels: Channel[];
  scale?: number;
}) {
  if (!(show && showLegend && channels.some((c) => c.visible))) return null;
  return (
    // Scaled as a whole rather than by restating each size: the swatches, the type and
    // the colorbar keep their proportions, and the origin is the corner the panel is
    // anchored to, so growing it moves it inward instead of off the canvas.
    <div style={{ ...CHANNEL_LEGEND, transform: `scale(${scale})`, transformOrigin: 'bottom left' }}>
      {channels.filter((c) => c.visible).map((c) => (
        <div key={c.index} style={LEGEND_ROW}>
          <span style={{ ...SWATCH, background: c.color }} />
          <span style={TRUNCATE}>{c.name}</span>
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
  scale = 1,
}: {
  visible: boolean;
  legend: ColorLegend | null;
  title: string;
  scale?: number;
}) {
  if (!(visible && legend)) return null;
  return (
    <div style={{ ...CELL_LEGEND, transform: `scale(${scale})`, transformOrigin: 'bottom right' }}>
      <div
        style={{ ...TRUNCATE, fontSize: 11, fontWeight: 500, color: themeColor('text'), marginBottom: 4 }}
        title={title}
      >
        {title}
      </div>
      {legend.kind === 'categorical' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
          {legend.items.map((it) => (
            <div key={it.label} style={LEGEND_ROW}>
              <span style={{ ...SWATCH, background: `rgb(${it.color[0]},${it.color[1]},${it.color[2]})` }} />
              <span style={TRUNCATE}>{it.label}</span>
            </div>
          ))}
        </div>
      ) : legend.kind === 'too-many-categories' ? (
        <div style={{ fontSize: 11, color: themeColor('muted') }}>
          {legend.count.toLocaleString()} categories — too many to color (limit {legend.limit}).
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 150 }}>
          <div style={{
            height: 10, width: '100%', borderRadius: 2,
            border: `1px solid ${themeColor('border', 0.5)}`, background: VIRIDIS_CSS_GRADIENT,
          }} />
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontSize: 10, color: themeColor('muted'), fontVariantNumeric: 'tabular-nums',
          }}>
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
  selectionTool,
  shapePlaced,
}: {
  drawMode: boolean;
  canvasMode: 'regions' | 'shapes' | 'subset' | null;
  annotationTarget: { regionSetId: string; category: string; color: string } | null;
  selectionTool: SelectionTool;
  shapePlaced: boolean;
}) {
  // The shape-annotation editor (canvasMode === 'shapes') shows its own toolbar
  // hints in the AnnotationsPanel; this hint is only for the cell-selection modes.
  if (!drawMode || canvasMode === 'shapes') return null;
  const tone = canvasMode === 'regions' ? 'success' : 'accent';
  // The lasso collects a vertex per click; a geometric tool is one drag, and once its
  // shape is down the gesture that matters is adjusting it.
  const gesture = selectionTool === 'lasso' ? 'click to add points'
    : shapePlaced ? 'adjust the shape'
    : `drag out ${selectionTool === 'ellipse' ? 'an' : 'a'} ${selectionTool}`;
  return (
    <div style={{ ...DRAW_HINT, borderColor: themeColor(tone, 0.7), color: themeColor(tone) }}>
      {canvasMode === 'regions'
        ? annotationTarget
          ? `Annotating ${annotationTarget.regionSetId} / ${annotationTarget.category} — ${gesture}, then Apply on the left`
          : `Annotating — set a region set and category on the left, then ${gesture}`
        : 'Subsetting — draw a region, then Subset to selection on the left'}
    </div>
  );
}
