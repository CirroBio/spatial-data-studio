// The report of a marker-gene run: how many groups and how many of them have markers,
// every group's top markers in one dot plot, then a card per group (its size, where its
// cells are, what marks it, and its markers as a gene set to score), and the full table.
import { useEffect, useMemo, useState } from 'react';
import type { GeneTest } from '../analysis/rankGenes';
import { formatCount, plural } from '../app/ui';
import { DotPlot } from '../charts/DotPlot';
import { TissueThumb, type Paint, type Tissue } from '../charts/TissueThumb';
import { useDisplays } from '../item/displayState';
import { useColorKey } from '../item/useColorField';
import { readGroups } from '../tasks/data';
import { FORMATS, ResultTable } from '../tasks/parts';
import type { Workbench } from '../workbench/workbench';
import { FullTable, GENE_SET_SIZE, geneValues, NO_COLOR, pct, ScoreGenes, Section, showOnTissue, Stats, useMatrix, useTissue } from './parts';
import type { ReportProps } from './ReportView';
import { geneTestsOf } from './store';

export type MarkersSummary = {
  groups: string[];
  sizes: number[];
  genes_tested: number;
  cutoffs: { padj: number; logfc: number };
};

const SHOWN_MARKERS = 5;
// More columns than this and the dot plot stops being read at a glance.
const MAX_DOT_GENES = 80;
const THUMB_W = 132;


function GroupCard({ wb, handle, column, label, size, total, color, tests, significant, tissue, member, matrix, unit }: {
  wb: Workbench; handle: ReportProps['handle']; column: string; label: string; size: number; total: number; color: string;
  tests: GeneTest[]; significant: GeneTest[]; tissue: Tissue | null; member: ((c: number) => boolean) | null;
  matrix: ReturnType<typeof useMatrix>; unit: string;
}) {
  const [gene, setGene] = useState<string | null>(null);
  const values = useMemo(() => (gene && matrix ? geneValues(matrix, gene) : null), [gene, matrix]);
  const paint = useMemo((): Paint | null => (values ? { kind: 'values', values } : member ? { kind: 'group', member, color } : null), [values, member, color]);
  // Ranks and means can disagree: a gene can rank high in a group while its mean there is
  // lower. Short of markers, the nearest are the genes that are at least higher here.
  const nearest = significant.length ? significant : tests.filter((t) => t.logfc > 0);
  const top = nearest[0];
  const set = significant.slice(0, GENE_SET_SIZE).map((t) => t.gene);
  const shown = nearest.slice(0, SHOWN_MARKERS);
  return (
    <article className="group-card">
      <header className="group-card-head">
        <span className="swatch" style={{ background: color }} />
        <h4>{label}</h4>
        <span className="muted">{plural(size, [unit, `${unit}s`])} · {((100 * size) / Math.max(total, 1)).toFixed(1)}%</span>
      </header>
      <div className="group-card-body">
        <figure className="group-card-thumb">
          {tissue && paint ? <TissueThumb tissue={tissue} paint={paint} width={THUMB_W} label={gene ? `${gene} on the tissue` : `Where ${label} is`} />
            : <div className="thumb-empty" style={{ width: THUMB_W, height: THUMB_W }} />}
          <figcaption className="muted">{gene ? `${gene}, log1p` : `Where its ${unit}s are`}</figcaption>
        </figure>
        <table className="marker-mini">
          <thead><tr><th>Gene</th><th>log2FC</th><th>Here · others</th></tr></thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.gene} aria-selected={gene === t.gene}>
                <td><button type="button" className="link-button" onClick={() => setGene(gene === t.gene ? null : t.gene)}>{t.gene}</button></td>
                <td>{FORMATS.num(t.logfc)}</td>
                <td>
                  <span className="frac-bars" title={`In ${pct(t.fracA)} of this group's ${unit}s and ${pct(t.fracB)} of the others`}>
                    <span style={{ width: `${100 * t.fracA}%`, background: color }} />
                    <span style={{ width: `${100 * t.fracB}%` }} />
                  </span>
                  {pct(t.fracA)} · {pct(t.fracB)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="group-card-text">
        {significant.length
          ? <>{plural(significant.length, ['gene is', 'genes are'])} higher here. The strongest, <strong>{top.gene}</strong>, is in {pct(top.fracA)} of its {unit}s and {pct(top.fracB)} of the others.</>
          : <>No gene stands out here at these cutoffs{top ? <>; the closest is <strong>{top.gene}</strong> (log2FC {FORMATS.num(top.logfc)})</> : null}.</>}
      </p>
      <div className="group-card-actions">
        {set.length > 0 && (
          <ScoreGenes wb={wb} handle={handle} genes={set} name={`${column}_${label}_markers`}
            note={`score of the top ${set.length} markers of ${column} ${label}`} label={`Score its top ${set.length} markers`} />
        )}
        {gene && <button type="button" className="link-button" onClick={() => showOnTissue(wb.key, `X:${gene}`)}>Show {gene} on the tissue</button>}
      </div>
    </article>
  );
}

export default function MarkersReport({ result, table, wb, handle, unit, width }: ReportProps) {
  const { groups, sizes, genes_tested: genesTested, cutoffs } = result.meta.summary as unknown as MarkersSummary;
  const column = String(result.meta.parameters.groupby);
  const field = `obs:${column}`;
  const displays = useDisplays(wb.key, wb.handle);
  const tissue = useTissue(wb, displays.spatial?.encoding.coords ?? 'obsm:spatial');
  const matrix = useMatrix(wb);
  const { key } = useColorKey(field, wb.dataVersions[field] ?? 0, displays.spatial?.encoding.category_colors?.[field]);
  const colorOf = (label: string) => (key?.kind === 'categorical' ? key.items.find((i) => i.label === label)?.color : undefined) ?? NO_COLOR;

  // The column as it is now, for where each group's cells are.
  const version = wb.dataVersions[field] ?? 0;
  const [codes, setCodes] = useState<{ codes: Int32Array; categories: string[] } | null>(null);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let live = true;
    readGroups(handle, column).then((g) => {
      if (!live) return;
      setCodes(g);
      setStale(g.categories.join('\u0000') !== groups.join('\u0000'));
    }, () => live && setStale(true));
    return () => {
      live = false;
    };
  }, [handle, column, groups, version]);

  const byGroup = useMemo(() => {
    const tests = geneTestsOf(table, table.columns.gene as string[]);
    const of = groups.map(() => [] as GeneTest[]);
    const at = new Map(groups.map((g, i) => [g, i]));
    (table.columns.group as string[]).forEach((g, r) => of[at.get(g)!].push(tests[r]));
    return of;
  }, [table, groups]);
  const significant = useMemo(
    () => byGroup.map((tests) => tests.filter((t) => t.padj < cutoffs.padj && t.logfc >= cutoffs.logfc)),
    [byGroup, cutoffs.padj, cutoffs.logfc],
  );
  const distinct = new Set(significant.flatMap((s) => s.map((t) => t.gene)));
  const total = sizes.reduce((a, b) => a + b, 0);

  // Each group's top markers, two or three apiece, without repeats.
  const dots = useMemo(() => {
    const per = groups.length > 12 ? 2 : 3;
    const genes: string[] = [];
    for (const s of significant) {
      let taken = 0;
      for (const t of s) {
        if (taken === per || genes.length === MAX_DOT_GENES) break;
        if (!genes.includes(t.gene)) {
          genes.push(t.gene);
          taken += 1;
        }
      }
    }
    const lookup = byGroup.map((tests) => new Map(tests.map((t) => [t.gene, t])));
    const fraction = new Float32Array(groups.length * genes.length);
    const mean = new Float32Array(groups.length * genes.length);
    groups.forEach((_, i) => genes.forEach((g, j) => {
      const t = lookup[i].get(g);
      fraction[i * genes.length + j] = t?.fracA ?? 0;
      mean[i * genes.length + j] = t?.meanA ?? 0;
    }));
    return { genes, fraction, mean };
  }, [groups, significant, byGroup]);

  const [focus, setFocus] = useState(0);
  const groupRows = byGroup[focus] ?? [];
  const at = codes ? new Map(codes.categories.map((c, i) => [c, i])) : null;

  return (
    <div className="report-body">
      <Stats stats={[
        { label: 'Groups', value: groups.length, note: `in ${column}` },
        { label: `${unit[0].toUpperCase()}${unit.slice(1)}s`, value: total },
        { label: 'Genes tested', value: genesTested },
        { label: 'Marker genes', value: distinct.size, note: `adj. p < ${cutoffs.padj}, log2FC ≥ ${cutoffs.logfc}` },
        { label: 'Groups with markers', value: `${significant.filter((s) => s.length).length} of ${groups.length}` },
      ]} />
      <Section title="Markers at a glance"
        note={`Each group's strongest markers. A dot's size is the share of the group's ${unit}s that express the gene; its color, the group's mean expression of it, from the gene's lowest group to its highest.`}
        actions={<button type="button" className="button button-small" onClick={() => showOnTissue(wb.key, field)}>Color the tissue by {column}</button>}>
        {dots.genes.length
          ? <DotPlot data={{ groups: groups.map((g) => ({ label: g, color: colorOf(g) })), genes: dots.genes, fraction: dots.fraction, mean: dots.mean }}
              width={width - 2} onPickGene={(g) => showOnTissue(wb.key, `X:${g}`)} />
          : <p className="muted">No group has a gene that passes the cutoffs.</p>}
      </Section>
      <Section title="The groups"
        note={stale ? `${column} has changed since this ran; the maps show it as it is now, where they can.` : `Pick a gene to see it on the thumbnail. A group's gene set is its top ${GENE_SET_SIZE} markers; scoring one adds a column you can color the tissue by.`}>
        <div className="group-cards">
          {groups.map((g, i) => {
            const code = at?.get(g);
            const member = codes && code !== undefined ? (c: number) => codes.codes[c] === code : null;
            return (
              <GroupCard key={g} wb={wb} handle={handle} column={column} label={g} size={sizes[i]} total={total} color={colorOf(g)}
                tests={byGroup[i]} significant={significant[i]} tissue={tissue} member={member} matrix={matrix} unit={unit} />
            );
          })}
        </div>
      </Section>
      <Section title="All results">
        <FullTable count={table.index.length}>
          <label className="field field-inline">
            <span>Group</span>
            <select className="select" value={focus} onChange={(e) => setFocus(Number(e.target.value))}>
              {groups.map((g, i) => <option key={g} value={i}>{g} ({formatCount(byGroup[i].length)})</option>)}
            </select>
          </label>
          <ResultTable rows={groupRows} rowKey={(t) => t.gene} onPick={(t) => showOnTissue(wb.key, `X:${t.gene}`)}
            columns={[
              { key: 'gene', label: 'Gene' }, { key: 'score', label: 'Score', format: FORMATS.num },
              { key: 'logfc', label: 'log2FC', format: FORMATS.num }, { key: 'padj', label: 'Adj. p', format: FORMATS.p },
              { key: 'fracA', label: 'In group', format: FORMATS.pct }, { key: 'fracB', label: 'Others', format: FORMATS.pct },
            ]} />
        </FullTable>
      </Section>
    </div>
  );
}
