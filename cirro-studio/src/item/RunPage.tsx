// An instrument run opened: what the instrument reported about it (its metrics file),
// the spatial data made from it, and the pipelines that make more.
import { useEffect, useState } from 'react';
import { useStudio } from '../app/studio';
import { formatBytes, tint } from '../app/ui';
import { describeError } from '../cirro/session';
import { RUN_TYPES } from '../data/discover';
import type { RunItem } from '../data/model';
import { Facts, kinOf } from './Facts';
import { PipelineLinks } from './PipelineLinks';
import { useDrawers, ViewFrame } from './ViewFrame';

// The first data row of a metrics CSV, keeping quoted fields whole.
export function parseMetrics(csv: string): [string, string][] {
  const split = (line: string) => {
    const out: string[] = [];
    let cell = '';
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) {
        out.push(cell);
        cell = '';
      } else cell += ch;
    }
    out.push(cell);
    return out;
  };
  const [head, first] = csv.split(/\r?\n/).filter(Boolean);
  if (!head || !first) return [];
  const names = split(head);
  const values = split(first);
  return names.map((n, i) => [n, values[i] ?? '']);
}

export function RunPage({ item }: { item: RunItem }) {
  const { collection, library, catalog } = useStudio();
  const drawers = useDrawers(false);
  const [metrics, setMetrics] = useState<[string, string][] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const type = RUN_TYPES.find((t) => t.id === item.runType);
  useEffect(() => {
    if (!item.metricsPath) return;
    let live = true;
    collection.readFile(item.datasetId, item.metricsPath)
      .then((bytes) => live && setMetrics(parseMetrics(new TextDecoder().decode(bytes))), (e: unknown) => live && setProblem(describeError(e)));
    return () => {
      live = false;
    };
  }, [collection, item]);
  const wanted = new Set(type?.run_metrics?.columns ?? []);
  const shown = metrics?.filter(([k]) => !wanted.size || wanted.has(k)) ?? [];
  const { from, into } = kinOf(item, library, (id) => catalog.byId.get(id)?.sourceIds ?? []);
  return (
    <div className="picture" style={tint('--sds-stage-run')}>
      <Facts title={item.label} item={item} kind={item.runLabel} stage="runs" from={from} into={into} />
      <ViewFrame drawers={drawers} sheet
        left={{
          label: 'Tasks',
          content: (
            <>
              <p className="task-heading">Make something new</p>
              <PipelineLinks datasetId={item.datasetId} purpose="encode" about="Turn this run into a SpatialData store to open here: Spatial Data Studio's workflow reads it as the instrument wrote it." />
              <PipelineLinks datasetId={item.datasetId} purpose="segment" about="Or segment its cells again first." />
            </>
          ),
        }}
        right={{
          label: 'Run',
          content: (
            <div className="caption">
              <p className="answer">{item.runLabel} output · {formatBytes(item.size)}</p>
              <p className="muted caption-note">
                {into.length ? 'Open the spatial data made from it to explore its cells.' : 'Nothing has been made from this run in this project yet.'}
              </p>
            </div>
          ),
        }}
        main={(
          <div className="sheet">
            {problem && <p className="notice notice-warning">{problem}</p>}
            {!item.metricsPath && <p className="muted">This run has no metrics file the app recognizes.</p>}
            {shown.length > 0 && (
              <dl className="metrics">
                {shown.map(([k, v]) => <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd>{v}</dd></div>)}
              </dl>
            )}
          </div>
        )} />
    </div>
  );
}
