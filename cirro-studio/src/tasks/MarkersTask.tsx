// Marker genes: each group of a column against all the other cells (Wilcoxon, as scanpy's
// rank_genes_groups), every group in one pass over the matrix. The run is kept with the
// data and opens as its report.
import { useState } from 'react';
import { useStudio } from '../app/studio';
import { SIGNIFICANCE } from '../charts/Volcano';
import { describeError } from '../cirro/session';
import type { MarkersSummary } from '../reports/MarkersReport';
import { openReport } from '../reports/parts';
import { geneTestColumns, keepResult } from '../reports/store';
import { readGroups, readMatrix } from './data';
import { ColumnSelect, JobStatus } from './parts';
import type { TaskProps } from './TaskPanel';
import { useJob } from './useJob';

// More groups than this is a column of identifiers, not of groups.
const MAX_GROUPS = 200;

export default function MarkersTask({ wb, unit }: TaskProps) {
  const handle = wb.handle!;
  const { session } = useStudio();
  const [column, setColumn] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const job = useJob();

  const run = async () => {
    setProblem(null);
    try {
      const obs = await readGroups(handle, column);
      if (obs.categories.length > MAX_GROUPS) throw new Error(`“${column}” has ${obs.categories.length} groups; that looks like an identifier column.`);
      const matrix = await readMatrix(wb.key, handle);
      const tests = await job.run('markersForAll', { matrix, codes: obs.codes, nGroups: obs.categories.length });
      if (!tests) return;
      const sizes = obs.categories.map(() => 0);
      for (const c of obs.codes) if (c >= 0) sizes[c] += 1;
      // Long format, one row per group and gene: the shape scanpy's rank_genes_groups_df gives.
      const rows = tests.flatMap((ts, g) => ts.map((t) => ({ group: obs.categories[g], t })));
      const summary: MarkersSummary = { groups: obs.categories, sizes, genes_tested: matrix.genes.length, cutoffs: { padj: SIGNIFICANCE.padj, logfc: SIGNIFICANCE.logfc } };
      const kept = await keepResult(wb.key, handle.tableKey, {
        table: {
          index: rows.map((r) => `${r.group}:${r.t.gene}`),
          columns: { group: rows.map((r) => r.group), gene: rows.map((r) => r.t.gene), ...geneTestColumns(rows.map((r) => r.t)) },
        },
      }, {
        kind: 'markers',
        title: `Marker genes of ${column}`,
        method: 'Wilcoxon rank-sum test, tie-corrected, Benjamini–Hochberg adjusted',
        about: `Each ${column} group against every other ${unit}.`,
        parameters: { groupby: column, reference: 'rest' },
        summary,
      }, session?.displayName ?? '');
      openReport(kept.id);
    } catch (e) {
      setProblem(describeError(e));
    }
  };

  return (
    <div className="task-body">
      <p className="muted">Tests every gene in each group against all the other {unit}s, and opens what sets each group apart as a report.</p>
      <ColumnSelect handle={handle} value={column} onChange={setColumn} label="Groups" />
      <JobStatus job={job} label="Testing every gene in every group" />
      {problem && <p className="notice notice-danger">{problem}</p>}
      <button type="button" className="button button-primary" disabled={!column || job.running} onClick={() => void run()}>Find marker genes</button>
    </div>
  );
}
