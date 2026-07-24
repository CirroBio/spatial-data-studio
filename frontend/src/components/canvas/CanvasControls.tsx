import { useState, type ReactNode } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import PanelTabs, { type PanelTab } from '../PanelTabs';
import ColorBySelect from './ColorBySelect';
import ColorSwatchPicker from '../ColorSwatchPicker';
import CanvasSettingsShell from './CanvasSettingsShell';
import LegendControls from './LegendControls';
import RangeField from './RangeField';
import DualRangeField from './DualRangeField';
import type { SpatialDisplaySpec, ObsField } from '../../types';
import { CHANNEL_COLORS } from './colorUtils';
import { ZOOM_LIMITS } from './viewFit';
import type { Channel } from './useImageChannels';

interface CanvasControlsProps {
  display: SpatialDisplaySpec;
  sessionId: string;
  obsFields: ObsField[];
  layers: string[];
  colorByName: string;
  legendVisible: boolean;
  updateEncoding: (patch: Partial<SpatialDisplaySpec['encoding']>) => void;
  showPoints: boolean;
  setShowPoints: (v: boolean) => void;
  showImage: boolean;
  setShowImage: (v: boolean) => void;
  invertX: boolean;
  setInvertX: (v: boolean) => void;
  invertY: boolean;
  setInvertY: (v: boolean) => void;
  background: 'light' | 'dark';
  setBackground: (v: 'light' | 'dark') => void;
  showLegend: boolean;
  setShowLegend: (v: boolean) => void;
  renderMode: 'points' | 'points+shapes';
  setRenderMode: (v: 'points' | 'points+shapes') => void;
  shapeSets: string[];
  shapesElement: string | null;
  setShapesElement: (v: string) => void;
  channels: Channel[];
  setChannel: (index: number, patch: Partial<{ visible: boolean; name: string; color: string; contrastLimits: [number, number] }>) => void;
  maxVisibleReached: boolean;
  panelCollapsed: boolean;
  setPanelCollapsed: (v: boolean) => void;
  zoom: number;
  onZoom: (delta: number) => void;
  onFit: () => void;
  onEditTransform: () => void;
}

type DisplayTab = 'layers' | 'cells' | 'image';

function IconToggle({
  active, onClick, title, children,
}: { active: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`w-7 h-7 flex items-center justify-center rounded border transition-colors ${
        active
          ? 'border-accent bg-accent text-white'
          : 'border-border text-muted hover:text-accent hover:border-accent'
      }`}
    >
      {children}
    </button>
  );
}

function IconButton({
  onClick, title, disabled, children,
}: { onClick: () => void; title: string; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className="w-7 h-7 flex items-center justify-center rounded border border-border text-muted transition-colors hover:text-accent hover:border-accent disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted disabled:hover:border-border"
    >
      {children}
    </button>
  );
}

const FIELD_LABEL = 'text-[10px] text-muted font-mono uppercase tracking-wide';
const SELECT_CLASS = 'bg-bg border border-border rounded px-1 py-0.5 text-xs text-text focus:outline-none focus:border-accent';

// Slider granularity for a channel's contrast domain: fine steps for a small
// (e.g. normalized/float) range, unit steps for a wide integer-like one.
function contrastStep(range: [number, number]): number {
  const span = range[1] - range[0];
  return span <= 10 ? span / 100 || 0.01 : 1;
}
function contrastDigits(range: [number, number]): number {
  return range[1] - range[0] <= 10 ? 2 : 0;
}

export default function CanvasControls({
  display,
  sessionId,
  obsFields,
  layers,
  colorByName,
  legendVisible,
  updateEncoding,
  showPoints,
  setShowPoints,
  showImage,
  setShowImage,
  invertX,
  setInvertX,
  invertY,
  setInvertY,
  background,
  setBackground,
  showLegend,
  setShowLegend,
  renderMode,
  setRenderMode,
  shapeSets,
  shapesElement,
  setShapesElement,
  channels,
  setChannel,
  maxVisibleReached,
  panelCollapsed,
  setPanelCollapsed,
  zoom,
  onZoom,
  onFit,
  onEditTransform,
}: CanvasControlsProps) {
  // The shapes overlay needs a polygon element; with none available the Cells layer
  // is Points-only, regardless of any persisted render_mode.
  const mode = shapeSets.length > 0 ? renderMode : 'points';
  const hasImage = !!display.encoding.image_layer;
  const [tab, setTab] = useState<DisplayTab>('layers');
  // Which channel's color/contrast settings are expanded (Image tab). Ephemeral UI.
  const [expandedChannel, setExpandedChannel] = useState<number | null>(null);

  // One-word labels + inline-SVG icons in the left-sidebar style (24×24 viewBox,
  // stroke=currentColor); PanelTabs' collapseInactive shows icon-only until selected.
  const tabs: PanelTab<DisplayTab>[] = [
    {
      id: 'layers',
      label: 'View',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ),
    },
    {
      id: 'cells',
      label: 'Cells',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="9" r="2.5" />
          <circle cx="16.5" cy="7.5" r="2" />
          <circle cx="13" cy="15.5" r="2.5" />
        </svg>
      ),
    },
    ...(hasImage ? [{
      id: 'image' as const,
      label: 'Image',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-4.5-4.5L5 21" />
        </svg>
      ),
    }] : []),
  ];

  return (
    <CanvasSettingsShell collapsed={panelCollapsed} onToggleCollapsed={setPanelCollapsed}>
      <Tabs.Root
        value={tab}
        onValueChange={(v) => setTab(v as DisplayTab)}
        className="flex flex-col min-w-[240px]"
      >
        <PanelTabs tabs={tabs} value={tab} />

        {/* ---- Tab 1: Layers + view (+ actions) ---- */}
        <Tabs.Content value="layers" className="flex flex-col gap-2 pt-2 focus:outline-none">
          <div className="flex flex-col gap-1">
            <label className={FIELD_LABEL}>Layers</label>
            <label className="flex items-center gap-2 text-xs text-text cursor-pointer">
              <input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} className="accent-accent" />
              Show cells
            </label>
            {hasImage && (
              <label className="flex items-center gap-2 text-xs text-text cursor-pointer">
                <input type="checkbox" checked={showImage} onChange={(e) => setShowImage(e.target.checked)} className="accent-accent" />
                Show image
              </label>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className={FIELD_LABEL}>View</label>
            <div className="flex items-center gap-1.5">
              <IconToggle active={invertX} onClick={() => setInvertX(!invertX)} title="Invert horizontal axis">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m3 7 5 5-5 5V7" />
                  <path d="m21 7-5 5 5 5V7" />
                  <path d="M12 2v2" /><path d="M12 8v2" /><path d="M12 14v2" /><path d="M12 20v2" />
                </svg>
              </IconToggle>
              <IconToggle active={invertY} onClick={() => setInvertY(!invertY)} title="Invert vertical axis">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m17 3-5 5-5-5h10" />
                  <path d="m17 21-5-5-5 5h10" />
                  <path d="M2 12h2" /><path d="M8 12h2" /><path d="M14 12h2" /><path d="M20 12h2" />
                </svg>
              </IconToggle>
              <IconToggle
                active={background === 'light'}
                onClick={() => setBackground(background === 'dark' ? 'light' : 'dark')}
                title={`Switch to ${background === 'dark' ? 'light' : 'dark'} background`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor" stroke="none" />
                </svg>
              </IconToggle>
            </div>
            <div className="flex items-center gap-1.5">
              <IconButton onClick={() => onZoom(-1)} title="Zoom out" disabled={zoom <= ZOOM_LIMITS.minZoom}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                  <path d="M8 11h6" />
                </svg>
              </IconButton>
              <span className="min-w-[3rem] text-center text-xs font-mono tabular-nums text-text" title="Zoom level (deck.gl log2 scale)">
                {zoom.toFixed(1)}
              </span>
              <IconButton onClick={() => onZoom(1)} title="Zoom in" disabled={zoom >= ZOOM_LIMITS.maxZoom}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                  <path d="M11 8v6" /><path d="M8 11h6" />
                </svg>
              </IconButton>
            </div>
          </div>

          <div className="flex flex-col gap-1 border-t border-border pt-2">
            <label className={FIELD_LABEL}>Actions</label>
            <button
              type="button"
              onClick={onFit}
              className="py-1 text-[11px] bg-accent text-white rounded hover:bg-accent/90 transition-colors"
            >
              Fit to data
            </button>
            <button
              type="button"
              onClick={onEditTransform}
              className="py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent transition-colors"
            >
              Edit points transform
            </button>
          </div>
        </Tabs.Content>

        {/* ---- Tab 2: Cells ---- */}
        <Tabs.Content value="cells" className="flex flex-col gap-2 pt-2 focus:outline-none">
          {/* Points + Shapes mode is only offered when polygon element(s) exist. */}
          {shapeSets.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className={FIELD_LABEL}>Render mode</label>
              <select
                value={mode}
                onChange={(e) => setRenderMode(e.target.value as 'points' | 'points+shapes')}
                className={SELECT_CLASS}
                title="Points draws the cell scatter at every zoom; Points + Shapes additionally overlays cell-boundary fills once zoomed in far enough."
              >
                <option value="points">Points</option>
                <option value="points+shapes">Points + Shapes (zoomed in)</option>
              </select>
            </div>
          )}

          <RangeField label="Point size" value={display.encoding.point_size} min={0.1} max={20} step={0.1}
            onChange={(v) => updateEncoding({ point_size: v })} />

          <div className="flex flex-col gap-1">
            <label className={FIELD_LABEL}>Geometry</label>
            <select
              value={display.encoding.point_marker ?? 'circle'}
              onChange={(e) => updateEncoding({ point_marker: e.target.value as 'circle' | 'square' | 'hexagon' })}
              className={SELECT_CLASS}
              title="Point glyph shape."
            >
              <option value="circle">Circle</option>
              <option value="square">Square</option>
              <option value="hexagon">Hexagon</option>
            </select>
          </div>

          {mode === 'points+shapes' && (
            <>
              <div className="flex flex-col gap-1">
                <label className={FIELD_LABEL}>Shape set</label>
                <select
                  value={shapesElement ?? ''}
                  onChange={(e) => setShapesElement(e.target.value)}
                  className={SELECT_CLASS}
                  title="Which polygon element to overlay as cell boundaries."
                >
                  {shapeSets.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className={FIELD_LABEL}>Boundary style</label>
                <select
                  value={display.encoding.boundary_style ?? 'filled'}
                  onChange={(e) => updateEncoding({ boundary_style: e.target.value as 'filled' | 'outline' })}
                  className={SELECT_CLASS}
                  title="Filled draws each cell boundary as a solid shape; Outline draws only the boundary line."
                >
                  <option value="filled">Filled</option>
                  <option value="outline">Outline</option>
                </select>
              </div>

              {(display.encoding.boundary_style ?? 'filled') === 'outline' && (
                <RangeField label="Line width" value={display.encoding.boundary_line_width ?? 1} min={0.5} max={8} step={0.5}
                  onChange={(v) => updateEncoding({ boundary_line_width: v })} />
              )}
            </>
          )}

          <div className="flex flex-col gap-1">
            <label className={FIELD_LABEL}>Color by</label>
            <ColorBySelect
              sessionId={sessionId}
              value={display.encoding.color_by}
              obsFields={obsFields}
              layers={layers}
              onChange={(color_by) => updateEncoding({ color_by })}
            />
          </div>

          <LegendControls
            legendVisible={legendVisible}
            legendTitle={display.encoding.legend_title ?? ''}
            colorByName={colorByName}
            onChange={updateEncoding}
          />

          <RangeField label="Opacity" value={display.encoding.opacity} min={0.1} max={1} step={0.05} digits={2}
            onChange={(v) => updateEncoding({ opacity: v })} />
        </Tabs.Content>

        {/* ---- Tab 3: Image ---- */}
        {hasImage && (
          <Tabs.Content value="image" className="flex flex-col gap-2 pt-2 focus:outline-none">
            {!showImage && (
              <p className="text-[10px] text-muted/60 leading-snug">The image is hidden — enable “Show image” on the Layers + view tab.</p>
            )}
            {channels.length > 0 ? (
              <>
                <label className="flex items-center gap-2 text-xs text-text cursor-pointer">
                  <input type="checkbox" checked={showLegend} onChange={(e) => setShowLegend(e.target.checked)} className="accent-accent" />
                  Channel legend
                </label>

                <div className="flex flex-col gap-1.5">
                  <span className={FIELD_LABEL}>Channels</span>
                  <span className="text-[10px] text-muted/60 leading-snug">Expand a channel (▸) to set its color and contrast min/max.</span>
                  {/* Viv composites at most 6 channels at once; once 6 are on, unchecked
                      channels are disabled until the user hides one. */}
                  {maxVisibleReached && (
                    <span className="text-[10px] text-muted">Showing the maximum of 6 channels — hide one to add another.</span>
                  )}
                  {channels.map((c) => (
                    <div key={c.index} className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={c.visible}
                          disabled={maxVisibleReached && !c.visible}
                          onChange={(e) => setChannel(c.index, { visible: e.target.checked })}
                          className="accent-accent disabled:opacity-40 disabled:cursor-not-allowed"
                          title={maxVisibleReached && !c.visible ? 'Maximum of 6 channels shown' : 'Toggle channel'}
                        />
                        <button
                          type="button"
                          onClick={() => setExpandedChannel(expandedChannel === c.index ? null : c.index)}
                          className="w-3.5 h-3.5 rounded-sm border border-border shrink-0 hover:ring-1 hover:ring-accent"
                          style={{ background: c.color }}
                          title="Channel color & contrast"
                          aria-label={`Color and contrast for ${c.name}`}
                        />
                        <input
                          type="text"
                          value={c.name}
                          onChange={(e) => setChannel(c.index, { name: e.target.value })}
                          className="flex-1 min-w-0 bg-bg border border-border rounded px-1 py-0.5 text-[10px] text-text focus:outline-none focus:border-accent"
                          title="Rename channel"
                        />
                        <button
                          type="button"
                          onClick={() => setExpandedChannel(expandedChannel === c.index ? null : c.index)}
                          className="shrink-0 text-muted hover:text-accent transition-colors"
                          title="Color & contrast"
                          aria-expanded={expandedChannel === c.index}
                          aria-label={`Color and contrast for ${c.name}`}
                        >
                          <svg
                            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                            style={{ transform: expandedChannel === c.index ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
                          >
                            <path d="m9 18 6-6-6-6" />
                          </svg>
                        </button>
                      </div>
                      {expandedChannel === c.index && (
                        <div className="flex flex-col gap-1.5 pl-5 pb-1.5">
                          <span className="text-[10px] text-muted">Color</span>
                          <div className="flex items-center gap-2">
                            <input
                              type="color"
                              value={c.color}
                              onChange={(e) => setChannel(c.index, { color: e.target.value })}
                              className="w-7 h-6 rounded border border-border bg-bg cursor-pointer"
                              title="Pick any color"
                            />
                            <ColorSwatchPicker colors={CHANNEL_COLORS} selected={c.color} onSelect={(color) => setChannel(c.index, { color })} />
                          </div>
                          <DualRangeField
                            label="Contrast" value={c.contrastLimits} min={c.contrastRange[0]} max={c.contrastRange[1]}
                            step={contrastStep(c.contrastRange)} digits={contrastDigits(c.contrastRange)}
                            onChange={(v) => setChannel(c.index, { contrastLimits: v })}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-[10px] text-muted/60 leading-snug">This image has no adjustable channels.</p>
            )}
          </Tabs.Content>
        )}
      </Tabs.Root>
    </CanvasSettingsShell>
  );
}
