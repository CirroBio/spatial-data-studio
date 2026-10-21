// The share of the variance each principal component explains, in order (scanpy's
// pca_variance_ratio): where the bars level off, later components add little structure.
import { scaleLinear } from 'd3-scale';

const M = { top: 10, right: 8, bottom: 34, left: 44 };
// Space between bars, when they are wide enough to spare it.
const GAP = 2;
// The least room a component number needs on the axis.
const TICK_PX = 18;

const percent = (v: number) => `${+(100 * v).toFixed(1)}%`;

export function Scree({ ratios, width, height, label }: { ratios: ArrayLike<number>; width: number; height: number; label: string }) {
  const values = Array.from(ratios);
  const sy = scaleLinear().domain([0, Math.max(1e-9, ...values)]).range([height - M.bottom, M.top]).nice();
  const step = (width - M.left - M.right) / Math.max(values.length, 1);
  const bar = Math.max(1, step > 2 * GAP ? step - GAP : step);
  const every = [1, 2, 5, 10, 20, 50].find((k) => k * step >= TICK_PX) ?? 100;
  let total = 0;
  const cumulative = values.map((v) => (total += v));
  const base = sy(0);
  return (
    <svg width={width} height={height} className="chart" role="img" aria-label={label}>
      {sy.ticks(4).map((t) => (
        <g key={t}>
          <line x1={M.left - 4} x2={M.left} y1={sy(t)} y2={sy(t)} className="chart-axis" />
          <text x={M.left - 7} y={sy(t) + 3} textAnchor="end" className="chart-tick">{percent(t)}</text>
        </g>
      ))}
      {values.map((v, i) => {
        const x = M.left + i * step;
        return (
          <g key={i} className="scree-bar">
            <title>{`PC${i + 1}: ${percent(v)} of the variance; PC1–${i + 1} together, ${percent(cumulative[i])}`}</title>
            <rect x={x} y={M.top} width={step} height={base - M.top} className="bar-hit" />
            <rect x={x + (step - bar) / 2} y={sy(v)} width={bar} height={Math.max(0, base - sy(v))} rx={Math.min(2, bar / 2)} fill="var(--sds-color-accent)" />
            {((i + 1) % every === 0 || (i === 0 && every > 2)) && (
              <text x={x + step / 2} y={base + 15} textAnchor="middle" className="chart-tick">{i + 1}</text>
            )}
          </g>
        );
      })}
      <line x1={M.left} x2={width - M.right} y1={base} y2={base} className="chart-axis" />
      <line x1={M.left} x2={M.left} y1={M.top} y2={base} className="chart-axis" />
      <text x={(M.left + width - M.right) / 2} y={height - 4} textAnchor="middle" className="chart-title">Principal component</text>
      <text transform={`translate(11,${(M.top + base) / 2}) rotate(-90)`} textAnchor="middle" className="chart-title">Variance explained</text>
    </svg>
  );
}
