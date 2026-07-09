import ColorBySelect from './ColorBySelect';
import CanvasSettingsShell from './CanvasSettingsShell';
import LegendControls from './LegendControls';
import PointStyleControls from './PointStyleControls';
import type { EmbeddingDisplaySpec, ObsField, ObsmField } from '../../types';

interface Props {
  display: EmbeddingDisplaySpec;
  sessionId: string;
  obsFields: ObsField[];
  layers: string[];
  obsmFields: ObsmField[];
  colorByName: string;
  legendVisible: boolean;
  updateEncoding: (patch: Partial<EmbeddingDisplaySpec['encoding']>) => void;
  panelCollapsed: boolean;
  setPanelCollapsed: (v: boolean) => void;
  onFit: () => void;
  onSnapshot: () => void;
}

// One row of the X/Y/Z axis pickers: which component of the selected obsm array
// to plot on that axis.
function AxisComponentSelect({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted font-mono w-3">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 bg-bg border border-border rounded px-1.5 py-1 text-xs text-text focus:outline-none focus:border-accent"
      >
        {Array.from({ length: max }, (_, i) => (
          <option key={i} value={i}>{i}</option>
        ))}
      </select>
    </div>
  );
}

export default function EmbeddingControls({
  display,
  sessionId,
  obsFields,
  layers,
  obsmFields,
  colorByName,
  legendVisible,
  updateEncoding,
  panelCollapsed,
  setPanelCollapsed,
  onFit,
  onSnapshot,
}: Props) {
  const { obsm_key, x_component, y_component, z_component, is_3d } = display.encoding;
  const nComponents = obsmFields.find((f) => f.name === obsm_key)?.n_components ?? 2;
  const can3d = nComponents >= 3;

  // Switching the obsm slot resets the axis picks to sane defaults for its shape,
  // and drops out of 3D if the new slot doesn't have a third component.
  function changeObsmKey(key: string) {
    const n = obsmFields.find((f) => f.name === key)?.n_components ?? 2;
    updateEncoding({
      obsm_key: key,
      x_component: 0,
      y_component: Math.min(1, n - 1),
      z_component: Math.min(2, n - 1),
      is_3d: is_3d && n >= 3,
    });
  }

  return (
    <CanvasSettingsShell collapsed={panelCollapsed} onToggleCollapsed={setPanelCollapsed}>
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-muted font-mono uppercase tracking-wide">Embedding</label>
        <select
          value={obsm_key}
          onChange={(e) => changeObsmKey(e.target.value)}
          className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:border-accent"
        >
          {obsmFields.map((f) => (
            <option key={f.name} value={f.name}>{f.name}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <AxisComponentSelect label="X" value={x_component} max={nComponents} onChange={(v) => updateEncoding({ x_component: v })} />
        <AxisComponentSelect label="Y" value={y_component} max={nComponents} onChange={(v) => updateEncoding({ y_component: v })} />
        {is_3d && (
          <AxisComponentSelect label="Z" value={z_component} max={nComponents} onChange={(v) => updateEncoding({ z_component: v })} />
        )}
      </div>

      {can3d && (
        <label className="flex items-center gap-2 text-xs text-text cursor-pointer">
          <input
            type="checkbox"
            checked={is_3d}
            onChange={(e) => updateEncoding({ is_3d: e.target.checked })}
            className="accent-accent"
          />
          3D
        </label>
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

      <button
        type="button"
        onClick={onFit}
        className="py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent transition-colors"
      >
        Fit to data
      </button>

      <button
        type="button"
        onClick={onSnapshot}
        className="py-1 text-[11px] rounded text-muted hover:text-text transition-colors"
      >
        Save snapshot
      </button>
    </CanvasSettingsShell>
  );
}
