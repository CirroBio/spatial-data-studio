// The report of a spatially-variable-gene run: how many genes have a spatial pattern and
// the strongest, the strongest genes' maps side by side, the patterns the strongest fall
// into (each a gene set to score), every gene ranked, and the full table.
import { useEffect, useMemo, useState } from 'react';
import type { CheckpointHandle, ExpressionMatrix } from '@cirrobio/spatial-viewer';
import { binnedMap, whereHigh } from '../analysis/patterns';
import { formatCount, formatDate, plural } from '../app/ui';
import { BarList } from '../charts/BarList';
import { Histogram } from '../charts/Histogram';
import { TissueThumb, type Paint, type Tissue } from '../charts/TissueThumb';
import { describeError } from '../cirro/session';
import { FORMATS, ResultTable } from '../tasks/parts';
import { storeOf, type Workbench } from '../workbench/workbench';
import { FullTable, GENE_SET_SIZE, geneValues, ScoreGenes, Section, showOnTissue, Stats, useMatrix, useTissue } from './parts';
import type { ReportProps } from './ReportView';
import { GENE_TEST_COLUMN, readResultTable, type KeptResult } from './store';

export type MoranSummary = {
  // The positions the neighbors were found in.
  coordinates: string;
  neighbors: number;
  min_cells: number;
  genes_tested: number;
  // A gene has a spatial pattern below this adjusted p, with I above 0.
  cutoff: { padj: number };
  // How the strongest `genes` of those were grouped into `count` patterns.
  patterns: { count: number; genes: number; grid: number; min_correlation: number; min_genes: number };
};

type MoranRow = { gene: string; I: number; z: number; padj: number; pattern: number };

const GALLERY = 12;
const GALLERY_MIN_W = 150;
const GALLERY_GAP = 12;
const RANKED = 25;
const SHOWN = 5;
const THUMB_W = 132;
const SIDE_W = 340;

const patternName = (p: number) => `pattern ${p + 1}`;

/** Each cell's mean of the genes' log1p expression. */
function meanValues(matrix: ExpressionMatrix, genes: string[]): Float32Array {
  const mean = new Float32Array(matrix.nCells);
  for (const gene of genes) {
    const values = geneValues(matrix, gene);
    if (values) for (let c = 0; c < mean.length; c++) mean[c] += values[c] / genes.length;
  }
  return mean;
}

/** A per-cell value on the section as the patterns compared it, binned on their grid: one
 * cell's expression is mostly zeros, its bin's mean shows where the gene is. */
function GeneThumb({ tissue, values, grid, width, label }: {
  tissue: Tissue | null; values: ArrayLike<number> | null; grid: number; width: number; label: string;
}) {
  const paint = useMemo((): Paint | null => (values && tissue ? { kind: 'values', values: binnedMap(values, tissue, grid) } : null), [values, tissue, grid]);
  return tissue && paint ? <TissueThumb tissue={tissue} paint={paint} width={width} label={label} />
    : <span className="thumb-empty" style={{ display: 'block', width, height: width }} />;
}

function PatternCard({ wb, handle, result, pattern, genes, tissue, grid, matrix }: {
  wb: Workbench; handle: CheckpointHandle; result: KeptResult; pattern: number; genes: MoranRow[];
  tissue: Tissue | null; grid: number; matrix: ExpressionMatrix | null;
}) {
  const [gene, setGene] = useState<string | null>(null);
  const mean = useMemo(() => (matrix ? meanValues(matrix, genes.map((g) => g.gene)) : null), [matrix, genes]);
  const picked = useMemo(() => (gene && matrix ? geneValues(matrix, gene) : null), [gene, matrix]);
  const where = useMemo(() => (mean && tissue ? whereHigh(mean, tissue) : null), [mean, tissue]);
  const [top] = genes;
  const set = genes.slice(0, GENE_SET_SIZE).map((g) => g.gene);
  const name = patternName(pattern);
  const pick = (g: string) => setGene(gene === g ? null : g);
  return (
    <article className="group-card">
      <header className="group-card-head">
        <h4>Pattern {pattern + 1}</h4>
        <span className="muted">{plural(genes.length, ['gene', 'genes'])}</span>
      </header>
      <div className="group-card-body">
        <figure className="group-card-thumb">
          <GeneThumb tissue={tissue} values={picked ?? mean} grid={grid} width={THUMB_W} label={gene ? `${gene} on the tissue` : `The mean map of ${name}`} />
          <figcaption className="muted">{gene ?? 'Mean of its genes'}</figcaption>
        </figure>
        <table className="marker-mini">
          <thead><tr><th>Gene</th><th>Moran's I</th><th>Adj. p</th></tr></thead>
          <tbody>
            {genes.slice(0, SHOWN).map((g) => (
              <tr key={g.gene} aria-selected={gene === g.gene}>
                <td><button type="button" className="link-button" onClick={() => pick(g.gene)}>{g.gene}</button></td>
                <td>{FORMATS.num(g.I)}</td>
                <td>{FORMATS.p(g.padj)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {genes.length > SHOWN && (
        <p className="group-card-text">
          <span className="muted">Also </span>
          {genes.slice(SHOWN).map((g, i) => (
            <span key={g.gene}>
              {i > 0 && ', '}
              <button type="button" className="link-button" aria-pressed={gene === g.gene} onClick={() => pick(g.gene)}>{g.gene}</button>
            </span>
          ))}
        </p>
      )}
      <p className="group-card-text">
        {plural(genes.length, ['gene', 'genes'])}, strongest <strong>{top.gene}</strong> (I = {FORMATS.num(top.I)}){where ? `; ${where}` : ''}.
      </p>
      <div className="group-card-actions">
        <ScoreGenes wb={wb} handle={handle} genes={set} name={`pattern_${pattern + 1}_score`}
          note={`score of the ${set.length < genes.length ? 'top ' : ''}${set.length} genes of ${name} in “${result.meta.title}” (${formatDate(result.meta.created_at)})`}
          label={set.length < genes.length ? `Score its top ${set.length} genes` : `Score its ${set.length} genes`} />
        {gene && <button type="button" className="link-button" onClick={() => showOnTissue(wb.key, `X:${gene}`)}>Show {gene} on the tissue</button>}
      </div>
    </article>
  );
}

export default function MoranReport({ result, table, wb, handle, unit, width }: ReportProps) {
  const summary = result.meta.summary as MoranSummary;
  const { cutoff, patterns } = summary;
  const tissue = useTissue(wb, summary.coordinates);
  const matrix = useMatrix(wb);
  const [problem, setProblem] = useState<string | null>(null);

  // Each grouped gene's pattern, kept beside the main table; null while it is read.
  const [patternOf, setPatternOf] = useState<Map<string, number> | null>(() => (patterns.genes ? null : new Map()));
  useEffect(() => {
    if (!patterns.genes) return;
    let live = true;
    readResultTable(storeOf(wb.key), handle.tableKey, result, 'patterns').then((df) => {
      const labels = df.columns.pattern as ArrayLike<number>;
      if (live) setPatternOf(new Map(df.index.map((g, i) => [g, labels[i]])));
    }, (e: unknown) => live && setProblem(describeError(e)));
    return () => {
      live = false;
    };
  }, [wb.key, handle.tableKey, result, patterns.genes]);

  // Kept highest I first.
  const rows = useMemo((): MoranRow[] => {
    const [I, z, padj] = ['I', 'z', GENE_TEST_COLUMN.padj].map((c) => table.columns[c] as ArrayLike<number>);
    return table.index.map((gene, i) => ({ gene, I: I[i], z: z[i], padj: padj[i], pattern: patternOf?.get(gene) ?? -1 }));
  }, [table, patternOf]);
  const spatial = useMemo(() => rows.filter((r) => r.padj < cutoff.padj && r.I > 0), [rows, cutoff.padj]);
  const groups = useMemo(() => Array.from({ length: patterns.count }, (_, p) => rows.filter((r) => r.pattern === p)), [rows, patterns.count]);
  const top = spatial[0] ?? rows[0];

  const gallery = useMemo(
    () => spatial.slice(0, GALLERY).map((r) => ({ row: r, values: matrix ? geneValues(matrix, r.gene) : null })),
    [spatial, matrix],
  );
  const cols = Math.max(2, Math.min(6, Math.floor((width + GALLERY_GAP) / (GALLERY_MIN_W + GALLERY_GAP))));
  const galleryW = Math.floor((width - (cols - 1) * GALLERY_GAP) / cols);

  const [picked, setPicked] = useState<string | null>(null);
  const pickedValues = useMemo(() => (picked && matrix ? geneValues(matrix, picked) : null), [picked, matrix]);
  const allI = useMemo(() => Float64Array.from(rows, (r) => r.I), [rows]);
  const weakest = spatial[spatial.length - 1];
  const barsW = width - SIDE_W - 24 >= 320 ? width - SIDE_W - 24 : width;
  const inPattern = (r: MoranRow) => (r.pattern >= 0 ? ` · ${patternName(r.pattern)}` : '');

  return (
    <div className="report-body">
      <Stats stats={[
        { label: 'Genes tested', value: summary.genes_tested, note: `detected in ${summary.min_cells}+ ${unit}s` },
        { label: 'With a spatial pattern', value: spatial.length, note: `adj. p < ${cutoff.padj}, I > 0` },
        { label: 'Strongest', value: top ? top.gene : '—', note: top ? `Moran's I ${FORMATS.num(top.I)}` : undefined },
        { label: 'Gene patterns', value: patterns.count, note: `among the top ${formatCount(patterns.genes)} genes` },
        { label: 'Neighbors', value: summary.neighbors, note: `nearest ${unit}s, in ${summary.coordinates}` },
      ]} />
      {problem && <p className="notice notice-danger">{problem}</p>}
      <Section title="The strongest on the tissue"
        note={gallery.length
          ? `The ${gallery.length} genes with the highest Moran's I, each colored by its mean expression (log1p) in each square of a ${patterns.grid} × ${patterns.grid} grid over the section, from dark for none to yellow for the most. Click one to color the tissue by it.`
          : 'No gene has a spatial pattern at this cutoff.'}>
        {gallery.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, ${galleryW}px)`, gap: GALLERY_GAP, alignItems: 'start' }}>
            {gallery.map(({ row, values }) => (
              <figure key={row.gene} className="group-card-thumb">
                <button type="button" className="link-button" aria-label={`Color the tissue by ${row.gene}`} onClick={() => showOnTissue(wb.key, `X:${row.gene}`)}>
                  <GeneThumb tissue={tissue} values={values} grid={patterns.grid} width={galleryW} label={`${row.gene} on the tissue`} />
                </button>
                <figcaption><strong>{row.gene}</strong> <span className="muted">I = {FORMATS.num(row.I)}{inPattern(row)}</span></figcaption>
              </figure>
            ))}
          </div>
        )}
      </Section>
      <Section title="Gene patterns"
        note={patterns.count
          ? `The top ${formatCount(patterns.genes)} genes with a spatial pattern, grouped by how alike their maps are: the maps of a pattern's genes correlate ${patterns.min_correlation} or more on average. A card's map is the mean of its genes; pick a gene to see its own. Scoring a pattern adds a column you can color the tissue by.`
          : `None of the top ${formatCount(patterns.genes)} genes with a spatial pattern has a map like ${patterns.min_genes - 1} others'.`}>
        {patterns.count > 0 && !patternOf && <p className="muted">Reading the patterns…</p>}
        {patterns.count > 0 && patternOf && (
          <div className="group-cards">
            {groups.map((genes, p) => (
              <PatternCard key={p} wb={wb} handle={handle} result={result} pattern={p} genes={genes} tissue={tissue} grid={patterns.grid} matrix={matrix} />
            ))}
          </div>
        )}
      </Section>
      <Section title="Every gene, ranked"
        note={`The ${RANKED} genes with the highest Moran's I, and how I spreads over all ${formatCount(rows.length)} genes tested${weakest ? `; those from the dashed line up (I ≥ ${FORMATS.num(weakest.I)}) have adjusted p < ${cutoff.padj}` : ''}. Pick a gene to map it.`}>
        <div className="report-row">
          <BarList width={barsW} label="Genes by Moran's I" picked={picked} onPick={(bar) => setPicked(bar.label)}
            bars={rows.slice(0, RANKED).map((r) => ({
              label: r.gene, value: Math.max(0, r.I),
              color: r.padj < cutoff.padj && r.I > 0 ? undefined : 'var(--sds-color-text-muted)',
              note: `${FORMATS.num(r.I)}${inPattern(r)}`,
            }))} />
          <div className="report-thumbs">
            <Histogram values={allI} threshold={weakest?.I} width={SIDE_W} height={170} label="Moran's I across every gene tested" axis="Moran's I" unit={['gene', 'genes']} />
            {picked && (
              <figure className="group-card-thumb">
                <GeneThumb tissue={tissue} values={pickedValues} grid={patterns.grid} width={180} label={`${picked} on the tissue`} />
                <figcaption>
                  <span className="muted">{picked} · </span>
                  <button type="button" className="link-button" onClick={() => showOnTissue(wb.key, `X:${picked}`)}>Show it on the tissue</button>
                </figcaption>
              </figure>
            )}
          </div>
        </div>
      </Section>
      <Section title="All results">
        <FullTable count={rows.length}>
          <ResultTable rows={rows} rowKey={(r) => r.gene} onPick={(r) => showOnTissue(wb.key, `X:${r.gene}`)}
            columns={[
              { key: 'gene', label: 'Gene' }, { key: 'I', label: "Moran's I", format: FORMATS.num },
              { key: 'z', label: 'z', format: FORMATS.num }, { key: 'padj', label: 'Adj. p', format: FORMATS.p },
              { key: 'pattern', label: 'Pattern', format: (p) => (p < 0 ? '—' : String(p + 1)) },
            ]} />
        </FullTable>
      </Section>
    </div>
  );
}
