// A matrix of values on a diverging scale centered on zero (z-scores), rows and columns
// named: neighborhood enrichment between groups, or a niche's mix of cell types.
import { useId } from 'react';
import { scaleLinear } from 'd3-scale';

// Enrichment z-scores are heavy-tailed: one tight group's enrichment with itself can be
// twenty times the next, and a scale up to it leaves every other cell white. The scale
// saturates here instead, and the key says so.
const SATURATE_AT = 0.95;
const KEY_WIDTH = 160;
const KEY_HEIGHT = 8;
// The least room a label needs: rows grow to it, and column labels too close for it are
// thinned to every second, third, ... one.
const LABEL_PX = 12;

const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));

function quantile(sorted: number[], q: number): number {
  return sorted[Math.floor(q * (sorted.length - 1))] ?? 0;
}

export function Heatmap({ rows, columns, values, width, label, diverging = true }: {
  rows: string[]; columns: string[]; values: ArrayLike<number>; width: number; label: string; diverging?: boolean;
}) {
  const gradient = useId();
  const labelW = Math.min(110, width * 0.3);
  const cell = Math.max(6, Math.min(26, (width - labelW - 8) / Math.max(columns.length, 1)));
  const rowH = Math.max(cell, LABEL_PX);
  const labelEvery = Math.ceil(LABEL_PX / cell);
  const top = Math.min(90, 6 + Math.max(...columns.map((c) => c.length), 1) * 5.5);
  const keyY = top + rows.length * rowH + 12;
  const height = keyY + KEY_HEIGHT + 16;
  const finite = Array.from(values).filter(Number.isFinite);
  const magnitudes = finite.map(Math.abs).sort((a, b) => a - b);
  const extent = Math.max(1e-9, quantile(magnitudes, SATURATE_AT));
  const clipped = (magnitudes[magnitudes.length - 1] ?? 0) > extent;
  const max = Math.max(1e-9, ...finite);
  const fill = (v: number) => {
    if (!Number.isFinite(v)) return 'var(--sds-color-surface)';
    if (!diverging) return `color-mix(in srgb, var(--sds-seq-50) ${Math.round(100 * (v / max))}%, var(--sds-color-surface-raised))`;
    const t = scaleLinear().domain([-extent, 0, extent]).range([-100, 0, 100]).clamp(true)(v);
    return t >= 0
      ? `color-mix(in srgb, var(--sds-div-pos) ${Math.round(t)}%, var(--sds-div-mid))`
      : `color-mix(in srgb, var(--sds-div-neg) ${Math.round(-t)}%, var(--sds-div-mid))`;
  };
  const stops = diverging
    ? ['var(--sds-div-neg)', 'var(--sds-div-mid)', 'var(--sds-div-pos)']
    : ['var(--sds-color-surface-raised)', 'var(--sds-seq-50)'];
  const ends = diverging
    ? [`${clipped ? '≤ ' : ''}${fmt(-extent)}`, `${clipped ? '≥ ' : ''}${fmt(extent)}`]
    : ['0', fmt(max)];
  return (
    <svg width={width} height={height} className="chart" role="img" aria-label={label}>
      <defs>
        <linearGradient id={gradient}>
          {stops.map((color, i) => <stop key={color} offset={i / (stops.length - 1)} stopColor={color} />)}
        </linearGradient>
      </defs>
      {columns.map((c, j) => j % labelEvery === 0 && (
        <text key={c} transform={`translate(${labelW + j * cell + cell / 2},${top - 4}) rotate(-60)`} className="chart-tick">{c.length > 16 ? `${c.slice(0, 15)}…` : c}</text>
      ))}
      {rows.map((r, i) => (
        <g key={r}>
          <text x={labelW - 4} y={top + i * rowH + rowH * 0.68} textAnchor="end" className="chart-tick">{r.length > 18 ? `${r.slice(0, 17)}…` : r}</text>
          {columns.map((c, j) => {
            const v = values[i * columns.length + j];
            return (
              <rect key={c} x={labelW + j * cell} y={top + i * rowH} width={cell - 1} height={rowH - 1} fill={fill(v)}>
                <title>{`${r} · ${c}: ${Number.isFinite(v) ? v.toFixed(2) : 'no value'}`}</title>
              </rect>
            );
          })}
        </g>
      ))}
      <g transform={`translate(${labelW},${keyY})`}>
        <rect width={KEY_WIDTH} height={KEY_HEIGHT} fill={`url(#${gradient})`} />
        <text y={KEY_HEIGHT + 11} className="chart-tick">{ends[0]}</text>
        {diverging && <text x={KEY_WIDTH / 2} y={KEY_HEIGHT + 11} textAnchor="middle" className="chart-tick">0</text>}
        <text x={KEY_WIDTH} y={KEY_HEIGHT + 11} textAnchor="end" className="chart-tick">{ends[1]}</text>
      </g>
    </svg>
  );
}
