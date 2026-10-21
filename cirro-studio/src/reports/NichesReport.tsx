// The report of a niche run: how many niches, of how many groups, every niche's mix in one
// heatmap, then a card per niche (its size, where its cells are, what it is made of in
// words and bars), and the full table of mixes.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { useSize } from '../lib/useSize';
import { readGroups } from '../tasks/data';
import { ResultTable, type Column } from '../tasks/parts';
import { FullTable, NO_COLOR, pct, Section, showOnTissue, Stats, useTissue } from './parts';
import type { ReportProps } from './ReportView';

export type NichesSummary = {
  // The column whose groups were mixed, and the column the niches were written to.
  column: string;
  niche_column: string;
  // Largest first, with their cells; a cell with no labelled cell near it is in none.
  niches: string[];
  sizes: number[];
  unassigned: number;
  // The groups in order, and each one's column in the main table: its label, made safe
  // for the store.
  groups: string[];
  columns: string[];
  neighbors: number;
  // As asked for; k-means can find fewer.
  n_niches: number;
  // The positions the neighbors were found in.
  coords: string;
};

type Share = { group: number; share: number };

// A group under this share of a niche's mix goes unnamed in its description.
const MENTION = 0.05;
// A group this many times as common in a niche as across all cells sets the niche apart.
const DISTINCT = 1.5;
const SHOWN_GROUPS = 5;
// A group under this share of a niche gets no bar: it would be a sliver labelled "<1%".
const BAR_MIN = 0.01;
const THUMB_W = 132;
// The heatmap's label room and largest square (its own limits): it is drawn no wider than
// they need, so it doesn't trail empty space.
const HEAT_LABEL_W = 110;
const HEAT_CELL = 26;

/** A list in words: "a", "a and b", "a, b and c". */
function listed(items: ReactNode[]): ReactNode {
  return items.map((item, i) => <Fragment key={i}>{i === 0 ? '' : i === items.length - 1 ? ' and ' : ', '}{item}</Fragment>);
}

/** "Mostly acinar (61%), with ductal (22%) and stroma (9%)." from a mix, largest first. */
function describeMix(mix: Share[], groups: string[]): ReactNode {
  const say = (s: Share) => <><strong>{groups[s.group]}</strong> ({pct(s.share)})</>;
  const [first, ...others] = mix;
  const rest = others.filter((s) => s.share >= MENTION).slice(0, 3);
  if (first.share >= 0.9) return <>Almost all {say(first)}.</>;
  if (first.share >= 0.5) return <>Mostly {say(first)}{rest.length ? <>, with {listed(rest.map(say))}</> : null}.</>;
  return <>A mix of {listed([first, ...rest].map(say))}.</>;
}

function NicheCard({ label, size, total, color, mix, overall, groups, groupColor, tissue, paint, unit }: {
  label: string; size: number; total: number; color: string; mix: Share[]; overall: Float64Array; groups: string[];
  groupColor: (group: string) => string; tissue: Tissue | null; paint: Paint | null; unit: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useSize(ref);
  // What sets the niche apart: the named group most over-represented against all cells.
  const distinct = mix.filter((s) => s.share >= MENTION && overall[s.group] > 0)
    .map((s) => ({ ...s, ratio: s.share / overall[s.group] }))
    .sort((a, b) => b.ratio - a.ratio)[0];
  return (
    <article className="group-card">
      <header className="group-card-head">
        <span className="swatch" style={{ background: color }} />
        <h4>{label}</h4>
        <span className="muted">{plural(size, [unit, `${unit}s`])} · {((100 * size) / Math.max(total, 1)).toFixed(1)}%</span>
      </header>
      <div className="group-card-body">
        <figure className="group-card-thumb">
          {tissue && paint ? <TissueThumb tissue={tissue} paint={paint} width={THUMB_W} label={`Where ${label} is`} />
            : <div className="thumb-empty" style={{ width: THUMB_W, height: THUMB_W }} />}
          <figcaption className="muted">Where its {unit}s are</figcaption>
        </figure>
        {/* Sized by the card, not by the bars drawn at its last width, or it couldn't narrow. */}
        <div ref={ref} style={{ flex: 1, minWidth: 0, contain: 'inline-size' }}>
          {width > 0 && (
            <BarList width={width} label={`The largest groups in ${label}`}
              bars={mix.slice(0, SHOWN_GROUPS).filter((s, i) => i === 0 || s.share >= BAR_MIN)
                .map((s) => ({ label: groups[s.group], value: s.share, color: groupColor(groups[s.group]), note: pct(s.share) }))} />
          )}
        </div>
      </div>
      <p className="group-card-text">
        {describeMix(mix, groups)}{' '}
        {distinct && distinct.ratio >= DISTINCT
          ? <><strong>{groups[distinct.group]}</strong> is {distinct.ratio.toFixed(1)}× as common here as across all {unit}s.</>
          : <>No group is much more common here than across all {unit}s.</>}
      </p>
    </article>
  );
}

export default function NichesReport({ result, table, wb, handle, unit, width }: ReportProps) {
  const { column, niche_column: nicheColumn, niches, sizes, unassigned, groups, columns, neighbors, n_niches: asked, coords } = result.meta.summary as NichesSummary;
  const { session } = useStudio();
  const displays = useDisplays(wb.key, wb.handle);
  const tissue = useTissue(wb, coords);
  const total = sizes.reduce((a, b) => a + b, 0);
  const unitsTitle = `${unit[0].toUpperCase()}${unit.slice(1)}s`;
  const groupField = `obs:${column}`;
  const { key: groupKey } = useColorKey(groupField, wb.dataVersions[groupField] ?? 0, displays.spatial?.encoding.category_colors?.[groupField]);
  const groupColor = useMemo(() => {
    const colors = new Map(groupKey?.kind === 'categorical' ? groupKey.items.map((i) => [i.label, i.color]) : []);
    return (label: string) => colors.get(label) ?? NO_COLOR;
  }, [groupKey]);

  // Row-major niches × groups, as the table keeps them.
  const profiles = useMemo(() => {
    const out = new Float32Array(niches.length * groups.length);
    columns.forEach((c, g) => {
      const values = table.columns[c] as ArrayLike<number>;
      niches.forEach((_, i) => { out[i * groups.length + g] = values[i]; });
    });
    return out;
  }, [table, niches, groups, columns]);
  const mixes = useMemo(() => niches.map((_, i) => groups.map((_, g) => ({ group: g, share: profiles[i * groups.length + g] }))
    .sort((a, b) => b.share - a.share)), [niches, groups, profiles]);
  // Each group's share across all the cells in a niche, weighed by the niches' sizes.
  const overall = useMemo(() => {
    const out = new Float64Array(groups.length);
    sizes.forEach((n, i) => groups.forEach((_, g) => { out[g] += (n * profiles[i * groups.length + g]) / Math.max(total, 1); }));
    return out;
  }, [groups, sizes, profiles, total]);

  // The niche column as it is now, for where each niche's cells are and its color. It
  // still holds this run's niches if each one has the cells it had: renaming them keeps
  // that, a later run into the same column doesn't, whatever it names its niches.
  const nicheField = `obs:${nicheColumn}`;
  const version = wb.dataVersions[nicheField] ?? 0;
  const { key: nicheKey } = useColorKey(nicheField, version, displays.spatial?.encoding.category_colors?.[nicheField]);
  const [now, setNow] = useState<{ codes: Int32Array } | 'changed' | 'missing' | null>(null);
  useEffect(() => {
    let live = true;
    readGroups(handle, nicheColumn).then((g) => {
      if (!live) return;
      const counts = g.categories.map(() => 0);
      for (const c of g.codes) if (c >= 0) counts[c] += 1;
      setNow(counts.length === sizes.length && counts.every((n, i) => n === sizes[i]) ? { codes: g.codes } : 'changed');
    }, () => live && setNow('missing'));
    return () => {
      live = false;
    };
  }, [handle, nicheColumn, sizes, version]);
  const current = now === 'changed' || now === 'missing' ? null : now;
  const nicheColors = useMemo(
    () => niches.map((_, i) => (current && nicheKey?.kind === 'categorical' ? nicheKey.items[i]?.color : undefined) ?? NO_COLOR),
    [niches, current, nicheKey],
  );
  const paints = useMemo(
    () => niches.map((_, i): Paint | null => (current ? { kind: 'group', member: (c) => current.codes[c] === i, color: nicheColors[i] } : null)),
    [niches, current, nicheColors],
  );

  const [figure, setFigure] = useState<'saving' | 'saved' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const saveFigure = async () => {
    setFigure('saving');
    setProblem(null);
    try {
      await keepFigure(wb.key, handle.tableKey, {
        title: result.meta.title,
        caption: `Each row is a niche, found by k-means over every ${unit}'s neighborhood: the ${unit} and its ${neighbors} nearest. A square is the average share of a ${column} group in that niche's neighborhoods.`,
        created_by: session?.displayName ?? '',
        view: { kind: 'chart', chart: { type: 'heatmap', result: [...result.path, 'table'].join('/') } },
        width_mm: (groups.length > 12 ? SIZE_PRESETS.double : SIZE_PRESETS.single).widthMm,
      });
      setFigure('saved');
    } catch (e) {
      setFigure(null);
      setProblem(describeError(e));
    }
  };

  const heatW = Math.min(width - 2, Math.max(320, HEAT_LABEL_W + groups.length * HEAT_CELL + 10));
  const tableRows = useMemo(() => niches.map((niche, i) => ({
    niche, cells: sizes[i], share: sizes[i] / Math.max(total + unassigned, 1),
    ...Object.fromEntries(groups.map((_, g) => [`g${g}`, profiles[i * groups.length + g]])),
  })), [niches, sizes, total, unassigned, groups, profiles]);
  const tableColumns: Column<Record<string, string | number>>[] = [
    { key: 'niche', label: 'Niche' }, { key: 'cells', label: unitsTitle, format: formatCount },
    { key: 'share', label: `Of all ${unit}s`, format: pct },
    ...groups.map((g, i) => ({ key: `g${i}`, label: g, format: pct })),
  ];

  return (
    <div className="report-body">
      <Stats stats={[
        { label: 'Niches', value: niches.length, note: niches.length < asked ? `of ${asked} asked for` : 'by k-means' },
        { label: unitsTitle, value: total, note: unassigned ? `and ${formatCount(unassigned)} with no ${column} group near them` : undefined },
        { label: 'Groups mixed', value: groups.length, note: `in ${column}` },
        { label: `Neighbors per ${unit}`, value: neighbors, note: `the nearest, and the ${unit} itself` },
        { label: 'Niche column', value: nicheColumn, note: `each ${unit}'s niche` },
      ]} />
      <Section title="What each niche is made of"
        note={`A row per niche, a column per ${column} group. A square's shade is the group's average share of the neighborhoods in that niche, so each row adds up to 100%.`}
        actions={(
          <button type="button" className="button button-small" disabled={figure !== null} onClick={() => void saveFigure()}>
            {figure === 'saved' ? 'Saved as a figure' : 'Save as a figure'}
          </button>
        )}>
        {problem && <p className="notice notice-danger">{problem}</p>}
        <div className="task-chart" style={{ width: heatW + 2 }}>
          <Heatmap rows={niches} columns={groups} values={profiles} width={heatW} label={`Mix of ${column} groups in each niche`} diverging={false} />
        </div>
      </Section>
      <Section title="The niches"
        note={now === 'missing' ? `“${nicheColumn}” is no longer in the data, so the maps can't show these niches.`
          : now === 'changed' ? `“${nicheColumn}” has changed since this ran, so the maps can't show these niches.`
            : `Each niche's size, where its ${unit}s are, and its largest groups in their own colors.`}
        actions={<button type="button" className="button button-small" disabled={!current} onClick={() => showOnTissue(wb.key, nicheField)}>Color the tissue by {nicheColumn}</button>}>
        <div className="group-cards">
          {niches.map((label, i) => (
            <NicheCard key={label} label={label} size={sizes[i]} total={total + unassigned} color={nicheColors[i]} mix={mixes[i]}
              overall={overall} groups={groups} groupColor={groupColor} tissue={tissue} paint={paints[i]} unit={unit} />
          ))}
        </div>
      </Section>
      <Section title="All results">
        <FullTable count={niches.length}>
          <ResultTable rows={tableRows} rowKey={(r) => String(r.niche)} columns={tableColumns} />
        </FullTable>
      </Section>
    </div>
  );
}
