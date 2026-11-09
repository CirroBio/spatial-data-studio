import type { ColorRange } from '@cirrobio/spatial-viewer';
import DualRangeField, { rangeDigits, rangeStep } from './DualRangeField';

interface Props {
  range: ColorRange;
  onChange: (limits: [number, number] | null) => void;
}

/* The range a numeric color-by's ramp spans, picked within the field's own values; null
   returns it to the default. Shared by CanvasControls (Spatial) and EmbeddingControls
   (Embeddings). A field with one value has no range to pick. */
export default function ColorRangeControls({ range, onChange }: Props) {
  const extent: [number, number] = [range.dataMin, range.dataMax];
  if (extent[0] === extent[1]) return null;
  return (
    <div className="flex flex-col gap-1">
      <DualRangeField
        label="Color range" value={[range.min, range.max]} min={extent[0]} max={extent[1]}
        step={rangeStep(extent)} digits={rangeDigits(extent)} onChange={onChange}
      />
      <div className="flex items-center justify-between text-[10px] text-muted">
        <span title="Cells beyond the range take the color at its end.">
          {range.custom ? 'Set by hand' : '1st–99th percentile of non-zero values'}
        </span>
        {range.custom && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="hover:text-accent transition-colors"
            title="Return to the default range"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
