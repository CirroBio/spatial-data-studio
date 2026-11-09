// How one grouping is made up across another: a stacked bar per group of the second, the
// overall mix first; which pairs hold more or fewer cells than that mix would put there
// (log2 observed over expected, with a chi-square test of each pair) as a heatmap; and
// every pair's counts. The Composition view draws the same sections live, and keeps them
// as this report.
import { useMemo, useState, type ReactNode } from 'react';
import { MIN_EXPECTED, testComposition, type CrossTable } from '../analysis/composition';
import { useStudio } from '../app/studio';
import { formatCount } from '../app/ui';
import { Heatmap } from '../charts/Heatmap';
import { StackedBars } from '../charts/StackedBars';
import { SIGNIFICANCE } from '../charts/Volcano';
import { describeError } from '../cirro/session';
import { SIZE_PRESETS } from '../figures/layout';
import { keepFigure, type ChartSpec } from '../figures/spec';
import { useDisplays } from '../item/displayState';
import { useColorKey } from '../item/useColorField';
import { FORMATS, ResultTable, type Column } from '../tasks/parts';
import { DownloadCsv, NO_COLOR, pct, Section, Stats } from './parts';
import type { ReportProps } from './ReportView';
import { matrixOf } from './store';

export type CompositionSummary = {
  // The column counted, whose groups split each bar, and the column it is counted across.
  column: string;
  across: string;
  // The counted column's groups in order, and each one's column in the tables: its label,
  // made safe for the store. The tables' rows are the groups counted across.
  groups: string[];
  columns: string[];
  // Cells with no group in one column or the other, in no count.
  left_out: number;
};

type PairRow = {
  across: string; group: string; cells: number; share: number; spread: number;
  expected: number; enrichment: number; z: number; p: number; padj: number;
};

// The heatmap's label room and largest square (its own limits): it is drawn no wider than
// they need.
const HEAT_LABEL_W = 110;
const HEAT_CELL = 26;
const MAX_BARS_W = 900;

const unlessUntested = (format: (v: number) => string) => (v: number) => (Number.isNaN(v) ? '–' : format(v));
/** Fixed decimals, with no minus sign on what rounds to zero. */
const fixed = (digits: number) => (v: number) => {
  if (v === -Infinity) return '−∞';
  const text = v.toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
};

/** What the view and the report both show of a composition across another column. */
export function CompositionSections({ table, colors, column, across, leftOut, unit, width, barsAction, heatmapAction }: {
  table: CrossTable; colors: string[]; column: string; across: string; leftOut: number; unit: string; width: number;
  barsAction?: ReactNode; heatmapAction?: ReactNode;
}) {
  const { rows, columns, counts } = table;
  const tests = useMemo(() => testComposition(table), [table]);
  const nC = columns.length;
  const unitsTitle = `${unit[0].toUpperCase()}${unit.slice(1)}s`;
  const pairs = useMemo(() => {
    const rowTotal = rows.map((_, i) => counts.subarray(i * nC, (i + 1) * nC).reduce((a, b) => a + b, 0));
    const colTotal = columns.map((_, j) => rows.reduce((s, _, i) => s + counts[i * nC + j], 0));
    return rows.flatMap((r, i) => columns.map((g, j): PairRow => {
      const at = i * nC + j;
      return {
        across: r, group: g, cells: counts[at], share: counts[at] / rowTotal[i], spread: counts[at] / colTotal[j],
        expected: tests.expected[at], enrichment: tests.enrichment[at], z: tests.z[at], p: tests.p[at], padj: tests.padj[at],
      };
    }));
  }, [rows, columns, counts, nC, tests]);
  const total = counts.reduce((a, b) => a + b, 0);
  const tested = pairs.filter((p) => !Number.isNaN(p.padj));
  const differ = tested.filter((p) => p.padj < SIGNIFICANCE.padj);
  const more = differ.filter((p) => p.z > 0).length;
  const marked = useMemo(() => Array.from(tests.padj, (v) => v < SIGNIFICANCE.padj), [tests]);
  const tableColumns: Column<PairRow>[] = [
    { key: 'across', label: across }, { key: 'group', label: column },
    { key: 'cells', label: unitsTitle, format: formatCount },
    { key: 'share', label: `Of its ${across}`, format: pct },
    { key: 'spread', label: `Of its ${column}`, format: pct },
    { key: 'expected', label: 'Expected', format: FORMATS.num },
    { key: 'enrichment', label: 'log2 enrichment', format: unlessUntested(fixed(2)) },
    { key: 'z', label: 'z', format: unlessUntested(fixed(1)) },
    { key: 'p', label: 'p', format: unlessUntested(FORMATS.p) },
    { key: 'padj', label: 'Adjusted p', format: unlessUntested(FORMATS.p) },
  ];
  const heatW = Math.min(width - 2, Math.max(320, HEAT_LABEL_W + nC * HEAT_CELL + 10));
  return (
    <div className="report-body">
      <Stats stats={[
        { label: `${unitsTitle} counted`, value: total, note: leftOut ? `and ${formatCount(leftOut)} with no ${across} or ${column} group, left out` : undefined },
        { label: `${column} groups`, value: nC, note: 'the bars\' segments' },
        { label: `${across} groups`, value: rows.length, note: 'a bar each' },
        { label: 'Pairs tested', value: tested.length, note: tested.length < pairs.length ? `of ${formatCount(pairs.length)}; the rest expect under ${MIN_EXPECTED} ${unit}s` : 'every pair' },
        { label: 'Pairs that differ', value: differ.length, note: `${formatCount(more)} more, ${formatCount(differ.length - more)} fewer than expected` },
      ]} />
      <Section title={`What each ${across} group is made of`} actions={barsAction}
        note={`A bar per ${across} group, split into the share of its ${unit}s in each ${column} group, with the number of its ${unit}s at the end. Overall is every ${unit} counted, the mix each group is compared with. Point at a segment for its count.`}>
        <div className="task-chart" style={{ maxWidth: MAX_BARS_W + 2 }}>
          <StackedBars rows={rows} segments={columns} colors={colors} counts={counts} overall="Overall" unit={unit}
            width={Math.min(width - 2, MAX_BARS_W)} label={`${column} across ${across}`} />
        </div>
      </Section>
      <Section title="More or fewer than expected" actions={heatmapAction}
        note={<>
          A row per {across} group, a column per {column} group. A square is log2 of the {unit}s observed over those expected had
          the group the overall mix: red where there are more, blue where there are fewer. A dot marks a pair that differs by a
          chi-square test (adjusted p &lt; {SIGNIFICANCE.padj}); a blank square expects under {MIN_EXPECTED} {unit}s, too few to
          test. The test counts each {unit} as independent, and neighboring {unit}s are alike, so on a large section most visible
          differences pass: the shade is the size of the difference.
        </>}>
        <div className="task-chart" style={{ width: heatW + 2 }}>
          <Heatmap rows={rows} columns={columns} values={tests.enrichment} marked={marked} width={heatW} label={`${column} across ${across}, observed over expected`} />
        </div>
      </Section>
      <Section title="Every pair" actions={<DownloadCsv name={`${column} across ${across}`} rows={pairs} columns={tableColumns} />}
        note={`Each pair's ${unit}s as a share of its ${across} group (what its bar shows) and of its ${column} group (how much of that group is there), the ${unit}s expected from the overall mix, and the test.`}>
        <ResultTable rows={pairs} rowKey={(r) => JSON.stringify([r.across, r.group])} columns={tableColumns} />
      </Section>
    </div>
  );
}

/** Keep a chart over this result as a figure, and say once it is kept. */
function SaveFigure({ save }: { save: () => Promise<void> }) {
  const [state, setState] = useState<'saving' | 'saved' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async () => {
    setState('saving');
    setProblem(null);
    try {
      await save();
      setState('saved');
    } catch (e) {
      setState(null);
      setProblem(describeError(e));
    }
  };
  return (
    <span className="button-row">
      {problem && <span className="notice notice-danger">{problem}</span>}
      <button type="button" className="button button-small" disabled={state !== null} onClick={() => void run()}>
        {state === 'saved' ? 'Saved as a figure' : 'Save as a figure'}
      </button>
    </span>
  );
}

export default function CompositionReport({ result, table, wb, handle, unit, width }: ReportProps) {
  const { column, across, groups, columns, left_out: leftOut } = result.meta.summary as CompositionSummary;
  const { session } = useStudio();
  const displays = useDisplays(wb.key, wb.handle);
  const field = `obs:${column}`;
  const { key } = useColorKey(field, wb.dataVersions[field] ?? 0, displays.spatial?.encoding.category_colors?.[field]);
  const colors = useMemo(() => {
    const byLabel = new Map(key?.kind === 'categorical' ? key.items.map((i) => [i.label, i.color]) : []);
    return groups.map((g) => byLabel.get(g) ?? NO_COLOR);
  }, [key, groups]);
  const cross = useMemo((): CrossTable => ({ rows: table.index, columns: groups, counts: matrixOf(table, columns) }), [table, groups, columns]);
  const total = cross.counts.reduce((a, b) => a + b, 0);
  const tablePath = (name: string) => [...result.path, name].join('/');
  const save = (title: string, caption: string, chart: ChartSpec) => async () => {
    await keepFigure(wb.key, handle.tableKey, {
      title, caption, created_by: session?.displayName ?? '', view: { kind: 'chart', chart },
      width_mm: (groups.length > 12 ? SIZE_PRESETS.double : SIZE_PRESETS.single).widthMm,
    });
  };
  return (
    <CompositionSections table={cross} colors={colors} column={column} across={across} leftOut={leftOut} unit={unit} width={width}
      barsAction={<SaveFigure save={save(
        result.meta.title,
        `A bar per ${across} group, split into the share of its ${unit}s in each ${column} group, with its number of ${unit}s; Overall is all ${formatCount(total)} ${unit}s counted.`,
        { type: 'composition', result: tablePath('table'), segments: columns, colors, unit },
      )} />}
      heatmapAction={<SaveFigure save={save(
        `${result.meta.title}, observed over expected`,
        `log2 of the ${unit}s of each ${column} group observed in each ${across} group over those expected from the overall mix. Dots: adjusted p < ${SIGNIFICANCE.padj} by a chi-square test of each pair (2 × 2, ${unit}s counted as independent), Benjamini–Hochberg adjusted. Blank: under ${MIN_EXPECTED} ${unit}s expected, not tested.`,
        { type: 'heatmap', result: tablePath('enrichment'), marks: { result: tablePath('pval_adj'), below: SIGNIFICANCE.padj } },
      )} />} />
  );
}
