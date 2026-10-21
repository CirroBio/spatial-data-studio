// What the reports share: the header that says what was run and when, the tiles of
// summary numbers, sections, the folded full table, the tissue they draw thumbnails of,
// and the actions that reach back into the data (color the tissue, score a gene set).
import { useEffect, useState, type ReactNode } from 'react';
import type { CheckpointHandle, ExpressionMatrix } from '@cirrobio/spatial-viewer';
import { geneIndex } from '../analysis/matrix';
import { LENS_PARAM, navigate } from '../app/route';
import { formatCount, formatDate } from '../app/ui';
import { tissueOf, type Tissue } from '../charts/TissueThumb';
import { describeError } from '../cirro/session';
import { updateEncoding } from '../item/displayState';
import { freeName, readCoords, readMatrix } from '../tasks/data';
import { JobStatus, writeObsColumn } from '../tasks/parts';
import { useJob } from '../tasks/useJob';
import type { Workbench } from '../workbench/workbench';
import type { KeptResult } from './store';

// How many of a group's genes make its gene set.
export const GENE_SET_SIZE = 25;

// A group's color when its column no longer has it.
export const NO_COLOR = '#8a93a3';

/** A share as a whole percentage; a share too small to round to 1% says so. */
export const pct = (v: number) => (v > 0 && v < 0.01 ? '<1%' : `${Math.round(100 * v)}%`);

export function ReportHeader({ result, unsaved, onRemove, children }: {
  result: KeptResult; unsaved: boolean; onRemove: () => void; children?: ReactNode;
}) {
  const { meta } = result;
  const [confirm, setConfirm] = useState(false);
  const when = new Date(meta.created_at);
  return (
    <header className="report-head">
      <div className="report-title">
        <h2>{meta.title}</h2>
        <p className="muted">{meta.about}</p>
        <p className="report-provenance muted">
          {unsaved ? <span className="chip chip-static">In the unsaved changes</span> : null}
          {' '}Run {formatDate(meta.created_at)} at {when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          {meta.created_by ? ` by ${meta.created_by}` : ''} · {meta.method}
          {Object.entries(meta.parameters).map(([k, v]) => <span key={k} className="chip chip-static">{k.replace(/_/g, ' ')}: {String(v)}</span>)}
        </p>
      </div>
      <div className="report-actions">
        {children}
        {confirm ? (
          <span className="button-row">
            <button type="button" className="button" onClick={() => setConfirm(false)}>Keep</button>
            <button type="button" className="button button-danger" onClick={onRemove}>Remove</button>
          </span>
        ) : (
          <button type="button" className="button" onClick={() => setConfirm(true)}>Remove…</button>
        )}
      </div>
    </header>
  );
}

export interface Stat { label: string; value: string | number; note?: string }

export function Stats({ stats }: { stats: Stat[] }) {
  return (
    <dl className="report-stats">
      {stats.map((s) => (
        <div key={s.label} className="report-stat">
          <dt>{s.label}</dt>
          <dd>{typeof s.value === 'number' ? formatCount(s.value) : s.value}</dd>
          {s.note && <dd className="muted report-stat-note">{s.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

export function Section({ title, note, children, actions }: { title: string; note?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="report-section">
      <div className="report-section-head">
        <h3>{title}</h3>
        {actions}
      </div>
      {note && <p className="muted report-note">{note}</p>}
      {children}
    </section>
  );
}

/** Every row, folded away until asked for. */
export function FullTable({ count, children }: { count: number; children: ReactNode }) {
  return (
    <details className="report-table">
      <summary>All {formatCount(count)} rows</summary>
      {children}
    </details>
  );
}

// A report's view is the lens `report:<id>`.
export const REPORT_LENS = 'report:';

/** Show a kept result's report across the view. */
export function openReport(id: string) {
  navigate({ [LENS_PARAM]: `${REPORT_LENS}${id}` }, { replace: true });
}

/** Kept results, newest first as given, each opening its report. */
export function ReportLinks({ title, reports }: { title: string; reports: KeptResult[] }) {
  if (!reports.length) return null;
  return (
    <>
      <p className="task-heading">{title}</p>
      {reports.map((r) => (
        <button key={r.id} type="button" className="figure-link" onClick={() => openReport(r.id)}>
          <span className="dot" style={{ color: 'var(--sds-stage-figure)' }} /> {r.meta.title}
          <span className="muted"> · {new Date(r.meta.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
        </button>
      ))}
    </>
  );
}

/** Color the tissue by a field and show it. */
export function showOnTissue(wbKey: string, colorBy: string) {
  updateEncoding(wbKey, 'spatial', { color_by: colorBy });
  navigate({ [LENS_PARAM]: null }, { replace: true });
}

// Cell positions, read once per dataset and field.
const tissues = new Map<string, Promise<Tissue>>();

/** The section the thumbnails draw, null until read. */
export function useTissue(wb: Workbench, coords: string): Tissue | null {
  const [tissue, setTissue] = useState<Tissue | null>(null);
  const handle = wb.handle;
  useEffect(() => {
    if (!handle) return;
    const key = `${wb.key}|${coords}`;
    let pending = tissues.get(key);
    if (!pending) {
      pending = readCoords(handle, coords).then(tissueOf);
      tissues.set(key, pending);
      pending.catch(() => tissues.delete(key));
    }
    let live = true;
    // A section that can't be read leaves the reports without thumbnails.
    pending.then((t) => live && setTissue(t), () => undefined);
    return () => {
      live = false;
    };
  }, [wb.key, handle, coords]);
  return tissue;
}

/** One gene's expression in every cell, log1p of what is stored. */
export function geneValues(matrix: ExpressionMatrix, gene: string): Float32Array | null {
  const [g] = geneIndex(matrix, [gene]);
  if (g < 0) return null;
  const values = new Float32Array(matrix.nCells);
  for (let p = matrix.indptr[g]; p < matrix.indptr[g + 1]; p++) values[matrix.indices[p]] = Math.log1p(matrix.data[p]);
  return values;
}

/** The expression matrix, null until read (or if the store has none). */
export function useMatrix(wb: Workbench): ExpressionMatrix | null {
  const [matrix, setMatrix] = useState<ExpressionMatrix | null>(null);
  const handle = wb.handle;
  useEffect(() => {
    if (!handle?.fields.has_x) return;
    let live = true;
    // Without a matrix the reports draw no gene thumbnails.
    readMatrix(wb.key, handle).then((m) => live && setMatrix(m), () => undefined);
    return () => {
      live = false;
    };
  }, [wb.key, handle]);
  return matrix;
}

/** Score a set of genes into a new column and show it on the tissue. */
export function ScoreGenes({ wb, handle, genes, name, note, label }: {
  wb: Workbench; handle: CheckpointHandle; genes: string[]; name: string; note: string; label: string;
}) {
  const job = useJob();
  const [problem, setProblem] = useState<string | null>(null);
  const run = async () => {
    setProblem(null);
    try {
      const matrix = await readMatrix(wb.key, handle);
      const found = geneIndex(matrix, genes).filter((i) => i >= 0);
      if (!found.length) throw new Error('None of these genes are in this dataset.');
      const values = await job.run('scoreGenes', { matrix, genes: found });
      if (!values) return;
      const column = freeName(name, handle.fields.obs.map((f) => f.name));
      await writeObsColumn(wb.key, handle, column, { kind: 'numeric', values }, note);
      navigate({ [LENS_PARAM]: null }, { replace: true });
    } catch (e) {
      setProblem(describeError(e));
    }
  };
  return (
    <div className="score-genes">
      <button type="button" className="button button-small" disabled={!genes.length || job.running} onClick={() => void run()}
        title={genes.length ? `Each cell's mean expression of ${genes.join(', ')}, less that of genes expressed at similar levels (scanpy's score_genes)` : undefined}>
        {label}
      </button>
      <JobStatus job={job} label="Scoring" />
      {problem && <p className="notice notice-danger">{problem}</p>}
    </div>
  );
}
