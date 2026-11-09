// How the cells divide among the groups of the color field: one bar per group, largest
// first, drawn across the view. Counted across the groups of another column, it shows how
// each of those is made up instead, and keeps that as a report.
import { useMemo, useRef, useState } from 'react';
import { arrowToColorSource, buildColorLegend, colorByLabel, useArrowField } from '@cirrobio/spatial-viewer';
import { crossTabulate, MIN_EXPECTED, testComposition } from '../analysis/composition';
import { useStudio } from '../app/studio';
import { formatCount } from '../app/ui';
import { describeError } from '../cirro/session';
import { CompositionSections, type CompositionSummary } from '../reports/CompositionReport';
import { NO_COLOR, openReport } from '../reports/parts';
import { keepResult, storableNames, type KeptTable } from '../reports/store';
import { useSize } from '../lib/useSize';
import type { Workbench } from '../workbench/workbench';
import { useColorKey, type ColorKey } from './useColorField';

const MAX_BARS = 24;
const PAD = 24;
// Room after each bar for its count and share.
const VALUE_W = 96;
const MAX_CHART_W = 720;

export function Composition({ field, overrides, across, wb, unit }: {
  field: string | null; overrides?: Record<string, string>; across: string | null; wb: Workbench; unit: string;
}) {
  const { key, loading, error } = useColorKey(field, wb.dataVersions[field ?? ''] ?? 0, overrides);
  const ref = useRef<HTMLDivElement>(null);
  const { width, height } = useSize(ref);
  // The measured box is always mounted: useSize measures what is there when it first runs.
  const note = !field ? 'Choose a group to color by, and its composition shows here.'
    : error ? `“${colorByLabel(field)}” couldn't be read: ${error}`
    : !key && loading ? 'Reading…'
    : key?.kind === 'too-many-categories' ? `“${colorByLabel(field)}” has ${formatCount(key.count)} groups, too many to color (limit ${key.limit}).`
    // A numeric field with no values at all has no key either.
    : key?.kind !== 'categorical' ? `“${colorByLabel(field)}” holds values, not groups. Color by a group to see its composition.`
    : across && `obs:${across}` === field ? `The tissue is colored by “${across}”, the column the counts are across. Color by another group to compare.`
    : null;
  if (note !== null || key?.kind !== 'categorical') {
    return <div className="sheet sheet-fill"><div className="composition" ref={ref}><p className="lens-empty muted">{note}</p></div></div>;
  }
  if (across) return <CompositionAcross colorKey={key} across={across} wb={wb} unit={unit} />;
  const items = [...key.items].sort((a, b) => b.count - a.count).slice(0, MAX_BARS);
  const total = key.items.reduce((s, i) => s + i.count, 0) || 1;
  const chartW = Math.min(MAX_CHART_W, width - 2 * PAD);
  const barH = Math.min(22, (height - 2 * PAD) / Math.max(items.length, 1));
  const max = items[0]?.count || 1;
  const labelW = Math.min(160, chartW * 0.3);
  return (
    <div className="sheet sheet-fill">
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
    </div>
  );
}

type Groups = { codes: Int32Array; categories: string[] } | { problem: string } | null;

/** A column's groups, as the tissue would color them: null until read, or why they can't
 * be counted. The codes are the reader's own array, counted here and never handed on as a
 * prop. */
function useGroups(field: string, version: number): Groups {
  const { table, error } = useArrowField(field, version);
  return useMemo(() => {
    if (error) return { problem: error };
    const source = arrowToColorSource(table);
    if (!source) return null;
    if (source.kind !== 'categorical') return { problem: 'it holds values, not groups' };
    const legend = buildColorLegend(source, undefined);
    if (legend?.kind === 'too-many-categories') return { problem: `it has ${formatCount(legend.count)} groups, more than ${legend.limit}` };
    return { codes: source.codes, categories: source.categories };
  }, [table, error]);
}

function CompositionAcross({ colorKey, across, wb, unit }: {
  colorKey: Extract<ColorKey, { kind: 'categorical' }>; across: string; wb: Workbench; unit: string;
}) {
  const handle = wb.handle!;
  const { session } = useStudio();
  const column = colorKey.field.slice('obs:'.length);
  const acrossField = `obs:${across}`;
  const counted = useGroups(colorKey.field, wb.dataVersions[colorKey.field] ?? 0);
  const split = useGroups(acrossField, wb.dataVersions[acrossField] ?? 0);
  const cross = useMemo(() => (counted && 'codes' in counted && split && 'codes' in split
    ? crossTabulate(split.codes, split.categories, counted.codes, counted.categories) : null), [counted, split]);
  const colors = useMemo(() => {
    const byLabel = new Map(colorKey.items.map((i) => [i.label, i.color]));
    return cross?.columns.map((g) => byLabel.get(g) ?? NO_COLOR) ?? [];
  }, [colorKey, cross]);
  const about = `How the ${unit}s of each ${across} group divide among the ${column} groups, against the overall mix.`;
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useSize(ref);
  const [keeping, setKeeping] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const keep = async () => {
    if (!cross) return;
    setKeeping(true);
    setProblem(null);
    try {
      const tests = testComposition(cross);
      const names = storableNames(cross.columns);
      const frame = (m: ArrayLike<number>): KeptTable => ({
        index: cross.rows,
        columns: Object.fromEntries(names.map((name, j) => [name, Float64Array.from(cross.rows, (_, i) => m[i * names.length + j])])),
      });
      const summary: CompositionSummary = { column, across, groups: cross.columns, columns: names, left_out: cross.leftOut };
      const kept = await keepResult(wb.key, handle.tableKey, { table: frame(cross.counts), enrichment: frame(tests.enrichment), pval_adj: frame(tests.padj) }, {
        kind: 'composition',
        title: `${column} across ${across}`,
        method: 'Chi-square test of each pair against the rest (2 × 2, no continuity correction), Benjamini–Hochberg adjusted',
        about,
        parameters: { groupby: column, across, min_expected: MIN_EXPECTED },
        summary,
      }, session?.displayName ?? '');
      openReport(kept.id);
    } catch (e) {
      setProblem(describeError(e));
      setKeeping(false);
    }
  };

  // The counted column already passed as the tissue's color; only the other can fail here.
  const note = split && 'problem' in split ? `“${across}” can't be counted across: ${split.problem}.`
    : !cross ? 'Reading…'
    : !cross.rows.length ? `No ${unit} has a group in both “${column}” and “${across}”.`
    : cross.rows.length < 2 ? `Every ${unit} counted is in one ${across} group, ${cross.rows[0]}, so there is nothing to compare it with.`
    : null;
  return (
    <div className="sheet sheet-report">
      <div className="report" ref={ref}>
        <header className="report-head">
          <div className="report-title">
            <h2>{column} across {across}</h2>
            <p className="muted">{about}</p>
          </div>
          <div className="report-actions">
            <button type="button" className="button" disabled={!cross || note !== null || keeping} onClick={() => void keep()}>Keep as a report</button>
          </div>
        </header>
        {problem && <p className="notice notice-danger">{problem}</p>}
        {note !== null ? <p className="muted">{note}</p> : cross && width > 0 && (
          <CompositionSections table={cross} colors={colors} column={column} across={across} leftOut={cross.leftOut} unit={unit} width={width} />
        )}
      </div>
    </div>
  );
}
