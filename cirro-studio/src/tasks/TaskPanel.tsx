// An open task, in the tasks drawer, with the reports its earlier runs left.
import { Suspense } from 'react';
import { stepBack, TASK_PARAM } from '../app/route';
import { ReportLinks } from '../reports/parts';
import type { KeptResult } from '../reports/store';
import type { Workbench } from '../workbench/workbench';
import { taskRuns, Unavailable, type TaskDef } from './TaskList';

export interface TaskProps {
  wb: Workbench;
  // What the page calls the store or version.
  name: string;
  // How much of the view's edges the drawers cover: a figure frames what is between them.
  inset: { left: number; right: number };
  // What the store's observations are: cells, or capture spots.
  unit: string;
}

export default function TaskPanel({ task, wb, name, inset, unit, reports }: { task: TaskDef; reports: KeptResult[] } & TaskProps) {
  const Panel = task.panel;
  // A task opened by its URL never passed the list's check that it can run here.
  const { fields } = wb.handle!;
  const hasCells = fields.n_obs > 0;
  return (
    <section className="task-panel" aria-label={task.label}>
      <header className="task-panel-head">
        <h2>{task.label}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={() => stepBack({ section: 'item', [TASK_PARAM]: null })}>×</button>
      </header>
      {taskRuns(task, hasCells, fields.has_x) ? (
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <Panel wb={wb} name={name} inset={inset} unit={unit} />
        </Suspense>
      ) : <Unavailable tasks={[task]} hasCells={hasCells} />}
      {task.report && <ReportLinks title="Earlier runs" reports={reports.filter((r) => r.meta.kind === task.report).reverse()} />}
    </section>
  );
}
