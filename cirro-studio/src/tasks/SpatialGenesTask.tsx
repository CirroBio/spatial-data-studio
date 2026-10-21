// Spatially variable genes: Moran's I of every gene over each cell's nearest neighbors
// on the tissue (squidpy's spatial_autocorr), and the strongest of them grouped into
// patterns by how alike their maps are. The run is kept with the data and opens as its
// report.
import { useState } from 'react';
import { MORAN_MIN_CELLS, SPATIAL_NEIGHBOURS } from '../analysis/defaults';
import { geneIndex } from '../analysis/matrix';
import { PATTERN_GRID, PATTERN_MIN_CORRELATION, PATTERN_MIN_GENES, spatialPatterns } from '../analysis/patterns';
import { useStudio } from '../app/studio';
import { tissueOf } from '../charts/TissueThumb';
import { SIGNIFICANCE } from '../charts/Volcano';
import { describeError } from '../cirro/session';
import { useDisplays } from '../item/displayState';
import type { MoranSummary } from '../reports/MoranReport';
import { openReport } from '../reports/parts';
import { GENE_TEST_COLUMN, keepResult, type KeptTable } from '../reports/store';
import { readCoords, readMatrix } from './data';
import { JobStatus } from './parts';
import type { TaskProps } from './TaskPanel';
import { useJob } from './useJob';

// How many of the strongest spatially variable genes are grouped into patterns.
const PATTERN_GENES = 60;

export default function SpatialGenesTask({ wb, unit }: TaskProps) {
  const handle = wb.handle!;
  const { session } = useStudio();
  const displays = useDisplays(wb.key, wb.handle);
  const [problem, setProblem] = useState<string | null>(null);
  const job = useJob();
  const coords = displays.spatial?.encoding.coords ?? 'obsm:spatial';

  const run = async () => {
    setProblem(null);
    try {
      const [matrix, xy] = await Promise.all([readMatrix(wb.key, handle), readCoords(handle, coords)]);
      const rows = await job.run('moransI', { matrix, xy });
      if (!rows) return;
      // `rows` come highest I first.
      const strongest = rows.filter((r) => r.padj < SIGNIFICANCE.padj && r.I > 0).slice(0, PATTERN_GENES);
      const labels = spatialPatterns(matrix, geneIndex(matrix, strongest.map((r) => r.gene)), tissueOf(xy));
      const summary: MoranSummary = {
        coordinates: coords,
        neighbors: SPATIAL_NEIGHBOURS,
        min_cells: MORAN_MIN_CELLS,
        genes_tested: rows.length,
        cutoff: { padj: SIGNIFICANCE.padj },
        patterns: {
          count: labels.reduce((n, p) => Math.max(n, p + 1), 0),
          genes: strongest.length,
          grid: PATTERN_GRID,
          min_correlation: PATTERN_MIN_CORRELATION,
          min_genes: PATTERN_MIN_GENES,
        },
      };
      // Each grouped gene's pattern, -1 for none.
      const patterns: Record<string, KeptTable> = strongest.length
        ? { patterns: { index: strongest.map((r) => r.gene), columns: { pattern: labels } } }
        : {};
      const kept = await keepResult(wb.key, handle.tableKey, {
        table: {
          index: rows.map((r) => r.gene),
          columns: {
            I: Float64Array.from(rows, (r) => r.I),
            z: Float64Array.from(rows, (r) => r.z),
            [GENE_TEST_COLUMN.pval]: Float64Array.from(rows, (r) => r.pval),
            [GENE_TEST_COLUMN.padj]: Float64Array.from(rows, (r) => r.padj),
          },
        },
        ...patterns,
      }, {
        kind: 'moran',
        title: 'Spatially variable genes',
        method: `Moran's I over each ${unit}'s ${SPATIAL_NEIGHBOURS} nearest neighbors, Benjamini–Hochberg adjusted; patterns by average-linkage clustering of binned maps`,
        about: `How much each gene's expression in a ${unit} resembles its neighbors', and the strongest such genes grouped by how alike their maps are.`,
        parameters: { coordinates: coords, neighbors: SPATIAL_NEIGHBOURS, min_cells: MORAN_MIN_CELLS },
        summary,
      }, session?.displayName ?? '');
      openReport(kept.id);
    } catch (e) {
      setProblem(describeError(e));
    }
  };

  return (
    <div className="task-body">
      <p className="muted">Moran's I measures how much a gene's expression in a {unit} resembles its neighbors': near 1 for a gene that marks a region, near 0 for one scattered at random. The genes with the strongest patterns are grouped by how alike their maps are, and the run opens as a report.</p>
      <JobStatus job={job} label="Measuring every gene" />
      {problem && <p className="notice notice-danger">{problem}</p>}
      <button type="button" className="button button-primary" disabled={job.running} onClick={() => void run()}>Find spatially variable genes</button>
    </div>
  );
}
