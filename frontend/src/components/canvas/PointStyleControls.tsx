interface Props {
  pointSize: number;
  opacity: number;
  onChange: (patch: { point_size?: number; opacity?: number }) => void;
}

/* Point size + opacity sliders. Shared by CanvasControls (Spatial) and
   EmbeddingControls (Embeddings). */
export default function PointStyleControls({ pointSize, opacity, onChange }: Props) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-muted font-mono uppercase tracking-wide">
          Point size: {pointSize.toFixed(1)}
        </label>
        <input
          type="range"
          min={0.1}
          max={20}
          step={0.1}
          value={pointSize}
          onChange={(e) => onChange({ point_size: Number(e.target.value) })}
          className="w-full accent-accent"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-muted font-mono uppercase tracking-wide">
          Opacity: {opacity.toFixed(2)}
        </label>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(e) => onChange({ opacity: Number(e.target.value) })}
          className="w-full accent-accent"
        />
      </div>
    </>
  );
}
