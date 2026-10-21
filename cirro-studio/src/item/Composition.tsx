// How the cells divide among the groups of the color field: one bar per group, largest
// first, drawn across the view.
import { useRef } from 'react';
import { colorByLabel } from '@cirrobio/spatial-viewer';
import { formatCount } from '../app/ui';
import { useSize } from '../lib/useSize';
import { useColorKey } from './useColorField';

const MAX_BARS = 24;
const PAD = 24;
// Room after each bar for its count and share.
const VALUE_W = 96;
const MAX_CHART_W = 720;

export function Composition({ field, version, overrides }: { field: string | null; version: number; overrides?: Record<string, string> }) {
  const { key, loading, error } = useColorKey(field, version, overrides);
  const ref = useRef<HTMLDivElement>(null);
  const { width, height } = useSize(ref);
  // The measured box is always mounted: useSize measures what is there when it first runs.
  const note = !field ? 'Choose a group to color by, and its composition shows here.'
    : error ? `“${colorByLabel(field)}” couldn't be read: ${error}`
    : !key && loading ? 'Reading…'
    : key?.kind === 'too-many-categories' ? `“${colorByLabel(field)}” has ${formatCount(key.count)} groups, too many to color (limit ${key.limit}).`
    // A numeric field with no values at all has no key either.
    : key?.kind !== 'categorical' ? `“${colorByLabel(field)}” holds values, not groups. Color by a group to see its composition.`
    : null;
  if (note !== null || key?.kind !== 'categorical') {
    return <div className="composition" ref={ref}><p className="lens-empty muted">{note}</p></div>;
  }
  const items = [...key.items].sort((a, b) => b.count - a.count).slice(0, MAX_BARS);
  const total = key.items.reduce((s, i) => s + i.count, 0) || 1;
  const chartW = Math.min(MAX_CHART_W, width - 2 * PAD);
  const barH = Math.min(22, (height - 2 * PAD) / Math.max(items.length, 1));
  const max = items[0]?.count || 1;
  const labelW = Math.min(160, chartW * 0.3);
  return (
    <div className="composition" ref={ref}>
      {chartW > 0 && barH > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Cells per ${colorByLabel(field)} group`}>
          <g transform={`translate(${(width - chartW) / 2},${PAD})`}>
            {items.map((it, i) => {
              const w = (Math.max(0, chartW - labelW - VALUE_W) * it.count) / max;
              return (
                <g key={it.label} transform={`translate(0,${i * barH})`}>
                  <text x={labelW - 6} y={barH * 0.68} textAnchor="end" className="chart-label">{it.label}</text>
                  <rect x={labelW} y={barH * 0.15} width={Math.max(1, w)} height={barH * 0.7} rx={2} fill={it.color} />
                  <text x={labelW + w + 4} y={barH * 0.68} className="chart-value">{formatCount(it.count)} · {((100 * it.count) / total).toFixed(1)}%</text>
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}
