// Differential expression as a volcano: log2 fold change across, −log10 adjusted p up,
// genes past both thresholds colored by direction, the strongest named. A gene clicks
// through to the tissue colored by it.
import { scaleLinear } from 'd3-scale';

export interface VolcanoPoint { gene: string; logfc: number; padj: number; score: number }

// A gene is called changed below adjusted p `padj` at |log2 fold change| `logfc` or more;
// the volcano draws both as dashed lines and names the `labels` strongest such genes.
export interface VolcanoCutoffs { padj: number; logfc: number; labels: number }

// The app's cutoffs. A saved volcano figure records the ones it was drawn with.
export const SIGNIFICANCE: VolcanoCutoffs = { padj: 0.05, logfc: 1, labels: 10 };

// Width of one character of a point label (the 10px chart font), for keeping names apart.
const LABEL_CHAR = 5.8;
// The smallest adjusted p plotted, so p = 0 (underflow) still has a place on the plot.
const P_FLOOR = 1e-300;

export function Volcano({ points, cutoffs, width, height, onPick, picked }: {
  points: VolcanoPoint[]; cutoffs: VolcanoCutoffs; width: number; height: number; onPick?: (gene: string) => void; picked?: string | null;
}) {
  const m = { top: 20, right: 12, bottom: 34, left: 42 };
  const y = (p: VolcanoPoint) => -Math.log10(Math.max(p.padj, P_FLOOR));
  // The axis spans the bulk of the genes: a gene one side doesn't express at all has a
  // fold change in the tens, and is pinned to the edge rather than squashing the rest.
  const spread = points.map((p) => Math.abs(p.logfc)).filter(Number.isFinite).sort((a, b) => a - b);
  const maxX = Math.max(1.5, Math.min(spread[spread.length - 1] ?? 0, 1.25 * (spread[Math.floor(spread.length * 0.98)] ?? 0)));
  const clampX = (v: number) => Math.max(-maxX, Math.min(maxX, v));
  const maxY = Math.max(2, ...points.map(y));
  const sx = scaleLinear().domain([-maxX, maxX]).range([m.left, width - m.right]).nice();
  const sy = scaleLinear().domain([0, maxY]).range([height - m.bottom, m.top]).nice();
  const up = (p: VolcanoPoint) => p.padj < cutoffs.padj && p.logfc >= cutoffs.logfc;
  const down = (p: VolcanoPoint) => p.padj < cutoffs.padj && p.logfc <= -cutoffs.logfc;
  // The strongest genes are named first, on the side away from the center unless that runs
  // off the plot; a name that would land on one already placed is left to its tooltip.
  const labels: { p: VolcanoPoint; x: number; y: number; start: boolean; box: [number, number, number, number] }[] = [];
  for (const p of points.filter((q) => up(q) || down(q)).sort((a, b) => Math.abs(b.score) - Math.abs(a.score))) {
    if (labels.length === cutoffs.labels) break;
    const cx = sx(clampX(p.logfc));
    const cy = sy(y(p));
    const w = p.gene.length * LABEL_CHAR;
    const start = p.logfc >= 0 ? cx + 4 + w <= width - m.right : cx - 4 - w < m.left;
    const x = start ? cx + 4 : cx - 4;
    const box: [number, number, number, number] = [start ? x : x - w, cy - 14, start ? x + w : x, cy - 2];
    if (labels.some(({ box: b }) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) continue;
    labels.push({ p, x, y: cy - 4, start, box });
  }
  const color = (p: VolcanoPoint) => (up(p) ? 'var(--sds-div-pos)' : down(p) ? 'var(--sds-div-neg)' : 'var(--sds-color-text-muted)');
  return (
    <svg width={width} height={height} className="chart" role="img" aria-label="Volcano plot">
      {sx.ticks(6).map((t) => (
        <g key={`x${t}`}>
          <line x1={sx(t)} x2={sx(t)} y1={height - m.bottom} y2={height - m.bottom + 4} className="chart-axis" />
          <text x={sx(t)} y={height - m.bottom + 15} textAnchor="middle" className="chart-tick">{t}</text>
        </g>
      ))}
      {sy.ticks(5).map((t) => (
        <g key={`y${t}`}>
          <line x1={m.left - 4} x2={m.left} y1={sy(t)} y2={sy(t)} className="chart-axis" />
          <text x={m.left - 7} y={sy(t) + 3} textAnchor="end" className="chart-tick">{t}</text>
        </g>
      ))}
      <line x1={m.left} x2={width - m.right} y1={height - m.bottom} y2={height - m.bottom} className="chart-axis" />
      <line x1={m.left} x2={m.left} y1={m.top} y2={height - m.bottom} className="chart-axis" />
      <line x1={m.left} x2={width - m.right} y1={sy(-Math.log10(cutoffs.padj))} y2={sy(-Math.log10(cutoffs.padj))} className="chart-guide" />
      <line x1={sx(cutoffs.logfc)} x2={sx(cutoffs.logfc)} y1={m.top} y2={height - m.bottom} className="chart-guide" />
      <line x1={sx(-cutoffs.logfc)} x2={sx(-cutoffs.logfc)} y1={m.top} y2={height - m.bottom} className="chart-guide" />
      <text x={(m.left + width - m.right) / 2} y={height - 4} textAnchor="middle" className="chart-title">log2 fold change</text>
      <text transform={`translate(11,${(m.top + height - m.bottom) / 2}) rotate(-90)`} textAnchor="middle" className="chart-title">−log10 adjusted p</text>
      {points.map((p) => (
        <circle key={p.gene} cx={sx(clampX(p.logfc))} cy={sy(y(p))} r={p.gene === picked ? 4.5 : 2.6}
          fill={color(p)} fillOpacity={p.gene === picked ? 1 : 0.75} stroke={p.gene === picked ? 'var(--sds-color-text)' : 'none'}
          onClick={() => onPick?.(p.gene)} style={{ cursor: onPick ? 'pointer' : undefined }}>
          <title>{`${p.gene}: log2FC ${p.logfc.toFixed(2)}, adjusted p ${p.padj.toPrecision(2)}`}</title>
        </circle>
      ))}
      {labels.map(({ p, x, y: ly, start }) => (
        <text key={`l${p.gene}`} x={x} y={ly} textAnchor={start ? 'start' : 'end'}
          className="chart-point-label" onClick={() => onPick?.(p.gene)} style={{ cursor: onPick ? 'pointer' : undefined }}>{p.gene}</text>
      ))}
    </svg>
  );
}
