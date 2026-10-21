// A spatial dataset's versions as a history: the base store at the bottom, each version
// above the one it was saved on, branches side by side, the unsaved draft on top of the
// version that is open. Any version opens from here, and saving from an older one
// starts a branch rather than overwriting what came after.
import { useMemo } from 'react';
import type { SpatialEntity } from '../app/library';
import { childrenByParent, refOfItem } from '../app/library';
import { openItem } from '../app/route';
import { formatDate, plural } from '../app/ui';
import type { VersionItem } from '../data/model';
import type { Change } from '../stack/manifest';
import { describeChange, isRemoval } from './changes';

interface Row {
  ref: string;
  version: VersionItem | null;
  column: number;
  // Columns whose line passes this row without stopping.
  through: number[];
  // Columns of the lines arriving at this row's node from versions saved on it.
  children: number[];
}

const COL = 18;
// Where a row's node sits, from the row's top.
const NODE_Y = 22;
const ROW_MIN = 58;

function layout(entity: SpatialEntity, draftOn: string | null): Row[] {
  const children = childrenByParent(entity);
  const rows: Row[] = [];
  let columns = 0;
  // Depth-first from the base: a version's first child keeps its column, later ones
  // open new columns to the right.
  const walk = (ref: string, version: VersionItem | null, column: number) => {
    rows.push({ ref, version, column, through: [], children: [] });
    const kids = (children.get(ref) ?? []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    kids.forEach((k, i) => walk(refOfItem(k), k, i === 0 ? column : ++columns));
  };
  walk(entity.baseRef, null, 0);
  // Newest first, base last.
  const ordered = [rows[0], ...rows.slice(1).sort((a, b) => a.version!.createdAt.localeCompare(b.version!.createdAt))].reverse();
  const at = new Map(ordered.map((r, i) => [r.ref, i]));
  for (const [i, r] of ordered.entries()) {
    if (!r.version) continue;
    const parent = at.get(r.version.parent);
    if (parent === undefined) continue;
    for (let j = i + 1; j < parent; j++) ordered[j].through.push(r.column);
    ordered[parent].children.push(r.column);
  }
  // The draft sits above everything, on the open row's column.
  const open = draftOn === null ? undefined : at.get(draftOn);
  if (open !== undefined) {
    for (let j = 0; j < open; j++) ordered[j].through.push(ordered[open].column);
    ordered[open].children.push(ordered[open].column);
  }
  return ordered;
}

function ChangeList({ changes }: { changes: Change[] }) {
  return (
    <ul className="history-changes">
      {changes.slice(0, 4).map((c, i) => <li key={i} className={isRemoval(c) ? 'removed' : ''}>{describeChange(c)}</li>)}
      {changes.length > 4 && <li className="muted">{changes.length - 4} more</li>}
    </ul>
  );
}

function Graph({ width, row, draft = false }: { width: number; row: Pick<Row, 'column' | 'through' | 'children'> & { parent: boolean }; draft?: boolean }) {
  const x = (c: number) => 9 + c * COL;
  return (
    <svg className="history-graph" width={width} aria-hidden="true">
      {row.through.map((c) => <line key={`t${c}`} x1={x(c)} y1={0} x2={x(c)} y2="100%" className="history-line" />)}
      {/* The draft and a first child share their parent's column: one edge each column. */}
      {[...new Set(row.children)].map((c) => (c === row.column
        ? <line key={`c${c}`} x1={x(c)} y1={0} x2={x(c)} y2={NODE_Y} className="history-line" />
        : <path key={`c${c}`} d={`M${x(c)},0 Q${x(c)},${NODE_Y} ${x(row.column)},${NODE_Y}`} className="history-line" fill="none" />))}
      {row.parent && <line x1={x(row.column)} y1={NODE_Y} x2={x(row.column)} y2="100%" className={`history-line ${draft ? 'history-line-draft' : ''}`} />}
    </svg>
  );
}

export function History({ entity, openRef, draft }: { entity: SpatialEntity; openRef: string; draft: Change[] }) {
  const rows = useMemo(() => layout(entity, draft.length ? openRef : null), [entity, openRef, draft.length]);
  const width = (Math.max(0, ...rows.map((r) => Math.max(r.column, ...r.through, ...r.children))) + 1) * COL + 8;
  const openRow = rows.find((r) => r.ref === openRef);
  const noneSaved = !draft.length && rows.every((r) => !r.version);
  return (
    <div className="history" role="list" aria-label="Versions">
      {draft.length > 0 && openRow && (
        <div className="history-row history-draft" role="listitem" style={{ minHeight: ROW_MIN }}>
          <span className="history-gutter">
            <Graph width={width} row={{ column: openRow.column, through: [], children: [], parent: true }} draft />
            <span className="history-node history-node-draft" style={{ left: 9 + openRow.column * COL }} />
          </span>
          <div className="history-text">
            <strong>Unsaved changes</strong>
            <ChangeList changes={draft} />
          </div>
        </div>
      )}
      {rows.map((r) => {
        const isOpen = r.ref === openRef;
        const v = r.version;
        return (
          <div key={r.ref} className={`history-row ${isOpen ? 'history-open' : ''}`} role="listitem" style={{ minHeight: ROW_MIN }}>
            <span className="history-gutter">
              <Graph width={width} row={{ ...r, parent: Boolean(v) }} />
              <span className={`history-node ${v ? '' : 'history-node-base'} ${isOpen ? 'history-node-open' : ''}`} style={{ left: 9 + r.column * COL }} />
            </span>
            <div className="history-text">
              <span className="history-title">
                <strong>{v ? v.title : 'Original store'}</strong>
                {isOpen && <span className="pill">open</span>}
              </span>
              <span className="muted">
                {v ? `${v.createdBy ? `${v.createdBy}, ` : ''}${formatDate(v.createdAt)} · ${plural(v.changes.length, ['change', 'changes'])}` : entity.base ? entity.label : 'In a project you can\'t see'}
              </span>
              {v && <ChangeList changes={v.changes} />}
              {noneSaved && (
                <p className="history-note muted">
                  No versions are saved on this store yet. What a task makes waits in the bar at the bottom of the page
                  until you save it as a version, which then appears here.
                </p>
              )}
            </div>
            {!isOpen && (v || entity.base) && (
              <button type="button" className="button button-small" onClick={() => {
                const target = v ?? entity.base!;
                openItem(target.datasetId, target.path);
              }}>Open</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
