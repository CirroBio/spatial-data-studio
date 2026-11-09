// One bar per group of a column, each split into the shares of another column's groups
// (100% stacked), with the overall mix as the first bar and a key of the split's colors
// beneath: how a grouping is made up across another.
import { formatCount } from '../app/ui';

const ROW = 22;
// The room after the overall bar, setting it apart from the groups'.
const OVERALL_GAP = 8;
const VALUE_W = 72;
const KEY_ROW = 16;
const KEY_SWATCH = 10;

/** `counts` is row-major, rows × segments. `overall` (the segments' totals) is drawn
 * first when given. */
export function StackedBars({ rows, segments, colors, counts, overall, width, label, unit }: {
  rows: string[]; segments: string[]; colors: string[]; counts: ArrayLike<number>; overall?: string;
  width: number; label: string; unit: string;
}) {
  const nS = segments.length;
  const bars = rows.map((name, i) => ({ name, values: Array.from({ length: nS }, (_, j) => counts[i * nS + j]) }));
  if (overall) bars.unshift({ name: overall, values: segments.map((_, j) => bars.reduce((s, b) => s + b.values[j], 0)) });
  const labelW = Math.min(150, Math.max(60, ...bars.map((b) => b.name.length * 6.4 + 8)));
  const span = Math.max(1, width - labelW - VALUE_W);
  const top = (i: number) => i * ROW + (overall && i > 0 ? OVERALL_GAP : 0);
  const barsH = top(bars.length);
  // The key flows into as many columns as its longest label leaves room for.
  const keyW = Math.min(180, Math.max(...segments.map((s) => s.length * 6.4 + KEY_SWATCH + 14), 40));
  const perRow = Math.max(1, Math.floor((width - labelW) / keyW));
  const keyY = barsH + 12;
  const height = keyY + Math.ceil(nS / perRow) * KEY_ROW;
  return (
    <svg className="chart" width={width} height={height} role="img" aria-label={label}>
      {bars.map((b, i) => {
        const total = b.values.reduce((a, v) => a + v, 0);
        let x = labelW;
        return (
          <g key={`${i}:${b.name}`} transform={`translate(0,${top(i)})`}>
            <text x={labelW - 6} y={ROW * 0.66} textAnchor="end" className={overall && i === 0 ? 'chart-label chart-label-on' : 'chart-label'}>
              {b.name.length > 22 ? `${b.name.slice(0, 21)}…` : b.name}
            </text>
            {b.values.map((v, j) => {
              const w = total ? (span * v) / total : 0;
              const at = x;
              x += w;
              return v > 0 && (
                <rect key={segments[j]} x={at} y={ROW * 0.15} width={w} height={ROW * 0.7} fill={colors[j]}>
                  <title>{`${b.name} · ${segments[j]}: ${formatCount(v)} ${v === 1 ? unit : `${unit}s`} (${((100 * v) / total).toFixed(1)}%)`}</title>
                </rect>
              );
            })}
            <text x={labelW + span + 6} y={ROW * 0.66} className="chart-value">{formatCount(total)}</text>
          </g>
        );
      })}
      {segments.map((s, j) => (
        <g key={s} transform={`translate(${labelW + (j % perRow) * keyW},${keyY + Math.floor(j / perRow) * KEY_ROW})`}>
          <rect width={KEY_SWATCH} height={KEY_SWATCH} rx={2} fill={colors[j]} />
          <text x={KEY_SWATCH + 4} y={KEY_SWATCH - 1} className="chart-tick">{s.length > 24 ? `${s.slice(0, 23)}…` : s}</text>
        </g>
      ))}
    </svg>
  );
}
