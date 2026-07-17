import ColorBySelect from './ColorBySelect';
import CanvasSettingsShell from './CanvasSettingsShell';
import LegendControls from './LegendControls';
import PointStyleControls from './PointStyleControls';
import type { SpatialDisplaySpec, ObsField } from '../../types';
import { CHANNEL_COLORS } from './colorUtils';
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
  showLegend: boolean;
  setShowLegend: (v: boolean) => void;
  renderMode: 'auto' | 'points';
  setRenderMode: (v: 'auto' | 'points') => void;
  shapeSets: string[];
  shapesElement: string | null;
  setShapesElement: (v: string) => void;
  channels: Channel[];
  setChannel: (index: number, patch: Partial<{ visible: boolean; name: string; color: string }>) => void;
  openColorPicker: number | null;
  setOpenColorPicker: (v: number | null) => void;
  panelCollapsed: boolean;
  setPanelCollapsed: (v: boolean) => void;
  onFit: () => void;
  onEditTransform: () => void;
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
  showLegend,
  setShowLegend,
  renderMode,
  setRenderMode,
  shapeSets,
  shapesElement,
  setShapesElement,
  channels,
  setChannel,
  openColorPicker,
  setOpenColorPicker,
  panelCollapsed,
  setPanelCollapsed,
  onFit,
  onEditTransform,
}: CanvasControlsProps) {
  return (
    <CanvasSettingsShell collapsed={panelCollapsed} onToggleCollapsed={setPanelCollapsed}>
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-muted font-mono uppercase tracking-wide">Layers</label>
        <label className="flex items-center gap-2 text-xs text-text cursor-pointer">
          <input
            type="checkbox"
            checked={showPoints}
            onChange={(e) => setShowPoints(e.target.checked)}
            className="accent-accent"
          />
          Show points
        </label>
        {display.encoding.image_layer && (
          <label className="flex items-center gap-2 text-xs text-text cursor-pointer">
            <input
              type="checkbox"
              checked={showImage}
              onChange={(e) => setShowImage(e.target.checked)}
              className="accent-accent"
            />
            Show image
          </label>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-muted font-mono uppercase tracking-wide">Points</label>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted font-mono uppercase tracking-wide">Render mode</label>
          <select
            value={renderMode}
            onChange={(e) => setRenderMode(e.target.value as 'auto' | 'points')}
            className="bg-bg border border-border rounded px-1 py-0.5 text-xs text-text focus:outline-none focus:border-accent"
            title="Auto draws a nearest-cell field zoomed out and polygons/points zoomed in; Points always draws the classic scatter with the size slider."
          >
            <option value="auto">Auto (field / polygons)</option>
            <option value="points">Points</option>
          </select>
        </div>

        {renderMode === 'auto' && shapeSets.length > 0 && (
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-muted font-mono uppercase tracking-wide">Shape set</label>
            <select
              value={shapesElement ?? ''}
              onChange={(e) => setShapesElement(e.target.value)}
              className="bg-bg border border-border rounded px-1 py-0.5 text-xs text-text focus:outline-none focus:border-accent"
              title="Which polygon element to draw when zoomed in."
            >
              {shapeSets.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted font-mono uppercase tracking-wide">Color by</label>
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

        <PointStyleControls
          pointSize={display.encoding.point_size}
          opacity={display.encoding.opacity}
          onChange={updateEncoding}
        />
      </div>

      {display.encoding.image_layer && showImage && channels.length > 0 && (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted font-mono uppercase tracking-wide">Image</label>
          <label className="flex items-center gap-2 text-xs text-text cursor-pointer">
            <input
              type="checkbox"
              checked={showLegend}
              onChange={(e) => setShowLegend(e.target.checked)}
              className="accent-accent"
            />
            Channel legend
          </label>

          {channels.length > 1 && (
            <div className="flex flex-col gap-1 border border-border/50 rounded p-1.5">
              <span className="text-[10px] text-muted font-mono uppercase tracking-wide">Channels</span>
              {channels.map((c) => (
                <div key={c.index} className="relative flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={c.visible}
                    onChange={(e) => setChannel(c.index, { visible: e.target.checked })}
                    className="accent-accent"
                    title="Toggle channel"
                  />
                  <button
                    type="button"
                    onClick={() => setOpenColorPicker(openColorPicker === c.index ? null : c.index)}
                    className="w-3.5 h-3.5 rounded-sm border border-border shrink-0 hover:ring-1 hover:ring-accent"
                    style={{ background: c.color }}
                    title="Change channel color"
                    aria-label={`Change color for ${c.name}`}
                  />
                  <input
                    type="text"
                    value={c.name}
                    onChange={(e) => setChannel(c.index, { name: e.target.value })}
                    className="flex-1 min-w-0 bg-bg border border-border rounded px-1 py-0.5 text-[10px] text-text focus:outline-none focus:border-accent"
                    title="Rename channel"
                  />
                  {openColorPicker === c.index && (
                    <div className="absolute left-0 top-full z-10 mt-1 grid grid-cols-4 gap-1 p-1.5 bg-surface border border-border rounded shadow-lg">
                      {CHANNEL_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          onClick={() => { setChannel(c.index, { color }); setOpenColorPicker(null); }}
                          className={`w-4 h-4 rounded-sm border transition-transform hover:scale-110 ${
                            color === c.color ? 'border-text' : 'border-border/50'
                          }`}
                          style={{ background: color }}
                          title={color}
                          aria-label={`Set color ${color}`}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1 border-t border-border pt-2">
        <label className="text-[10px] text-muted font-mono uppercase tracking-wide">Actions</label>
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
    </CanvasSettingsShell>
  );
}
