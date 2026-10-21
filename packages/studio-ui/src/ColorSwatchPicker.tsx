interface Props {
  colors: string[];
  selected: string;
  onSelect: (color: string) => void;
  // Fixed number of swatches per row (grid layout). Omit for a free-wrapping row.
  columns?: number;
}

// Row of preset color swatches shown alongside a native <input type="color">
// picker — shared by the shape-annotation stroke/fill palettes (AnnotationsPanel)
// and the new-category palette (RegionsPanel).
export default function ColorSwatchPicker({ colors, selected, onSelect, columns }: Props) {
  return (
    <div
      className={columns ? 'grid gap-1 w-max' : 'flex gap-1 flex-wrap'}
      style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
    >
      {colors.map((c) => (
        <button
          key={c}
          onClick={() => onSelect(c)}
          className="w-4 h-4 rounded-sm border transition-all"
          style={{
            background: c,
            borderColor: selected === c ? 'white' : 'transparent',
            outline: selected === c ? `1px solid ${c}` : 'none',
          }}
          aria-label={`Color ${c}`}
        />
      ))}
    </div>
  );
}
