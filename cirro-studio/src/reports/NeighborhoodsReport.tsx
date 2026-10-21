// The report of a neighborhood enrichment run: which groups of a column sit next to each
// other on the tissue more often than chance, and which keep apart. The z-scores as a
// heatmap (to save as a figure), the pairs that sit together and keep apart most, a card
// per group (where it is, whether its cells keep together, whom they sit beside), and
// every pair.
import { useEffect, useMemo, useState } from 'react';
import { useStudio } from '../app/studio';
import { formatCount, plural } from '../app/ui';
import { BarList } from '../charts/BarList';
import { Heatmap } from '../charts/Heatmap';
import { TissueThumb, type Paint, type Tissue } from '../charts/TissueThumb';
import { describeError } from '../cirro/session';
import { SIZE_PRESETS } from '../figures/layout';
import { keepFigure } from '../figures/spec';
import { useDisplays } from '../item/displayState';
import { useColorKey } from '../item/useColorField';
import { readGroups } from '../tasks/data';
import { ResultTable } from '../tasks/parts';
import { storeOf } from '../workbench/workbench';
import { FullTable, NO_COLOR, pct, Section, showOnTissue, Stats, useTissue } from './parts';
import type { ReportProps } from './ReportView';
import { readResultTable, type DataFrame } from './store';

export type NeighborhoodsSummary = {
  column: string;
  // The column's groups in the tables' order. The tables name each by its label, or a
  // stand-in where the store can't take the label as a name.
  groups: string[];
  sizes: number[];
  neighbors: number;
  permutations: number;
  // The positions the neighbors were found from.
  coords: string;
};

type Pair = { a: number; b: number; z: number };
type PairRow = { from: string; to: string; z: number; count: number; share: number };

// A z-score beyond this either way is unlikely to be chance (two-sided p < 0.05).
const Z_NOTABLE = 2;
const SHOWN_PAIRS = 10;
// How many groups a card names on each side, and lists among its cells' neighbors.
const NAMED = 2;
const SHOWN_NEIGHBORS = 4;
const THUMB_W = 132;
const PAIR_THUMB_W = 200;
// The heatmap's squares stop growing at this size, and the chart at the width they need.
const HEAT_CELL = 26;
const HEAT_LABELS_W = 200;
const TOGETHER_COLOR = 'var(--sds-div-pos)';
const APART_COLOR = 'var(--sds-div-neg)';

const fmtZ = (z: number) => (Number.isFinite(z) ? z.toFixed(1) : 'no value');
const fmtShare = (v: number) => (Number.isFinite(v) ? pct(v) : '—');
const listed = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** A square kept table as a row-major matrix; its columns are named by its index. */
function matrixOf(df: DataFrame): Float64Array {
  const n = df.index.length;
  const out = new Float64Array(n * n);
  df.index.forEach((name, j) => {
    const column = df.columns[name];
    if (!column || Array.isArray(column)) throw new Error(`The result has no numeric column “${name}”.`);
    for (let i = 0; i < n; i++) out[i * n + j] = column[i];
  });
  return out;
}

function GroupCard({ label, groups, index, size, total, colors, z, shares, tissue, paint, unit }: {
  label: string; groups: string[]; index: number; size: number; total: number; colors: string[]; z: Float64Array;
  shares: Float64Array | null; tissue: Tissue | null; paint: Paint | null; unit: string;
}) {
  const n = groups.length;
  const own = z[index * n + index];
  const others = groups.map((_, j) => j).filter((j) => j !== index && Number.isFinite(z[index * n + j]))
    .sort((x, y) => z[index * n + y] - z[index * n + x]);
  const beside = others.filter((j) => z[index * n + j] >= Z_NOTABLE).slice(0, NAMED);
  const avoids = others.filter((j) => z[index * n + j] <= -Z_NOTABLE).reverse().slice(0, NAMED);
  const named = (js: number[]) => listed(js.map((j) => `${groups[j]} (z ${fmtZ(z[index * n + j])})`));
  const neighbors = shares && groups.map((_, j) => j).sort((x, y) => shares[y] - shares[x]).slice(0, SHOWN_NEIGHBORS);
  return (
    <article className="group-card">
      <header className="group-card-head">
        <span className="swatch" style={{ background: colors[index] }} />
        <h4>{label}</h4>
        <span className="muted">{plural(size, [unit, `${unit}s`])} · {pct(size / Math.max(total, 1))}</span>
      </header>
      <div className="group-card-body">
        <figure className="group-card-thumb">
          {tissue && paint ? <TissueThumb tissue={tissue} paint={paint} width={THUMB_W} label={`Where ${label} is`} />
            : <div className="thumb-empty" style={{ width: THUMB_W, height: THUMB_W }} />}
          <figcaption className="muted">Where its {unit}s are</figcaption>
        </figure>
        {neighbors && (
          <table className="marker-mini">
            <thead><tr><th>Its {unit}s' neighbors</th><th>Share</th><th>z</th></tr></thead>
            <tbody>
              {neighbors.map((j) => (
                <tr key={groups[j]}>
                  <td><span className="dot" style={{ background: colors[j] }} /> {groups[j]}{j === index && <span className="muted"> (itself)</span>}</td>
                  <td>{fmtShare(shares[j])}</td>
                  <td>{fmtZ(z[index * n + j])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="group-card-text">
        {!Number.isFinite(own) ? <>Too few {unit}s to tell whether they keep together. </>
          : own >= Z_NOTABLE ? <><strong>Keeps together</strong> (z {fmtZ(own)}). </>
          : own <= -Z_NOTABLE ? <><strong>Spreads out</strong> among other groups (z {fmtZ(own)}). </>
          : <><strong>Mixes with others</strong> (z {fmtZ(own)}). </>}
        {beside.length ? <>Sits next to {named(beside)} more than chance</> : <>Sits next to no other group more than chance</>}
        {avoids.length ? <>; avoids {named(avoids)}.</> : <>, and avoids none.</>}
      </p>
    </article>
  );
}

export default function NeighborhoodsReport({ result, table, wb, handle, unit, width }: ReportProps) {
  const { column, groups, sizes, neighbors, permutations, coords } = result.meta.summary as NeighborhoodsSummary;
  const { session } = useStudio();
  const field = `obs:${column}`;
  const version = wb.dataVersions[field] ?? 0;
  const displays = useDisplays(wb.key, wb.handle);
  const tissue = useTissue(wb, coords);
  const { key } = useColorKey(field, version, displays.spatial?.encoding.category_colors?.[field]);
  const colors = useMemo(
    () => groups.map((g) => (key?.kind === 'categorical' ? key.items.find((i) => i.label === g)?.color : undefined) ?? NO_COLOR),
    [groups, key],
  );
  const n = groups.length;
  const z = useMemo(() => matrixOf(table), [table]);

  // Neighbor-pair counts, and each as a share of its row: of all the neighbors of a
  // group's cells, the share in each group.
  const [counts, setCounts] = useState<Float64Array | null>(null);
  useEffect(() => {
    let live = true;
    // Without them the report gives z-scores alone.
    readResultTable(storeOf(wb.key), handle.tableKey, result, 'count').then(matrixOf).then((m) => live && setCounts(m), () => undefined);
    return () => {
      live = false;
    };
  }, [wb.key, handle.tableKey, result]);
  const shares = useMemo(() => {
    if (!counts) return null;
    const out = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < n; j++) sum += counts[i * n + j];
      for (let j = 0; j < n; j++) out[i * n + j] = counts[i * n + j] / sum;
    }
    return out;
  }, [counts, n]);

  // The column as it is now, for where each group's cells are.
  const [current, setCurrent] = useState<{ codes: Int32Array; categories: string[] } | null>(null);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let live = true;
    readGroups(handle, column).then((g) => {
      if (!live) return;
      const now = g.categories.map(() => 0);
      for (const c of g.codes) if (c >= 0) now[c] += 1;
      setCurrent(g);
      setStale(g.categories.join('\u0000') !== groups.join('\u0000') || now.some((s, i) => s !== sizes[i]));
    }, () => live && setStale(true));
    return () => {
      live = false;
    };
  }, [handle, column, groups, sizes, version]);
  const paints = useMemo(() => {
    if (!current) return null;
    const at = new Map(current.categories.map((c, i) => [c, i]));
    return groups.map((g, i): Paint | null => {
      const code = at.get(g);
      return code === undefined ? null : { kind: 'group', member: (c) => current.codes[c] === code, color: colors[i] };
    });
  }, [current, groups, colors]);

  // Each pair once, both directions averaged: A's cells with B among their neighbors, and B's with A.
  const pairs = useMemo(() => {
    const out: Pair[] = [];
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const v = (z[a * n + b] + z[b * n + a]) / 2;
        if (Number.isFinite(v)) out.push({ a, b, z: v });
      }
    }
    return out.sort((x, y) => y.z - x.z);
  }, [z, n]);
  const together = pairs.filter((p) => p.z > 0).slice(0, SHOWN_PAIRS);
  const apart = pairs.filter((p) => p.z < 0).reverse().slice(0, SHOWN_PAIRS);
  const pairLabel = (p: Pair) => `${groups[p.a]} · ${groups[p.b]}`;
  const [picked, setPicked] = useState<Pair | null>(null);
  const pair = picked ?? together[0] ?? apart[0] ?? null;

  const [figure, setFigure] = useState<'saving' | 'saved' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const saveFigure = async () => {
    setFigure('saving');
    setProblem(null);
    try {
      await keepFigure(wb.key, handle.tableKey, {
        title: result.meta.title,
        caption: `z-scores of how often each pair of ${column} groups are neighbors (each ${unit}'s ${neighbors} nearest on the tissue) against ${formatCount(permutations)} shuffles of the labels: red, more often than chance; blue, less.`,
        created_by: session?.displayName ?? '',
        view: { kind: 'chart', chart: { type: 'heatmap', result: [...result.path, 'table'].join('/') } },
        width_mm: SIZE_PRESETS.single.widthMm,
      });
      setFigure('saved');
    } catch (e) {
      setFigure(null);
      setProblem(describeError(e));
    }
  };

  const rows = useMemo((): PairRow[] => groups.flatMap((from, i) => groups.map((to, j) => ({
    from, to, z: z[i * n + j], count: counts?.[i * n + j] ?? NaN, share: shares?.[i * n + j] ?? NaN,
  }))), [groups, z, n, counts, shares]);

  const total = sizes.reduce((s, v) => s + v, 0);
  const ungrouped = handle.fields.n_obs - total;
  const heatW = Math.min(width - 2, HEAT_LABELS_W + n * HEAT_CELL);
  const columnW = Math.min(460, (width - 24) / 2);
  const pairBars = (list: Pair[], color: string) => list.map((p) => ({ label: pairLabel(p), value: Math.abs(p.z), color, note: `z ${fmtZ(p.z)}` }));
  const pickBar = (list: Pair[]) => (bar: { label: string }) => setPicked(list.find((p) => pairLabel(p) === bar.label) ?? null);
  const shareOf = (i: number, j: number) => (shares ? ` ${pct(shares[i * n + j])} of ${groups[i]}'s neighbors are ${groups[j]}.` : '');

  return (
    <div className="report-body">
      <Stats stats={[
        { label: 'Groups', value: n, note: `in ${column}` },
        { label: `${unit[0].toUpperCase()}${unit.slice(1)}s`, value: total, note: ungrouped > 0 ? `${formatCount(ungrouped)} more have no group` : undefined },
        { label: 'Neighbors', value: neighbors, note: `each ${unit}'s nearest on the tissue` },
        { label: 'Permutations', value: permutations, note: 'shuffles of the labels' },
        { label: 'Most together', value: together[0] ? pairLabel(together[0]) : 'none', note: together[0] && `z ${fmtZ(together[0].z)}` },
        { label: 'Most apart', value: apart[0] ? pairLabel(apart[0]) : 'none', note: apart[0] && `z ${fmtZ(apart[0].z)}` },
      ]} />
      <Section title="Who sits next to whom"
        note={`Each square compares how often the row group's ${unit}s have the column group's among their ${neighbors} nearest neighbors with how often they would if the labels were shuffled: red, more often; blue, less; a z-score beyond ±${Z_NOTABLE} is unlikely to be chance. Red along the diagonal means a group's ${unit}s keep together. Hover a square for its z-score.`}
        actions={(
          <span className="button-row">
            <button type="button" className="button button-small" onClick={() => showOnTissue(wb.key, field)}>Color the tissue by {column}</button>
            <button type="button" className="button button-small" disabled={figure !== null} onClick={() => void saveFigure()}>
              {figure === 'saved' ? 'Saved as a figure' : 'Save the heatmap as a figure'}
            </button>
          </span>
        )}>
        {problem && <p className="notice notice-danger">{problem}</p>}
        <div className="task-chart" style={{ width: heatW + 2 }}>
          <Heatmap rows={groups} columns={groups} values={z} width={heatW} label={`Neighborhood enrichment z-scores of ${column}`} />
        </div>
      </Section>
      <div className="report-columns">
        <Section title="Sit together most" note="Pairs of groups that are neighbors more often than chance, strongest first (z-scores of both directions averaged). Pick one to map it.">
          {together.length
            ? <BarList bars={pairBars(together, TOGETHER_COLOR)} width={columnW} label="Pairs that sit together most" onPick={pickBar(together)} picked={pair && pairLabel(pair)} />
            : <p className="muted">No two groups are neighbors more often than chance.</p>}
        </Section>
        <Section title="Keep apart most" note="Pairs that are neighbors less often than chance, most apart first.">
          {apart.length
            ? <BarList bars={pairBars(apart, APART_COLOR)} width={columnW} label="Pairs that keep apart most" onPick={pickBar(apart)} picked={pair && pairLabel(pair)} />
            : <p className="muted">No two groups are neighbors less often than chance.</p>}
        </Section>
      </div>
      {pair && (
        <Section title={`${groups[pair.a]} and ${groups[pair.b]}`}
          note={`${pair.z > 0 ? 'Neighbors more often than chance' : 'Neighbors less often than chance'} (z ${fmtZ(pair.z)}).${shareOf(pair.a, pair.b)}${shareOf(pair.b, pair.a)}`}>
          {tissue && paints && (
            <div className="report-row">
              {[pair.a, pair.b].map((g) => paints[g] && (
                <figure key={g} className="group-card-thumb">
                  <TissueThumb tissue={tissue} paint={paints[g]} width={PAIR_THUMB_W} label={`Where ${groups[g]} is`} />
                  <figcaption className="muted">Where {groups[g]} is</figcaption>
                </figure>
              ))}
            </div>
          )}
        </Section>
      )}
      <Section title="The groups"
        note={stale
          ? `${column} has changed since this ran; the maps show it as it is now, where they can.`
          : `Whether each group's ${unit}s keep together (its z-score with itself), and the groups its ${unit}s' neighbors belong to most: their share of all its neighbors, and how far that is from chance.`}>
        <div className="group-cards">
          {groups.map((g, i) => (
            <GroupCard key={g} label={g} groups={groups} index={i} size={sizes[i]} total={total} colors={colors} z={z}
              shares={shares && shares.subarray(i * n, (i + 1) * n)} tissue={tissue} paint={paints?.[i] ?? null} unit={unit} />
          ))}
        </div>
      </Section>
      <Section title="All pairs" note={`One row per ordered pair: the first group's ${unit}s, with the second's among their neighbors.`}>
        <FullTable count={rows.length}>
          <ResultTable rows={rows} rowKey={(r) => `${r.from}\u0000${r.to}`}
            columns={[
              { key: 'from', label: 'Group' }, { key: 'to', label: 'Neighbor group' },
              { key: 'z', label: 'z-score', format: fmtZ },
              { key: 'count', label: 'Neighbor pairs', format: (v) => (Number.isFinite(v) ? formatCount(v) : '—') },
              { key: 'share', label: 'Share of its neighbors', format: fmtShare },
            ]} />
        </FullTable>
      </Section>
    </div>
  );
}
