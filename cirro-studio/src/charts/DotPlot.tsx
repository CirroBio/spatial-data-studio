// Marker genes at a glance, as scanpy's dotplot draws them: a row per group, a column per
// gene; a dot's size is the share of the group's cells that express the gene, its color
// the group's mean expression of it, scaled from the gene's lowest group mean to its
// highest. Wider than its box, it scrolls sideways.
import { VIRIDIS_CSS_STOPS } from '@cirrobio/spatial-viewer';

export interface DotPlotData {
  groups: { label: string; color: string }[];
  genes: string[];
  // Row-major groups × genes.
  fraction: ArrayLike<number>;
  mean: ArrayLike<number>;
}

const MIN_CELL = 13;
const MAX_CELL = 22;
const GENE_LABEL_H = 64;
const KEY_H = 60;

export function DotPlot({ data, width, onPickGene, onPickGroup, picked }: {
  data: DotPlotData; width: number; onPickGene?: (gene: string) => void; onPickGroup?: (group: number) => void; picked?: string | null;
}) {
  const { groups, genes, fraction, mean } = data;
  const labelW = Math.min(170, Math.max(50, ...groups.map((g) => g.label.length * 6.4 + 22)));
  const cell = Math.max(MIN_CELL, Math.min(MAX_CELL, (width - labelW - 8) / Math.max(genes.length, 1)));
  const plotW = labelW + genes.length * cell + 8;
  const height = GENE_LABEL_H + groups.length * cell + KEY_H;
  // Each gene's color runs from its lowest group mean to its highest.
  const range = genes.map((_, j) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < groups.length; i++) {
      const m = mean[i * genes.length + j];
      if (m < lo) lo = m;
      if (m > hi) hi = m;
    }
    return [lo, hi];
  });
  const shade = (i: number, j: number) => {
    const [lo, hi] = range[j];
    const t = hi > lo ? (mean[i * genes.length + j] - lo) / (hi - lo) : 1;
    return VIRIDIS_CSS_STOPS[Math.round(255 * Math.min(1, Math.max(0, t)))];
  };
  const radius = (f: number) => (cell / 2 - 1) * Math.sqrt(Math.min(1, Math.max(0, f)));
  return (
    <div className="dot-plot">
      <svg width={Math.max(plotW, 260)} height={height} role="img" aria-label="Dot plot of marker genes by group">
        <g transform={`translate(${labelW},${GENE_LABEL_H - 6})`}>
          {genes.map((gene, j) => (
            <text key={gene} transform={`translate(${j * cell + cell / 2},0) rotate(-55)`}
              className={picked === gene ? 'chart-label chart-label-on dot-gene' : 'chart-label dot-gene'}
              onClick={onPickGene && (() => onPickGene(gene))}>{gene}</text>
          ))}
        </g>
        {groups.map((g, i) => (
          <g key={g.label} transform={`translate(0,${GENE_LABEL_H + i * cell})`}>
            <g className={onPickGroup ? 'dot-group dot-group-pick' : 'dot-group'} onClick={onPickGroup && (() => onPickGroup(i))}>
              <rect x={labelW - 14} y={cell / 2 - 4} width={8} height={8} rx={2} fill={g.color} />
              <text x={labelW - 18} y={cell / 2 + 4} textAnchor="end" className="chart-label">{g.label}</text>
            </g>
            {genes.map((gene, j) => (
              <circle key={gene} cx={labelW + j * cell + cell / 2} cy={cell / 2} r={radius(fraction[i * genes.length + j])}
                fill={shade(i, j)}>
                <title>{`${g.label} · ${gene}: in ${Math.round(100 * fraction[i * genes.length + j])}% of the group's cells`}</title>
              </circle>
            ))}
          </g>
        ))}
        <g transform={`translate(${labelW},${GENE_LABEL_H + groups.length * cell + 14})`} className="dot-key">
          <text x={0} y={10} className="chart-value">In group:</text>
          {[0.25, 0.5, 0.75, 1].map((f, k) => (
            <g key={f} transform={`translate(${62 + k * 44},6)`}>
              <circle cx={0} cy={0} r={radius(f)} className="dot-key-dot" />
              <text x={radius(1) + 3} y={4} className="chart-value">{f * 100}%</text>
            </g>
          ))}
          <text x={0} y={34} className="chart-value">Mean in group, per gene:</text>
          <defs>
            <linearGradient id="dot-ramp">{[0, 0.25, 0.5, 0.75, 1].map((t) => <stop key={t} offset={t} stopColor={VIRIDIS_CSS_STOPS[Math.round(255 * t)]} />)}</linearGradient>
          </defs>
          <text x={150} y={34} textAnchor="end" className="chart-value">lowest</text>
          <rect x={156} y={26} width={90} height={9} rx={2} fill="url(#dot-ramp)" />
          <text x={252} y={34} className="chart-value">highest</text>
        </g>
      </svg>
    </div>
  );
}
