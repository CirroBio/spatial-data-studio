// The report of a clustering run: how many clusters and how big, where each one is on the
// tissue, how much of the variance the PCA behind them holds, the way on to what sets
// each cluster apart, and the full table.
import { useEffect, useMemo, useState } from 'react';
import { navigate, TASK_PARAM } from '../app/route';
import { formatCount, plural } from '../app/ui';
import { BarList } from '../charts/BarList';
import { Scree } from '../charts/Scree';
import { TissueThumb, type Paint } from '../charts/TissueThumb';
import { describeError } from '../cirro/session';
import { useDisplays } from '../item/displayState';
import { useColorKey } from '../item/useColorField';
import { readGroups } from '../tasks/data';
import { ResultTable } from '../tasks/parts';
import { storeOf } from '../workbench/workbench';
import { FullTable, NO_COLOR, pct, Section, showOnTissue, Stats, useTissue } from './parts';
import type { ReportProps } from './ReportView';
import { readResultTable } from './store';

export type ClustersSummary = {
  column: string;
  // In label order, which is largest first.
  clusters: string[];
  sizes: number[];
  cells: number;
  resolution: number;
  genes_used: number;
  genes_total: number;
  n_comps: number;
  // True when the stored values were taken as counts and log-normalized first.
  normalized: boolean;
  // The obsm key the PCA was kept under, if it was.
  pca_key: string | null;
};

// The components the headline adds up, when the PCA has that many.
const HEADLINE_COMPS = 10;
const BARS_W = 560;
const SCREE_W = 640;
const SCREE_H = 200;
const THUMB_W = 120;

const percent = (v: number) => `${(100 * v).toFixed(1)}%`;

export default function ClustersReport({ result, table, wb, handle, unit, width }: ReportProps) {
  const summary = result.meta.summary as ClustersSummary;
  const { column, clusters, sizes, cells } = summary;
  const field = `obs:${column}`;
  const units = `${unit[0].toUpperCase()}${unit.slice(1)}s`;
  const displays = useDisplays(wb.key, wb.handle);
  const tissue = useTissue(wb, displays.spatial?.encoding.coords ?? 'obsm:spatial');
  const version = wb.dataVersions[field] ?? 0;
  const { key } = useColorKey(field, version, displays.spatial?.encoding.category_colors?.[field]);
  const colors = useMemo(() => {
    const of = new Map(key?.kind === 'categorical' ? key.items.map((i) => [i.label, i.color]) : []);
    return clusters.map((c) => of.get(c) ?? NO_COLOR);
  }, [key, clusters]);
  const order = useMemo(() => clusters.map((_, i) => i).sort((a, b) => sizes[b] - sizes[a] || a - b), [clusters, sizes]);
  const [problem, setProblem] = useState<string | null>(null);

  // The column as it is now, for where each cluster's cells are; it may have been
  // replaced or edited since the run.
  const [now, setNow] = useState<{ codes: Int32Array; categories: string[] } | null>(null);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let live = true;
    readGroups(handle, column).then((g) => {
      if (!live) return;
      const counts = new Array<number>(g.categories.length).fill(0);
      for (const c of g.codes) if (c >= 0) counts[c] += 1;
      setNow(g);
      setStale(g.categories.join('\u0000') !== clusters.join('\u0000') || counts.some((n, i) => n !== sizes[i]));
    }, (e: unknown) => {
      if (!live) return;
      setNow(null);
      setStale(true);
      setProblem(`Couldn't read “${column}” as it is now: ${describeError(e)}`);
    });
    return () => {
      live = false;
    };
  }, [handle, column, clusters, sizes, version]);
  const paints = useMemo(() => {
    if (!now) return null;
    const at = new Map(now.categories.map((c, i) => [c, i]));
    return clusters.map((c, i): Paint | null => {
      const code = at.get(c);
      return code === undefined ? null : { kind: 'group', member: (cell) => now.codes[cell] === code, color: colors[i] };
    });
  }, [now, clusters, colors]);

  const [variance, setVariance] = useState<ArrayLike<number> | null>(null);
  useEffect(() => {
    let live = true;
    readResultTable(storeOf(wb.key), handle.tableKey, result, 'pca').then((t) => {
      const ratios = t.columns.variance_ratio;
      if (!ratios || Array.isArray(ratios)) throw new Error('The kept PCA has no variance_ratio column.');
      if (live) setVariance(ratios);
    }).catch((e: unknown) => live && setProblem(describeError(e)));
    return () => {
      live = false;
    };
  }, [wb.key, handle.tableKey, result]);
  const cumulative = useMemo(() => {
    let total = 0;
    return variance ? Array.from(variance, (v) => (total += v)) : null;
  }, [variance]);

  const sizeColumn = table.columns.size as ArrayLike<number>;
  const sizeRows = table.index.map((cluster, i) => ({ cluster, size: sizeColumn[i], share: sizeColumn[i] / Math.max(cells, 1) }));
  const shareOf = (i: number) => percent(sizes[i] / Math.max(cells, 1));
  // How evenly the cells divided: how many of the largest clusters hold half of them.
  let spread = `All ${formatCount(cells)} ${unit}s are in one cluster.`;
  if (order.length > 1) {
    let held = 0;
    const half = order.findIndex((i) => (held += sizes[i]) >= cells / 2) + 1;
    const smallest = order[order.length - 1];
    spread = `${half === 1 ? 'The largest holds' : `The ${half} largest hold`} half of the ${formatCount(cells)} ${unit}s; the smallest, ${clusters[smallest]}, has ${plural(sizes[smallest], [unit, `${unit}s`])}.`;
  }
  let headline = 'Reading the PCA…';
  if (variance && cumulative) {
    const n = cumulative.length;
    const k = Math.min(HEADLINE_COMPS, n);
    const first = `PC1 alone explains ${pct(variance[0])} of the variance in the ${formatCount(summary.genes_used)} genes used`;
    headline = n > k
      ? `${first}; the first ${k} components explain ${pct(cumulative[k - 1])}, and all ${n} together ${pct(cumulative[n - 1])}.`
      : `${first}; all ${n} components together explain ${pct(cumulative[n - 1])}.`;
  }

  return (
    <div className="report-body">
      <Stats stats={[
        { label: 'Clusters', value: clusters.length, note: `in ${column}` },
        { label: units, value: cells },
        {
          label: 'Genes used', value: summary.genes_used,
          note: summary.genes_used === summary.genes_total ? 'every gene in the panel' : `the most variable of ${formatCount(summary.genes_total)}`,
        },
        { label: 'PCA components', value: summary.n_comps, note: cumulative ? `${pct(cumulative[cumulative.length - 1])} of the variance` : undefined },
        { label: 'Resolution', value: summary.resolution.toFixed(1), note: 'higher gives more clusters' },
        {
          label: 'Log-normalized', value: summary.normalized ? 'Yes' : 'No',
          note: summary.normalized ? 'counts scaled per cell, then log1p' : 'not raw counts, so used as they are',
        },
      ]} />
      {problem && <p className="notice notice-danger">{problem}</p>}
      <Section title="Cluster sizes" note={`Largest first, in the colors the tissue uses. ${spread}`}
        actions={<button type="button" className="button button-small" onClick={() => showOnTissue(wb.key, field)}>Color the tissue by {column}</button>}>
        <BarList width={Math.min(BARS_W, width - 2)} label={`${units} per cluster of ${column}`}
          bars={order.map((i) => ({ label: clusters[i], value: sizes[i], color: colors[i], note: `${formatCount(sizes[i])} · ${shareOf(i)}` }))} />
      </Section>
      <Section title="Where the clusters are"
        note={stale
          ? `“${column}” has changed since this run; the maps show it as it is now, where they can.`
          : `Each cluster's ${unit}s on the section, in its color. Pick one to color the tissue by ${column}.`}>
        {tissue ? (
          <div className="report-row">
            {order.map((i) => {
              const paint = paints?.[i];
              const caption = `${formatCount(sizes[i])} · ${shareOf(i)}`;
              return (
                <button key={clusters[i]} type="button" className="link-button cluster-thumb" onClick={() => showOnTissue(wb.key, field)}
                  aria-label={`Cluster ${clusters[i]}, ${caption} of the ${unit}s: color the tissue by ${column}`}>
                  {paint ? <TissueThumb tissue={tissue} paint={paint} width={THUMB_W} label={`Where cluster ${clusters[i]} is`} />
                    : <span className="thumb-empty" style={{ width: THUMB_W, height: THUMB_W }} />}
                  <span className="cluster-thumb-label"><span className="swatch" style={{ background: colors[i] }} />{clusters[i]}</span>
                  <span className="muted">{caption}</span>
                </button>
              );
            })}
          </div>
        ) : <p className="muted">Reading where the {unit}s are…</p>}
      </Section>
      <Section title="The PCA behind them"
        note={(
          <>
            {headline} The clusters come from the {unit}s' nearest neighbors in all {summary.n_comps} components.
            {summary.pca_key && <> The scores are kept as <code>obsm['{summary.pca_key}']</code>.</>}
          </>
        )}>
        {variance && cumulative && (
          <>
            <div className="task-chart" style={{ width: Math.min(SCREE_W, width - 2) }}>
              <Scree ratios={variance} width={Math.min(SCREE_W, width - 2) - 2} height={SCREE_H} label="Variance explained by each principal component" />
            </div>
            <FullTable count={variance.length}>
              <ResultTable rows={Array.from(variance, (v, i) => ({ component: `PC${i + 1}`, ratio: v, cumulative: cumulative[i] }))} rowKey={(r) => r.component}
                columns={[
                  { key: 'component', label: 'Component' },
                  { key: 'ratio', label: 'Variance explained', format: (v) => `${(100 * v).toFixed(2)}%` },
                  { key: 'cumulative', label: 'Up to here', format: percent },
                ]} />
            </FullTable>
          </>
        )}
      </Section>
      <Section title="Next: what sets each cluster apart"
        note={`Marker genes tests every gene in each cluster against the rest of the ${unit}s, and shows the genes that set each cluster apart. Choose “${column}” as its groups.`}>
        <div className="button-row">
          <button type="button" className="button" onClick={() => navigate({ section: 'task', [TASK_PARAM]: 'markers' })}>Find marker genes</button>
        </div>
      </Section>
      <Section title="All clusters">
        <FullTable count={table.index.length}>
          <ResultTable rows={sizeRows} rowKey={(r) => r.cluster}
            columns={[
              { key: 'cluster', label: 'Cluster' }, { key: 'size', label: units, format: formatCount },
              { key: 'share', label: 'Share', format: percent },
            ]} />
        </FullTable>
      </Section>
    </div>
  );
}
