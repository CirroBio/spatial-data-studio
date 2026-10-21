interface Props {
  legendVisible: boolean;
  legendTitle: string;
  colorByName: string;
  onChange: (patch: { legend_visible?: boolean; legend_title?: string }) => void;
}

/* Color-legend visibility + title override. Shared by CanvasControls (Spatial)
   and EmbeddingControls (Embeddings). */
export default function LegendControls({ legendVisible, legendTitle, colorByName, onChange }: Props) {
  return (
    <>
      <label className="flex items-center gap-2 text-xs text-text cursor-pointer">
        <input
          type="checkbox"
          checked={legendVisible}
          onChange={(e) => onChange({ legend_visible: e.target.checked })}
          className="accent-accent"
        />
        Color legend
      </label>

      {legendVisible && (
        <input
          type="text"
          value={legendTitle}
          onChange={(e) => onChange({ legend_title: e.target.value })}
          placeholder={colorByName}
          className="bg-bg border border-border rounded px-2 py-1 text-xs text-text placeholder:text-muted/40 focus:outline-none focus:border-accent"
          title="Legend title"
        />
      )}
    </>
  );
}
