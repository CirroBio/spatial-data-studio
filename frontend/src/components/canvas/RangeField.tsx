interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits?: number;  // fixed decimals shown next to the label (default 1)
  onChange: (value: number) => void;
}

/** Labelled range slider with the current value shown inline. The single control
 * behind the point-size, opacity, and any other numeric display settings. */
export default function RangeField({ label, value, min, max, step, digits = 1, onChange }: Props) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] text-muted font-mono uppercase tracking-wide">
        {label}: {value.toFixed(digits)}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-accent"
      />
    </div>
  );
}
