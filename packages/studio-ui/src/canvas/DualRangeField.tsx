import * as Slider from '@radix-ui/react-slider';

interface Props {
  label: string;
  value: [number, number];
  min: number;
  max: number;
  step: number;
  digits?: number;  // fixed decimals shown next to the label (default 1)
  onChange: (value: [number, number]) => void;
}

/** Labelled two-thumb range slider — the min/max variant of RangeField. Radix keeps
 * the value array sorted, so the low thumb can never pass the high one (min <= max is
 * guaranteed without any clamping in the caller). */
export default function DualRangeField({ label, value, min, max, step, digits = 1, onChange }: Props) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] text-muted font-mono uppercase tracking-wide">
        {label}: {value[0].toFixed(digits)} – {value[1].toFixed(digits)}
      </label>
      <Slider.Root
        className="relative flex items-center w-full h-4 select-none touch-none"
        min={min}
        max={max}
        step={step}
        value={value}
        onValueChange={(v) => onChange([v[0], v[1]])}
      >
        <Slider.Track className="relative grow h-1 rounded-full bg-border">
          <Slider.Range className="absolute h-full rounded-full bg-accent" />
        </Slider.Track>
        <Slider.Thumb
          aria-label={`${label} minimum`}
          className="block w-3 h-3 rounded-full bg-accent border border-surface shadow focus:outline-none focus:ring-2 focus:ring-accent/60"
        />
        <Slider.Thumb
          aria-label={`${label} maximum`}
          className="block w-3 h-3 rounded-full bg-accent border border-surface shadow focus:outline-none focus:ring-2 focus:ring-accent/60"
        />
      </Slider.Root>
    </div>
  );
}
