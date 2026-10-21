// The report of a comparison between two groups: their sizes and how many genes differ,
// the volcano beside where each group is on the tissue, then each side's strongest genes
// (each side's set to score), and the full table.
import { useEffect, useMemo, useState } from 'react';
import { useStudio } from '../app/studio';
import { formatCount } from '../app/ui';
import { BarList } from '../charts/BarList';
import { TissueThumb, type Paint } from '../charts/TissueThumb';
import { SIGNIFICANCE, Volcano } from '../charts/Volcano';
import { describeError } from '../cirro/session';
import { SIZE_PRESETS } from '../figures/layout';
import { keepFigure } from '../figures/spec';
import { useDisplays } from '../item/displayState';
import { readGroups } from '../tasks/data';
import { FORMATS, ResultTable, type GroupSpec } from '../tasks/parts';
import { storeOf } from '../workbench/workbench';
import { FullTable, GENE_SET_SIZE, geneValues, pct, ScoreGenes, Section, showOnTissue, Stats, useMatrix, useTissue } from './parts';
import type { ReportProps } from './ReportView';
import { geneTestsOf, readResultTable } from './store';

export type CompareSide = { label: string; size: number; group: GroupSpec };
export type CompareSummary = {
  a: CompareSide;
  b: CompareSide;
  genes_tested: number;
  cutoffs: { padj: number; logfc: number };
};

// Cirro's teal and plum, for the two sides.
const SIDE_COLORS = ['#0e7ca0', '#894073'];
const SHOWN = 12;
const THUMB_W = 150;


export default function CompareReport({ result, table, wb, handle, unit, width }: ReportProps) {
  const { a, b, genes_tested: genesTested, cutoffs } = result.meta.summary as CompareSummary;
  const { session } = useStudio();
  const displays = useDisplays(wb.key, wb.handle);
  const tissue = useTissue(wb, displays.spatial?.encoding.coords ?? 'obsm:spatial');
  const matrix = useMatrix(wb);
  const tests = useMemo(() => geneTestsOf(table), [table]);
  const higher = useMemo(() => {
    const passing = tests.filter((t) => t.padj < cutoffs.padj && Math.abs(t.logfc) >= cutoffs.logfc);
    return [
      passing.filter((t) => t.logfc > 0).sort((x, y) => y.score - x.score),
      passing.filter((t) => t.logfc < 0).sort((x, y) => x.score - y.score),
    ];
  }, [tests, cutoffs.padj, cutoffs.logfc]);
  const [picked, setPicked] = useState<string | null>(null);
  const values = useMemo(() => (picked && matrix ? geneValues(matrix, picked) : null), [picked, matrix]);

  // Which side each cell was on: 1 for the first, 2 for the second. A side drawn on the
  // tissue was kept with the result; a side from a column is read as the column is now.
  const [sides, setSides] = useState<Uint8Array | null>(null);
  useEffect(() => {
    let live = true;
    const n = handle.fields.n_obs;
    const mark = async () => {
      const out = new Uint8Array(n);
      const selected = a.group.kind === 'selection' || b.group.kind === 'selection'
        ? await readResultTable(storeOf(wb.key), handle.tableKey, result, 'cells') : null;
      for (const [side, s] of [[1, a], [2, b]] as const) {
        if (s.group.kind === 'category') {
          const { codes, categories } = await readGroups(handle, s.group.column);
          const code = categories.indexOf(s.group.category);
          for (let c = 0; c < n; c++) if (codes[c] === code && !out[c]) out[c] = side;
        } else if (s.group.kind === 'selection' && selected) {
          const which = selected.columns.side as ArrayLike<number>;
          selected.index.forEach((cell, i) => { if (which[i] === side) out[Number(cell)] = side; });
        }
      }
      if (b.group.kind === 'rest') for (let c = 0; c < n; c++) if (!out[c]) out[c] = 2;
      return out;
    };
    // Without them the report draws no maps of the two sides.
    mark().then((m) => live && setSides(m), () => undefined);
    return () => {
      live = false;
    };
  }, [wb.key, handle, result, a, b]);

  const [figure, setFigure] = useState<'saving' | 'saved' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const saveFigure = async () => {
    setFigure('saving');
    setProblem(null);
    try {
      await keepFigure(wb.key, handle.tableKey, {
        title: result.meta.title,
        caption: `Genes compared between ${a.label} (${formatCount(a.size)} ${unit}s) and ${b.label} (${formatCount(b.size)}): Wilcoxon rank-sum, Benjamini–Hochberg adjusted. Dashed lines: adjusted p = ${cutoffs.padj} and |log2 fold change| = ${cutoffs.logfc}.`,
        created_by: session?.displayName ?? '',
        view: { kind: 'chart', chart: { type: 'volcano', result: [...result.path, 'table'].join('/'), labels: SIGNIFICANCE.labels, ...cutoffs } },
        width_mm: SIZE_PRESETS.single.widthMm,
      });
      setFigure('saved');
    } catch (e) {
      setFigure(null);
      setProblem(describeError(e));
    }
  };

  const volcanoW = Math.min(640, width - THUMB_W - 40);
  const thumbs: { label: string; paint: Paint | null }[] = [
    { label: `Where ${a.label} is`, paint: sides ? { kind: 'group', member: (c) => sides[c] === 1, color: SIDE_COLORS[0] } : null },
    { label: `Where ${b.label} is`, paint: sides ? { kind: 'group', member: (c) => sides[c] === 2, color: SIDE_COLORS[1] } : null },
    ...(values ? [{ label: `${picked}, log1p`, paint: { kind: 'values' as const, values } }] : []),
  ];
  return (
    <div className="report-body">
      <Stats stats={[
        { label: a.label, value: a.size, note: `${unit}s` },
        { label: b.label, value: b.size, note: `${unit}s` },
        { label: 'Genes tested', value: genesTested },
        { label: `Higher in ${a.label}`, value: higher[0].length, note: `adj. p < ${cutoffs.padj}, log2FC ≥ ${cutoffs.logfc}` },
        { label: `Higher in ${b.label}`, value: higher[1].length },
      ]} />
      <Section title="Every gene"
        note={`Right of zero, higher in ${a.label}; left, higher in ${b.label}. Higher up, more certain. Pick a gene to map it.`}
        actions={(
          <button type="button" className="button button-small" disabled={figure !== null} onClick={() => void saveFigure()}>
            {figure === 'saved' ? 'Saved as a figure' : 'Save the volcano as a figure'}
          </button>
        )}>
        {problem && <p className="notice notice-danger">{problem}</p>}
        <div className="report-row">
          {volcanoW > 200 && (
            <div className="task-chart" style={{ width: volcanoW }}>
              <Volcano points={tests} cutoffs={{ ...cutoffs, labels: SIGNIFICANCE.labels }} width={volcanoW - 2} height={Math.round(volcanoW * 0.7)}
                onPick={setPicked} picked={picked} />
            </div>
          )}
          {tissue && (
            <div className="report-thumbs">
              {thumbs.map((t) => t.paint && (
                <figure key={t.label} className="group-card-thumb">
                  <TissueThumb tissue={tissue} paint={t.paint} width={THUMB_W} label={t.label} />
                  <figcaption className="muted">{t.label}</figcaption>
                </figure>
              ))}
              {picked && <button type="button" className="link-button" onClick={() => showOnTissue(wb.key, `X:${picked}`)}>Show {picked} on the tissue</button>}
            </div>
          )}
        </div>
      </Section>
      <div className="report-columns">
        {([a, b] as const).map((side, i) => {
          const genes = higher[i];
          const set = genes.slice(0, GENE_SET_SIZE).map((t) => t.gene);
          return (
            <Section key={side.label + i} title={`Higher in ${side.label}`}
              note={genes.length ? `${formatCount(genes.length)} genes, strongest first: log2 fold change, and the share of each side's ${unit}s that express it.` : 'No gene passes the cutoffs.'}>
              {genes.length > 0 && (
                <BarList width={Math.min(460, (width - 24) / 2)} label={`Genes higher in ${side.label}`} picked={picked}
                  onPick={(bar) => setPicked(bar.label)}
                  bars={genes.slice(0, SHOWN).map((t) => ({
                    label: t.gene, value: Math.abs(t.logfc), color: SIDE_COLORS[i],
                    note: `${FORMATS.num(Math.abs(t.logfc))} · ${pct(i === 0 ? t.fracA : t.fracB)} vs ${pct(i === 0 ? t.fracB : t.fracA)}`,
                  }))} />
              )}
              {set.length > 0 && (
                <ScoreGenes wb={wb} handle={handle} genes={set} name={`${side.label}_higher`}
                  note={`score of the top ${set.length} genes higher in ${side.label} than ${i === 0 ? b.label : a.label}`}
                  label={`Score the top ${set.length} as a gene set`} />
              )}
            </Section>
          );
        })}
      </div>
      <Section title="All results">
        <FullTable count={tests.length}>
          <ResultTable rows={tests} rowKey={(t) => t.gene} onPick={(t) => setPicked(t.gene)} picked={picked}
            columns={[
              { key: 'gene', label: 'Gene' }, { key: 'logfc', label: 'log2FC', format: FORMATS.num },
              { key: 'padj', label: 'Adj. p', format: FORMATS.p }, { key: 'fracA', label: a.label, format: FORMATS.pct },
              { key: 'fracB', label: b.label, format: FORMATS.pct },
            ]} />
        </FullTable>
      </Section>
    </div>
  );
}
