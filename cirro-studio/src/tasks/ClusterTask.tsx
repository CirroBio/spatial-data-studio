// Find clusters: scanpy's default path (log-normalize counts, variable genes, PCA, a kNN
// graph, Leiden), run in the browser. The labels go into the draft as a group column, and
// the run is kept with the data and opens as its report.
import { useState } from 'react';
import { useStudio } from '../app/studio';
import { formatBytes } from '../app/ui';
import { describeError } from '../cirro/session';
import type { ClustersSummary } from '../reports/ClustersReport';
import { openReport } from '../reports/parts';
import { keepResult } from '../reports/store';
import { applyEdit } from '../workbench/workbench';
import { freeName, readMatrix } from './data';
import { JobStatus, writeObsColumn } from './parts';
import type { TaskProps } from './TaskPanel';
import { useJob } from './useJob';

export default function ClusterTask({ wb, unit }: TaskProps) {
  const handle = wb.handle!;
  const { session } = useStudio();
  const taken = handle.fields.obs.map((f) => f.name);
  const [resolution, setResolution] = useState(1);
  const [name, setName] = useState(() => freeName('leiden', taken));
  const [keepPca, setKeepPca] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const job = useJob();
  // 50 components of float32 at most; a small panel gets fewer.
  const pcaBytes = handle.fields.n_obs * 50 * 4;

  const run = async () => {
    setProblem(null);
    try {
      const matrix = await readMatrix(wb.key, handle);
      const result = await job.run('cluster', { matrix, resolution });
      if (!result) return;
      const column = name.trim();
      const clusters = Array.from({ length: result.nClusters }, (_, i) => String(i));
      const note = `Leiden, resolution ${resolution}${result.normalized ? ', counts log-normalized first' : ''}`;
      await writeObsColumn(wb.key, handle, column, { kind: 'categorical', categories: clusters, codes: result.labels }, note);
      const pcaKey = keepPca ? `X_pca_${column}` : null;
      if (pcaKey) {
        await applyEdit(wb.key, async (e) => ({ ...(await e.setObsm(handle.tableKey, pcaKey, result.pca, result.nComps)), note: 'PCA behind the clusters' }));
      }
      const sizes = new Int32Array(result.nClusters);
      for (const l of result.labels) if (l >= 0) sizes[l] += 1;
      const summary: ClustersSummary = {
        column, clusters, sizes: Array.from(sizes), cells: result.labels.length, resolution,
        genes_used: result.genes.length, genes_total: matrix.genes.length, n_comps: result.nComps, normalized: result.normalized, pca_key: pcaKey,
      };
      const kept = await keepResult(wb.key, handle.tableKey, {
        table: { index: clusters, columns: { size: sizes } },
        pca: { index: Array.from(result.varianceRatio, (_, i) => `PC${i + 1}`), columns: { variance_ratio: result.varianceRatio } },
      }, {
        kind: 'clusters',
        title: `Clusters in ${column}`,
        method: `${result.normalized ? 'Counts log-normalized, then PCA' : 'PCA'}, a nearest-neighbor graph and Leiden, as scanpy does by default`,
        about: `Every ${unit} grouped with the ${unit}s whose expression is most like its own, as the column “${column}”.`,
        parameters: { resolution, key_added: column },
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
        Groups the cells by their expression, the way scanpy does by default: counts are normalized and log-transformed,
        the most variable genes go into a PCA, and Leiden finds communities in the cells' nearest-neighbor graph.
        The clusters open as a report.
      </p>
      <label className="field">
        <span>Resolution: {resolution.toFixed(1)} <span className="muted">(higher gives more, smaller clusters)</span></span>
        <input type="range" min={0.1} max={3} step={0.1} value={resolution} onChange={(e) => setResolution(Number(e.target.value))} />
      </label>
      <label className="field"><span>Column</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={keepPca} onChange={(e) => setKeepPca(e.target.checked)} /> Keep the PCA too (up to {formatBytes(pcaBytes)})</label>
      <JobStatus job={job} label="Clustering" />
      {problem && <p className="notice notice-danger">{problem}</p>}
      <button type="button" className="button button-primary" disabled={job.running || !name.trim()} onClick={() => void run()}>
        {taken.includes(name.trim()) ? `Find clusters, replacing “${name.trim()}”` : 'Find clusters'}
      </button>
    </div>
  );
}
