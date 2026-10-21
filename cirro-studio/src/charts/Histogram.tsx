// How a set of values spreads: counts in equal bins along the axis, the values at or past
// a threshold in the accent color and the threshold dashed. Moran's I across every gene.
import { scaleLinear } from 'd3-scale';

const BINS = 30;

export function Histogram({ values, threshold, width, height, label, axis, unit }: {
  values: ArrayLike<number>; threshold?: number; width: number; height: number; label: string;
  // What the axis measures, and what one count is.
  axis: string; unit: [string, string];
}) {
  const m = { top: 10, right: 12, bottom: 34, left: 40 };
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) continue;
    lo = Math.min(lo, values[i]);
    hi = Math.max(hi, values[i]);
  }
  const sx = scaleLinear().domain(lo <= hi ? [lo, hi] : [0, 1]).range([m.left, width - m.right]).nice();
  const [d0, d1] = sx.domain();
  const step = (d1 - d0) / BINS || 1;
  const below = new Array<number>(BINS).fill(0);
  const above = new Array<number>(BINS).fill(0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const b = Math.min(BINS - 1, Math.floor((v - d0) / step));
    if (threshold !== undefined && v >= threshold) above[b] += 1;
    else below[b] += 1;
  }
  const sy = scaleLinear().domain([0, Math.max(1, ...below.map((n, b) => n + above[b]))]).range([height - m.bottom, m.top]).nice();
  const barW = Math.max(1, sx(d0 + step) - sx(d0) - 1);
  return (
    <svg width={width} height={height} className="chart" role="img" aria-label={label}>
      {sx.ticks(5).map((t) => (
        <g key={`x${t}`}>
          <line x1={sx(t)} x2={sx(t)} y1={height - m.bottom} y2={height - m.bottom + 4} className="chart-axis" />
          <text x={sx(t)} y={height - m.bottom + 15} textAnchor="middle" className="chart-tick">{t}</text>
        </g>
      ))}
      {sy.ticks(4).map((t) => (
        <g key={`y${t}`}>
          <line x1={m.left - 4} x2={m.left} y1={sy(t)} y2={sy(t)} className="chart-axis" />
          <text x={m.left - 7} y={sy(t) + 3} textAnchor="end" className="chart-tick">{t}</text>
        </g>
      ))}
      {below.map((n, b) => {
        const x = sx(d0 + b * step);
        const from = (d0 + b * step).toPrecision(2);
        const to = (d0 + (b + 1) * step).toPrecision(2);
        return (
          <g key={b}>
            <title>{`${n + above[b]} ${n + above[b] === 1 ? unit[0] : unit[1]} from ${from} to ${to}`}</title>
            <rect x={x} y={sy(n)} width={barW} height={sy(0) - sy(n)} fill="var(--sds-color-text-muted)" fillOpacity={0.45} />
            <rect x={x} y={sy(n + above[b])} width={barW} height={sy(n) - sy(n + above[b])} fill="var(--sds-color-accent)" />
          </g>
        );
      })}
      <line x1={m.left} x2={width - m.right} y1={height - m.bottom} y2={height - m.bottom} className="chart-axis" />
      <line x1={m.left} x2={m.left} y1={m.top} y2={height - m.bottom} className="chart-axis" />
      {threshold !== undefined && <line x1={sx(threshold)} x2={sx(threshold)} y1={m.top} y2={height - m.bottom} className="chart-guide" />}
      <text x={(m.left + width - m.right) / 2} y={height - 4} textAnchor="middle" className="chart-title">{axis}</text>
      <text transform={`translate(11,${(m.top + height - m.bottom) / 2}) rotate(-90)`} textAnchor="middle" className="chart-title">{unit[1]}</text>
    </svg>
  );
}
