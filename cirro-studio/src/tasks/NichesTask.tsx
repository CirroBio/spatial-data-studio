// Cellular niches: each cell described by the mix of groups among its nearest neighbors,
// and those mixes clustered (k-means), as cellular neighborhoods are found in
// Schürch et al. 2020. The niche of each cell goes into the draft as a group column; the
// run is kept with the data and opens as its report.
import { useState } from 'react';
import { NICHE_COUNT, NICHE_NEIGHBOURS } from '../analysis/defaults';
import { useStudio } from '../app/studio';
import { describeError } from '../cirro/session';
import { useDisplays } from '../item/displayState';
import type { NichesSummary } from '../reports/NichesReport';
import { openReport } from '../reports/parts';
import { keepResult, storableNames } from '../reports/store';
import { freeName, readCoords, readGroups } from './data';
import { ColumnSelect, JobStatus, writeObsColumn } from './parts';
import type { TaskProps } from './TaskPanel';
import { useJob } from './useJob';

export default function NichesTask({ wb, unit }: TaskProps) {
  const handle = wb.handle!;
  const { session } = useStudio();
  const displays = useDisplays(wb.key, wb.handle);
  const taken = handle.fields.obs.map((f) => f.name);
  const [column, setColumn] = useState('');
  const [count, setCount] = useState(NICHE_COUNT);
  const [neighbors, setNeighbors] = useState(NICHE_NEIGHBOURS);
  const [name, setName] = useState(() => freeName('niche', taken));
  const [problem, setProblem] = useState<string | null>(null);
  const job = useJob();
  const coords = displays.spatial?.encoding.coords ?? 'obsm:spatial';

  const run = async () => {
    setProblem(null);
    try {
      const [obs, xy] = await Promise.all([readGroups(handle, column), readCoords(handle, coords)]);
      const r = await job.run('niches', { codes: obs.codes, nCategories: obs.categories.length, xy, k: neighbors, nNiches: count });
      if (!r) return;
      const niches = Array.from({ length: r.nNiches }, (_, i) => `N${i + 1}`);
      const target = name.trim();
      await writeObsColumn(wb.key, handle, target, { kind: 'categorical', categories: niches, codes: r.labels }, `niches of ${column}, ${neighbors} neighbors`);
      const sizes = niches.map(() => 0);
      let unassigned = 0;
      for (const l of r.labels) {
        if (l >= 0) sizes[l] += 1;
        else unassigned += 1;
      }
      const columns = storableNames(obs.categories);
      const nGroups = obs.categories.length;
      const summary: NichesSummary = {
        column, niche_column: target, niches, sizes, unassigned, groups: obs.categories, columns, neighbors, n_niches: count, coords,
      };
      const kept = await keepResult(wb.key, handle.tableKey, {
        table: {
          index: niches,
          columns: Object.fromEntries(columns.map((c, g) => [c, Float32Array.from(niches, (_, i) => r.profiles[i * nGroups + g])])),
        },
      }, {
        kind: 'niches',
        title: `Cellular niches of ${column}`,
        method: `k-means on each ${unit}'s neighborhood mix`,
        about: `Each ${unit} described by the share of each ${column} group among itself and its ${neighbors} nearest ${unit}s; ${unit}s with similar mixes form a niche, written to “${target}”.`,
        parameters: { groupby: column, n_niches: count, n_neighbors: neighbors, key_added: target },
        summary,
      }, session?.displayName ?? '');
      openReport(kept.id);
    } catch (e) {
      setProblem(describeError(e));
    }
  };

  return (
    <div className="task-body">
      <p className="muted">Groups {unit}s by what surrounds them, adds each {unit}'s niche as a column, and opens what each niche is made of as a report.</p>
      <ColumnSelect handle={handle} value={column} onChange={setColumn} label="Cell types or clusters" />
      <label className="field"><span>Niches to find: {count}</span><input type="range" min={2} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} /></label>
      <label className="field"><span>Neighbors per cell: {neighbors}</span><input type="range" min={5} max={50} value={neighbors} onChange={(e) => setNeighbors(Number(e.target.value))} /></label>
      <label className="field"><span>Column</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <JobStatus job={job} label="Finding niches" />
      {problem && <p className="notice notice-danger">{problem}</p>}
      <button type="button" className="button button-primary" disabled={!column || !name.trim() || job.running} onClick={() => void run()}>Find niches</button>
    </div>
  );
}
