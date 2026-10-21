// Neighborhood enrichment: how often cells of each group sit next to cells of each other
// group, against shuffled labels (squidpy's nhood_enrichment). The run is kept with the
// data and opens as its report.
import { useState } from 'react';
import { ENRICHMENT_PERMUTATIONS, SPATIAL_NEIGHBOURS } from '../analysis/defaults';
import { useStudio } from '../app/studio';
import { describeError } from '../cirro/session';
import { useDisplays } from '../item/displayState';
import type { NeighborhoodsSummary } from '../reports/NeighborhoodsReport';
import { openReport } from '../reports/parts';
import { keepResult, storableNames, type KeptTable } from '../reports/store';
import { readCoords, readGroups } from './data';
import { ColumnSelect, JobStatus } from './parts';
import type { TaskProps } from './TaskPanel';
import { useJob } from './useJob';

const MAX_GROUPS = 60;

export default function NeighborhoodsTask({ wb, unit }: TaskProps) {
  const handle = wb.handle!;
  const { session } = useStudio();
  const displays = useDisplays(wb.key, wb.handle);
  const [column, setColumn] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const job = useJob();
  const coords = displays.spatial?.encoding.coords ?? 'obsm:spatial';

  const run = async () => {
    setProblem(null);
    try {
      const [obs, xy] = await Promise.all([readGroups(handle, column), readCoords(handle, coords)]);
      const n = obs.categories.length;
      if (n > MAX_GROUPS) throw new Error(`“${column}” has ${n} groups; this compares at most ${MAX_GROUPS}.`);
      const r = await job.run('neighborhoodEnrichment', { codes: obs.codes, nCategories: n, xy });
      if (!r) return;
      const sizes = obs.categories.map(() => 0);
      for (const c of obs.codes) if (c >= 0) sizes[c] += 1;
      // Square, the groups on both axes and named alike, so Python reads a labelled matrix
      // and the saved heatmap keeps the rows' order for its columns.
      const names = storableNames(obs.categories);
      const square = (m: Float64Array): KeptTable => ({
        index: names,
        columns: Object.fromEntries(names.map((name, j) => [name, Float64Array.from(names, (_, i) => m[i * n + j])])),
      });
      const summary: NeighborhoodsSummary = {
        column, groups: obs.categories, sizes, neighbors: SPATIAL_NEIGHBOURS, permutations: ENRICHMENT_PERMUTATIONS, coords,
      };
      const kept = await keepResult(wb.key, handle.tableKey, { table: square(r.z), count: square(r.counts) }, {
        kind: 'neighborhoods',
        title: `Neighborhood enrichment of ${column}`,
        method: "Neighbor-pair counts against label permutations, as squidpy's nhood_enrichment",
        about: `How often ${unit}s of each ${column} group have ${unit}s of each other group among their ${SPATIAL_NEIGHBOURS} nearest, against chance.`,
        parameters: { cluster_key: column, neighbors: SPATIAL_NEIGHBOURS, permutations: ENRICHMENT_PERMUTATIONS },
        summary,
      }, session?.displayName ?? '');
      openReport(kept.id);
    } catch (e) {
      setProblem(describeError(e));
    }
  };

  return (
    <div className="task-body">
      <p className="muted">
        Counts how often each pair of groups are neighbors (each {unit}'s {SPATIAL_NEIGHBOURS} nearest on the tissue) against shuffled
        labels, and opens which groups sit together and which keep apart as a report.
      </p>
      <ColumnSelect handle={handle} value={column} onChange={setColumn} label="Groups" />
      <JobStatus job={job} label="Counting neighbors" />
      {problem && <p className="notice notice-danger">{problem}</p>}
      <button type="button" className="button button-primary" disabled={!column || job.running} onClick={() => void run()}>Measure enrichment</button>
    </div>
  );
}
