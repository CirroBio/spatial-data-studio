// Labelled horizontal bars, one per item, longest first if they come that way: group
// sizes, markers per group, the genes a test ranks highest. A click on a row picks it.
export interface Bar {
  label: string;
  value: number;
  // What the bar's end says, if not the value itself.
  note?: string;
  color?: string;
}

const ROW = 18;
const VALUE_W = 92;

export function BarList({ bars, width, label, onPick, picked }: {
  bars: Bar[]; width: number; label: string; onPick?: (bar: Bar) => void; picked?: string | null;
}) {
  const labelW = Math.min(150, Math.max(60, ...bars.map((b) => b.label.length * 6.4 + 8)));
  const span = Math.max(1, width - labelW - VALUE_W);
  const max = Math.max(...bars.map((b) => b.value), 1e-12);
  return (
    <svg className="bar-list" width={width} height={bars.length * ROW + 2} role="img" aria-label={label}>
      {bars.map((b, i) => {
        const w = Math.max(1, (span * Math.max(0, b.value)) / max);
        const on = picked === b.label;
        return (
          <g key={b.label} transform={`translate(0,${i * ROW})`} className={onPick ? 'bar-row bar-row-pick' : 'bar-row'}
            onClick={onPick && (() => onPick(b))} aria-selected={on || undefined}>
            <rect x={0} y={0} width={width} height={ROW} className="bar-hit" />
            <text x={labelW - 6} y={ROW * 0.68} textAnchor="end" className={on ? 'chart-label chart-label-on' : 'chart-label'}>{b.label}</text>
            <rect x={labelW} y={ROW * 0.2} width={w} height={ROW * 0.6} rx={2} fill={b.color ?? 'var(--sds-color-accent)'} />
            <text x={labelW + w + 4} y={ROW * 0.68} className="chart-value">{b.note ?? b.value}</text>
          </g>
        );
      })}
    </svg>
  );
}
