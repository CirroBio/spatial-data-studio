// Compare two groups of cells: a Wilcoxon rank-sum test on every gene, as scanpy's
// rank_genes_groups does. Either group can be cells drawn around on the tissue. The run
// is kept with the data and opens as its report.
import { useState } from 'react';
import { useStudio } from '../app/studio';
import { SIGNIFICANCE } from '../charts/Volcano';
import { describeError } from '../cirro/session';
import { useArmedSelection, useSelection } from '../item/selection';
import type { CompareSummary } from '../reports/CompareReport';
import { openReport } from '../reports/parts';
import { geneTestColumns, keepResult, type KeptTable } from '../reports/store';
import { readMatrix } from './data';
import { GroupPicker, groupLabel, JobStatus, membership, type GroupSpec } from './parts';
import type { TaskProps } from './TaskPanel';
import { useJob } from './useJob';

export default function CompareTask({ wb, unit }: TaskProps) {
  const handle = wb.handle!;
  const { session } = useStudio();
  const selection = useSelection(wb.key);
  const [a, setA] = useState<GroupSpec | null>(null);
  const [b, setB] = useState<GroupSpec | null>({ kind: 'rest' });
  // Drawing is on while either group is the cells selected on the tissue, and while the
  // first group is not chosen yet, since drawing around cells is one way to choose it.
  useArmedSelection(wb.key, !a || a.kind === 'selection' || b?.kind === 'selection');
  const [problem, setProblem] = useState<string | null>(null);
  const job = useJob();

  const run = async () => {
    if (!a || !b) return;
    setProblem(null);
    try {
      const members = await membership(handle, a, b, selection.cells);
      let inA = 0;
      let inB = 0;
      for (const m of members) if (m === 1) inA++; else if (m === 2) inB++;
      if (inA < 2 || inB < 2) throw new Error(`Each group needs at least two ${unit}s: ${groupLabel(a)} has ${inA}, ${groupLabel(b)} has ${inB}.`);
      const matrix = await readMatrix(wb.key, handle);
      const rows = await job.run('compareGroups', { matrix, membership: members });
      if (!rows) return;
      const summary: CompareSummary = {
        a: { label: groupLabel(a), size: inA, group: a },
        b: { label: groupLabel(b), size: inB, group: b },
        genes_tested: matrix.genes.length,
        cutoffs: { padj: SIGNIFICANCE.padj, logfc: SIGNIFICANCE.logfc },
      };
      // Cells drawn around on the tissue are kept with the result, so its report can show
      // where they were once the selection has moved on.
      const drawn: Record<string, KeptTable> = {};
      if (a.kind === 'selection' || b.kind === 'selection') {
        const cells: number[] = [];
        members.forEach((m, c) => { if ((m === 1 && a.kind === 'selection') || (m === 2 && b.kind === 'selection')) cells.push(c); });
        drawn.cells = { index: cells.map(String), columns: { side: Float64Array.from(cells, (c) => members[c]) } };
      }
      const kept = await keepResult(wb.key, handle.tableKey, {
        table: { index: rows.map((g) => g.gene), columns: geneTestColumns(rows) },
        ...drawn,
      }, {
        kind: 'compare',
        title: `${summary.a.label} vs ${summary.b.label}`,
        method: 'Wilcoxon rank-sum test, tie-corrected, Benjamini–Hochberg adjusted',
        about: `Every gene compared between ${summary.a.label} (${inA} ${unit}s) and ${summary.b.label} (${inB}).`,
        parameters: { group_a: summary.a.label, group_b: summary.b.label },
        summary,
      }, session?.displayName ?? '');
      openReport(kept.id);
    } catch (e) {
      setProblem(describeError(e));
    }
  };

  return (
    <div className="task-body">
      <GroupPicker handle={handle} wbKey={wb.key} value={a} onChange={setA} label="Group" allowRest={false} />
      <GroupPicker handle={handle} wbKey={wb.key} value={b} onChange={setB} label="Against" allowRest />
      {(a?.kind === 'selection' || b?.kind === 'selection') && !selection.cells?.length && (
        <p className="muted">Click around {unit}s on the tissue to select them, or pick groups from a column.</p>
      )}
      <JobStatus job={job} label="Testing every gene" />
      {problem && <p className="notice notice-danger">{problem}</p>}
      <button type="button" className="button button-primary" disabled={!a || !b || job.running} onClick={() => void run()}>Compare</button>
    </div>
  );
}
