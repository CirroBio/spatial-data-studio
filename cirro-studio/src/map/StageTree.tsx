// An open stage as a tree of its Cirro folders (an ARIA treegrid): each item's full name and
// what it is in words, its size as a dot on the stage's log ruler, and, once selected, a look
// at it under its row with where it came from, what was made of it and what can be done.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { stageOf, type StageId } from '../app/library';
import { useStudio } from '../app/studio';
import { formatBytes, formatDate, plural } from '../app/ui';
import { itemKey } from '../data/model';
import { PipelineLinks } from '../item/PipelineLinks';
import { openWorkspaces, requestFor } from '../workspaces/request';
import {
  buildTree, filterId, flatRows, folderChain, initiallyOpen, keepFor, onRuler, ruler, saidOfAll, summarize, visibleRows,
  type Row, type Ruler, type SortKey, type TreeFolder,
} from './browse';
import type { StageNode } from './nodes';

export interface BrowseState { selected: string | null; query: string; sort: SortKey; flat: boolean; filters: Set<string> }

const SORTS: { id: SortKey; label: string }[] = [{ id: 'name', label: 'Name' }, { id: 'size', label: 'Largest' }, { id: 'newest', label: 'Newest' }];
const DESCRIPTION_CHARS = 320;
// Typed letters within this long of each other spell one name to jump to.
const TYPE_AHEAD_MS = 700;
// Rows drawn at a time: a flat list of a thousand images takes most of a second to draw, and
// again on every keystroke of a search; more come a page at a time.
const ROWS_AT_ONCE = 400;

export function StageTree({ stage, nodes, state, onState, open, onOpenFolders, onOpen, onReveal, onMatch, searchRef }: {
  stage: StageId;
  // Every stage's, for lineage.
  nodes: Record<StageId, StageNode[]>;
  state: BrowseState;
  onState: (patch: Partial<BrowseState>) => void;
  // The folders opened or closed by hand; null until then.
  open: Set<string> | null;
  onOpenFolders: (open: Set<string>) => void;
  // `dot`: the row's mark, for the picture to grow from.
  onOpen: (node: StageNode, dot: Element | null) => void;
  // An item named in a look, perhaps in another stage.
  onReveal: (node: StageNode) => void;
  onMatch: (keys: Set<string> | null) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const { catalog, collection } = useStudio();
  const info = stageOf(stage);
  const mine = nodes[stage];
  const byKey = useMemo(() => new Map(Object.values(nodes).flat().map((n) => [n.key, n])), [nodes]);
  const { shared, facets } = useMemo(() => summarize(mine.map((n) => n.facts)), [mine]);
  // A row leaves out what the line above already says of every item.
  const sharedText = new Map(shared.map((f) => [f.key, f.text]));
  const root = useMemo(() => buildTree(mine), [mine]);
  const shownOpen = useMemo(() => {
    if (open) return open;
    const first = initiallyOpen(root);
    for (const id of folderChain(byKey.get(state.selected ?? '')?.folders[0])) first.add(id);
    return first;
  }, [open, root, byKey, state.selected]);
  const size = useMemo(() => ruler(mine.map((n) => n.size)), [mine]);
  const keep = useMemo(() => keepFor(state.query, state.filters), [state.query, state.filters]);
  const rows = useMemo(() => (state.flat ? flatRows(mine, state.sort, keep) : visibleRows(root, shownOpen, state.sort, keep)), [mine, root, shownOpen, state.sort, state.flat, keep]);
  useEffect(() => onMatch(keep ? new Set(mine.filter(keep).map((n) => n.key)) : null), [keep, mine, onMatch]);
  const [limit, setLimit] = useState(ROWS_AT_ONCE);
  useEffect(() => setLimit(ROWS_AT_ONCE), [keep, state.flat, state.sort]);

  const grid = useRef<HTMLDivElement>(null);
  const rowEl = (id: string) => grid.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
  const dotOf = (id: string) => rowEl(id)?.querySelector('.stage-tree-dot') ?? null;
  useEffect(() => {
    if (state.selected) rowEl(state.selected)?.scrollIntoView({ block: 'nearest' });
  }, [state.selected]);
  const current = rows.findIndex((r) => r.node.id === state.selected);
  // Far enough down to show the selected row, wherever it is.
  const drawn = rows.slice(0, Math.max(limit, current + 1));
  // The row that takes Tab: the selected one, else the first.
  const tabRow = current >= 0 ? state.selected : rows[0]?.node.id;
  const setOpen = (id: string, isOpen: boolean) => {
    const next = new Set(shownOpen);
    if (isOpen) next.add(id);
    else next.delete(id);
    onOpenFolders(next);
  };
  const select = (id: string | null) => onState({ selected: id });
  const typed = useRef({ text: '', at: 0 });

  const onKey = (e: KeyboardEvent, r: Row, i: number) => {
    const move = (to: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (!target) return;
      select(target.node.id);
      requestAnimationFrame(() => rowEl(target.node.id)?.focus());
    };
    const isFolder = r.node.kind === 'folder';
    switch (e.key) {
      case 'ArrowDown': move(i + 1); break;
      case 'ArrowUp': move(i - 1); break;
      case 'Home': move(0); break;
      case 'End': move(rows.length - 1); break;
      case 'ArrowRight':
        if (isFolder && !r.open && !keep) setOpen(r.node.id, true);
        else if (isFolder) move(i + 1);
        else return;
        break;
      case 'ArrowLeft':
        if (isFolder && r.open && !keep) setOpen(r.node.id, false);
        else if (r.parent) move(rows.findIndex((x) => x.node.id === r.parent));
        else return;
        break;
      case 'Enter':
        if (r.node.kind === 'folder') setOpen(r.node.id, !r.open);
        else onOpen(r.node.node, dotOf(r.node.id));
        break;
      case ' ':
        select(state.selected === r.node.id && !isFolder ? null : r.node.id);
        break;
      default: {
        if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || e.key === '/') return;
        const now = performance.now();
        typed.current = { text: (now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : '') + e.key.toLowerCase(), at: now };
        const name = (x: Row) => (x.node.kind === 'folder' ? x.node.name : x.node.node.label).toLowerCase();
        const order = [...rows.slice(i + 1), ...rows.slice(0, i + 1)];
        const hit = order.find((x) => name(x).startsWith(typed.current.text));
        if (hit) move(rows.indexOf(hit));
      }
    }
    e.preventDefault();
  };

  const folders = countFolders(root);
  const reading = catalog.status === 'scanning' ? ` · still reading ${catalog.toScan - catalog.scanned} datasets` : '';

  if (!mine.length) {
    const note = catalog.status === 'loading' || catalog.status === 'scanning' ? 'Looking…'
      : collection.kind === 'examples' && (stage === 'images' || stage === 'runs') ? `Log in to Cirro to see your own ${info.unit[1]}.`
        : `No ${info.unit[1]} in this project yet.`;
    return <section className="stage-tree" aria-label={info.label}><p className="stage-tree-none muted">{note}</p></section>;
  }

  return (
    <section className="stage-tree" aria-label={info.label}>
      <header className="stage-tree-head">
        <h2>{info.label}</h2>
        <p className="stage-tree-summary">
          {plural(mine.length, info.unit)}
          {root.bytes > 0 && ` · ${formatBytes(root.bytes)}`}
          {folders > 0 && ` · in ${plural(folders, ['folder', 'folders'])}`}
          {shared.length > 0 && <span className="stage-tree-shared"> · {shared.map(saidOfAll).join(' · ')}</span>}
          {reading && <span className="muted">{reading}</span>}
        </p>
      </header>
      <div className="stage-tree-tools">
        <input ref={searchRef} className="input map-search" type="search" value={state.query} placeholder={`Find ${info.unit[1]}`}
          aria-label={`Find ${info.unit[1]} by name, folder, tag or fact (press / to come here)`} onChange={(e) => onState({ query: e.target.value })} />
        {facets.flatMap((facet) => facet.values.map((v) => {
          const id = filterId({ key: facet.key, text: v.text });
          const on = state.filters.has(id);
          return (
            <button key={id} type="button" className="chip stage-tree-chip" aria-pressed={on}
              onClick={() => { const next = new Set(state.filters); if (on) next.delete(id); else next.add(id); onState({ filters: next }); }}>
              {v.text} <span className="muted">{v.count}</span>
            </button>
          );
        }))}
        <span className="shell-spacer" />
        <label className="stage-tree-sort">
          <span className="muted">Order</span>
          <select className="select" value={state.sort} onChange={(e) => onState({ sort: e.target.value as SortKey })}>
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <span className="map-seg" role="group" aria-label="Show as">
          <button type="button" aria-pressed={!state.flat} onClick={() => onState({ flat: false })}>Folders</button>
          <button type="button" aria-pressed={state.flat} onClick={() => onState({ flat: true })}>Flat list</button>
        </span>
      </div>
      <p className="sr-only" role="status">{keep ? `${rows.filter((r) => r.node.kind === 'item').length} of ${mine.length} shown` : ''}</p>
      <div className="stage-tree-grid" role="treegrid" aria-label={`${info.label}, by folder`} ref={grid}>
        <div className="stage-tree-row stage-tree-colhead" role="row">
          <span role="columnheader">Name</span>
          <span role="columnheader" className="stage-tree-sizehead">
            <span className="stage-tree-marks" aria-hidden="true">{size?.marks.map((m) => <i key={m.label} style={{ left: `${m.at * 100}%` }}>{m.label}</i>)}</span>
            <span>Size</span>
          </span>
          <span role="columnheader">Added</span>
        </div>
        {drawn.map((r, i) => {
          const selected = r.node.id === state.selected;
          const common = {
            'data-row': r.node.id,
            role: 'row',
            tabIndex: r.node.id === tabRow ? 0 : -1,
            'aria-level': r.level,
            'aria-posinset': r.pos,
            'aria-setsize': r.of,
            'aria-selected': selected,
            onKeyDown: (e: KeyboardEvent) => onKey(e, r, i),
            style: { '--level': r.level - 1 } as CSSProperties,
          };
          if (r.node.kind === 'folder') {
            const f = r.node;
            return (
              <div key={f.id} {...common} aria-expanded={r.open} className={`stage-tree-row stage-tree-folder${selected ? ' selected' : ''}`}
                onClick={(e) => { if (e.detail > 1) return; select(f.id); if (!keep) setOpen(f.id, !r.open); }}>
                <span role="gridcell" className="stage-tree-name">
                  <span className="stage-tree-caret" aria-hidden="true">{r.open ? '▾' : '▸'}</span>
                  <strong>{f.name}</strong> <span className="muted">{f.items}</span>
                </span>
                <span role="gridcell" className="stage-tree-size">
                  <SizeTrack ruler={size}>{size && f.sizes.map((b, k) => <i key={k} className="stage-tree-tick" style={{ left: `${onRuler(size, b) * 100}%` }} />)}</SizeTrack>
                  <span className="stage-tree-bytes">{f.bytes ? formatBytes(f.bytes) : ''}</span>
                </span>
                <span role="gridcell" className="stage-tree-date muted">{f.newest ? formatDate(f.newest) : ''}</span>
              </div>
            );
          }
          const n = r.node.node;
          const own = n.facts.filter((f) => sharedText.get(f.key) !== f.text);
          return [
            <div key={n.key} {...common} className={`stage-tree-row stage-tree-item${selected ? ' selected' : ''}`}
              onClick={(e) => {
                // A double-click's second click leaves the selection as it is: the row opens.
                if (e.detail <= 1) select(selected ? null : n.key);
              }}
              onDoubleClick={(e) => onOpen(n, e.currentTarget.querySelector('.stage-tree-dot'))}>
              <span role="gridcell" className="stage-tree-name">
                <span className="stage-tree-dot" aria-hidden="true" />
                <span className="stage-tree-label">
                  <span className="stage-tree-title">{n.label}</span>
                  {state.flat && n.folders[0] && <span className="stage-tree-path muted">{n.folders[0].split('/').join(' › ')}</span>}
                  {own.length > 0 && (
                    <span className="stage-tree-facts">
                      {own.map((f) => <span key={f.key} className={f.key === 'browser' ? 'stage-tree-warn' : undefined}>{f.text}</span>)}
                    </span>
                  )}
                </span>
              </span>
              <span role="gridcell" className="stage-tree-size">
                <SizeTrack ruler={size}>{size && n.size > 0 && <i className="stage-tree-mark" style={{ left: `${onRuler(size, n.size) * 100}%` }} />}</SizeTrack>
                <span className="stage-tree-bytes">{n.size ? formatBytes(n.size) : '—'}</span>
              </span>
              <span role="gridcell" className="stage-tree-date muted">{n.date ? formatDate(n.date) : ''}</span>
            </div>,
            selected && (
              <div key={`${n.key}:look`} role="row" aria-level={r.level} className="stage-tree-look-row" style={common.style}>
                <div role="gridcell" className="stage-tree-look">
                  <Look node={n} byKey={byKey} onOpen={() => onOpen(n, dotOf(n.key))} onReveal={onReveal} />
                </div>
              </div>
            ),
          ];
        })}
        {drawn.length < rows.length && (
          <p className="stage-tree-none">
            <button type="button" className="link-button" onClick={() => setLimit(drawn.length + ROWS_AT_ONCE)}>
              Show {Math.min(ROWS_AT_ONCE, rows.length - drawn.length)} more
            </button>{' '}
            <span className="muted">of {rows.length - drawn.length} not shown</span>
          </p>
        )}
        {!rows.length && (
          <p className="stage-tree-none muted">
            Nothing here matches{state.query ? ` “${state.query}”` : ' those filters'}.{' '}
            <button type="button" className="link-button" onClick={() => onState({ query: '', filters: new Set() })}>Show everything</button>
          </p>
        )}
      </div>
    </section>
  );
}

const countFolders = (f: TreeFolder): number => f.children.reduce((n, c) => n + (c.kind === 'folder' ? 1 + countFolders(c) : 0), 0);

// The stage's log ruler behind a row's size marks: a faint line at each KB, MB, GB and TB.
function SizeTrack({ ruler: r, children }: { ruler: Ruler | null; children: ReactNode }) {
  return (
    <span className="stage-tree-track" aria-hidden="true">
      {r?.marks.map((m) => <i key={m.label} className="stage-tree-gridline" style={{ left: `${m.at * 100}%` }} />)}
      {children}
    </span>
  );
}

// The look under a selected row: what the item is, where it came from and what came of it,
// and what can be done with it.
function Look({ node, byKey, onOpen, onReveal }: {
  node: StageNode; byKey: Map<string, StageNode>; onOpen: () => void; onReveal: (n: StageNode) => void;
}) {
  const { collection, library } = useStudio();
  const d = node.dataset;
  const description = (d?.description ?? '').trim();
  const item = library.itemByKey.get(itemKey(node.target.datasetId, node.target.path));
  const cirro = d ? collection.datasetUrl(d.id) : null;
  const pill = (key: string) => {
    const x = byKey.get(key)!;
    return (
      <button key={key} type="button" className="stage-tree-pill" style={{ '--c': `var(${stageOf(x.stage).color})` } as CSSProperties} onClick={() => onReveal(x)} title={x.label}>
        <i />{x.label}{x.size > 0 && <span className="muted"> · {formatBytes(x.size)}</span>}
      </button>
    );
  };
  return (
    <>
      <div className="stage-tree-look-text">
        {description && <p>{description.length > DESCRIPTION_CHARS ? `${description.slice(0, DESCRIPTION_CHARS).replace(/\s+\S*$/, '')}…` : description}</p>}
        <p className="muted">
          {[d?.processName, d?.createdBy ? `added by ${d.createdBy}` : null, node.date ? formatDate(node.date) : null].filter(Boolean).join(' · ')}
          {cirro && <> · <a href={cirro} target="_blank" rel="noreferrer">Open the dataset in Cirro ↗</a></>}
          {d?.credit && (
            <> · data <a href={d.credit.url} target="_blank" rel="noreferrer">{d.credit.source}</a>, {d.credit.by}, <a href={d.credit.licenseUrl} target="_blank" rel="noreferrer">{d.credit.license}</a></>
          )}
        </p>
        {(node.from.length > 0 || node.into.length > 0) && (
          <dl className="stage-tree-lineage">
            {node.from.length > 0 && <><dt>Made from</dt><dd>{node.from.map(pill)}</dd></>}
            {node.into.length > 0 && <><dt>Made into</dt><dd>{node.into.map(pill)}</dd></>}
          </dl>
        )}
      </div>
      <div className="stage-tree-look-actions">
        <button type="button" className="button button-primary" onClick={onOpen}>Open</button>
        {collection.kind === 'cirro' && item && (
          <button type="button" className="button" title="Every squidpy and scanpy analysis, on a machine in this project, in a new tab"
            onClick={() => openWorkspaces(requestFor(item, node.label, library))}>
            Open in an Analysis Workspace
          </button>
        )}
      </div>
      {(node.stage === 'runs' || node.stage === 'images') && (
        <div className="stage-tree-look-make">
          <PipelineLinks datasetId={node.target.datasetId} purpose={node.stage === 'runs' ? 'encode' : 'segment'}
            about={node.stage === 'runs' ? 'Make spatial data from it in Cirro:' : 'Find its cells in Cirro:'} />
        </div>
      )}
    </>
  );
}
