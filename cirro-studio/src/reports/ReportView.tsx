// A kept result opened as its report, across the view: the header that says what was
// run, then the report its kind draws from the kept tables.
import { lazy, Suspense, useEffect, useRef, useState, type LazyExoticComponent, type ReactElement } from 'react';
import type { CheckpointHandle } from '@cirrobio/spatial-viewer';
import { LENS_PARAM, navigate } from '../app/route';
import { describeError } from '../cirro/session';
import { useSize } from '../lib/useSize';
import { storeOf, type Workbench } from '../workbench/workbench';
import { ReportHeader } from './parts';
import { readResultTable, removeResult, type DataFrame, type KeptResult, type ReportKind } from './store';

export interface ReportProps {
  result: KeptResult;
  // The result's main table.
  table: DataFrame;
  wb: Workbench;
  handle: CheckpointHandle;
  // What the store's observations are: cells, or capture spots.
  unit: string;
  width: number;
}

// Each kind's report, loaded when one is opened. A kind missing here was kept by a newer
// version of the app.
const REPORTS: Partial<Record<ReportKind, LazyExoticComponent<(p: ReportProps) => ReactElement>>> = {
  markers: lazy(() => import('./MarkersReport')),
  compare: lazy(() => import('./CompareReport')),
  moran: lazy(() => import('./MoranReport')),
  neighborhoods: lazy(() => import('./NeighborhoodsReport')),
  niches: lazy(() => import('./NichesReport')),
  clusters: lazy(() => import('./ClustersReport')),
};

export function ReportView({ result, wb, unit }: { result: KeptResult; wb: Workbench; unit: string }) {
  const handle = wb.handle!;
  const [table, setTable] = useState<DataFrame | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useSize(ref);
  // A kept result never changes, so its table is read once per result: the result list is
  // read again after every draft edit, and re-reading would remount the report and lose
  // what the reader had picked in it.
  const resultRef = useRef(result);
  resultRef.current = result;
  useEffect(() => {
    let live = true;
    setTable(null);
    setProblem(null);
    readResultTable(storeOf(wb.key), handle.tableKey, resultRef.current).then((t) => live && setTable(t), (e: unknown) => live && setProblem(describeError(e)));
    return () => {
      live = false;
    };
  }, [wb.key, handle.tableKey, result.id]);
  const unsaved = wb.changes.some((c) => c.op === 'set-uns' && c.table === handle.tableKey && c.path.join('/') === result.path.join('/'));
  const remove = async () => {
    try {
      await removeResult(wb.key, handle.tableKey, result);
      navigate({ [LENS_PARAM]: null }, { replace: true });
    } catch (e) {
      setProblem(describeError(e));
    }
  };
  const Report = REPORTS[result.meta.kind];
  return (
    <div className="report" ref={ref}>
      <ReportHeader result={result} unsaved={unsaved} onRemove={() => void remove()} />
      {problem && <p className="notice notice-danger">{problem}</p>}
      {!Report && <p className="muted">This version of the app doesn't draw this kind of report; its tables are in the data.</p>}
      {Report && !table && !problem && <p className="muted">Reading the result…</p>}
      {Report && table && width > 0 && (
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <Report result={result} table={table} wb={wb} handle={handle} unit={unit} width={width} />
        </Suspense>
      )}
    </div>
  );
}
