// The left-hand drawer of a spatial dataset: tasks for looking closer, and for making
// something new (each writes into the unsaved draft), then the reports and figures kept
// here.
import { lazy, type LazyExoticComponent, type ReactElement } from 'react';
import { navigate, TASK_PARAM } from '../app/route';
import type { FigureSpec } from '../figures/spec';
import { ReportLinks } from '../reports/parts';
import type { KeptResult, ReportKind } from '../reports/store';
import type { TaskProps } from './TaskPanel';

export interface TaskDef {
  id: string;
  group: 'closer' | 'new';
  label: string;
  about: string;
  // Needs cells to work on, or an expression matrix as well.
  needs: 'cells' | 'genes';
  // Loaded when the task is opened, so the list itself stays light.
  panel: LazyExoticComponent<(p: TaskProps) => ReactElement>;
  // The report a run keeps, for an analysis.
  report?: ReportKind;
}

export const TASKS: TaskDef[] = [
  { id: 'annotations', group: 'closer', label: 'Cell annotations', about: 'Every grouping and value the cells carry', needs: 'cells', panel: lazy(() => import('./AnnotationsTask')) },
  { id: 'label', group: 'new', label: 'Label cells', about: 'Draw around cells and name them', needs: 'cells', panel: lazy(() => import('./LabelTask')) },
  { id: 'cluster', group: 'new', label: 'Find clusters', about: 'Group cells by expression (Leiden)', needs: 'genes', panel: lazy(() => import('./ClusterTask')), report: 'clusters' },
  { id: 'compare', group: 'new', label: 'Compare groups', about: 'The genes that differ between two groups', needs: 'genes', panel: lazy(() => import('./CompareTask')), report: 'compare' },
  { id: 'markers', group: 'new', label: 'Marker genes', about: 'What sets each group apart', needs: 'genes', panel: lazy(() => import('./MarkersTask')), report: 'markers' },
  { id: 'spatial-genes', group: 'new', label: 'Spatially variable genes', about: 'Genes with a spatial pattern (Moran\'s I)', needs: 'genes', panel: lazy(() => import('./SpatialGenesTask')), report: 'moran' },
  { id: 'neighborhoods', group: 'new', label: 'Neighborhood enrichment', about: 'Which groups sit next to which', needs: 'cells', panel: lazy(() => import('./NeighborhoodsTask')), report: 'neighborhoods' },
  { id: 'niches', group: 'new', label: 'Cellular niches', about: 'Regions with the same mix of cell types', needs: 'cells', panel: lazy(() => import('./NichesTask')), report: 'niches' },
  { id: 'figure', group: 'new', label: 'Save as a figure', about: 'This view, kept with the data it shows', needs: 'cells', panel: lazy(() => import('./FigureTask')) },
];

function TaskButton({ task }: { task: TaskDef }) {
  return (
    <button type="button" className="task-button" onClick={() => navigate({ section: 'task', [TASK_PARAM]: task.id })}>
      <span className="task-label">{task.label}</span>
      <span className="task-about">{task.about}</span>
      <span className="task-arrow" aria-hidden="true">→</span>
    </button>
  );
}

export const taskRuns = (t: TaskDef, hasCells: boolean, hasGenes: boolean) => hasCells && (t.needs === 'cells' || hasGenes);

/** What can't run on this store, in one line rather than a card each. */
export function Unavailable({ tasks, hasCells }: { tasks: TaskDef[]; hasCells: boolean }) {
  if (!tasks.length) return null;
  const why = !hasCells
    ? 'With no cells in this store, these can\'t run'
    : 'These need the expression matrix, which this store was saved without (a copy saved with its counts can run them)';
  return <p className="task-unavailable">{why}: {tasks.map((t) => t.label.toLowerCase()).join(', ')}.</p>;
}

export function TaskList({ hasCells, hasGenes, reports, figures, onFigure }: {
  hasCells: boolean; hasGenes: boolean; reports: KeptResult[]; figures: FigureSpec[]; onFigure: (id: string) => void;
}) {
  const runs = (t: TaskDef) => taskRuns(t, hasCells, hasGenes);
  return (
    <div className="task-list">
      <p className="task-heading">Look closer</p>
      {TASKS.filter((t) => t.group === 'closer' && runs(t)).map((t) => <TaskButton key={t.id} task={t} />)}
      <p className="task-heading">Make something new</p>
      {TASKS.filter((t) => t.group === 'new' && runs(t)).map((t) => <TaskButton key={t.id} task={t} />)}
      <Unavailable tasks={TASKS.filter((t) => !runs(t))} hasCells={hasCells} />
      <ReportLinks title="Reports kept here" reports={[...reports].reverse()} />
      {figures.length > 0 && (
        <>
          <p className="task-heading">Figures saved here</p>
          {figures.map((f) => (
            <button key={f.id} type="button" className="figure-link" onClick={() => onFigure(f.id)}>
              <span className="dot" style={{ color: 'var(--sds-stage-figure)' }} /> {f.title}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
