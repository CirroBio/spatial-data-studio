// One stage opened: its items packed by folder (or tag, or month), a circle you step
// into by clicking and out of with Esc or a click on empty space. A list beside it is
// the same content for reading and for the keyboard. The bubbles are the map's
// BubbleLayer: this says where each belongs, the other stages' resting in the rail.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { STAGES, stageOf, type StageId } from '../app/library';
import { BY_PARAM, GROUP_PARAM, LENS_PARAM, navigate, openItem, STAGE_PARAM, stepBack, useRoute } from '../app/route';
import { formatBytes, formatDate, plural, STAGE_ICONS, tint } from '../app/ui';
import { useSize } from '../lib/useSize';
import { parkBubble, type Bubble, type Scene } from './BubbleLayer';
import { groupTree, packCluster, packTree, type Grouping, type PackedNode, type StageNode } from './nodes';

const GROUPINGS: { id: Grouping; label: string }[] = [
  { id: 'folders', label: 'Folders' }, { id: 'tags', label: 'Tags' }, { id: 'time', label: 'Time' },
];
const FLOOR_SHARE = 0.01;
// Room around the focused circle for its name, which sits just above it.
const VIEW_MARGIN = 1.1;
// Opening an item: its bubble grows to cover the page, faded to a tint of its color.
const OPEN_MS = 450;
const OPEN_TINT = 0.12;
// Above this many items a stage shows their list from the start.
const LIST_FROM = 20;

function Rail({ current, nodes, slots }: {
  current: StageId; nodes: Record<StageId, StageNode[]>; slots: RefObject<Partial<Record<StageId, HTMLElement>>>;
}) {
  return (
    <nav className="map-rail" aria-label="Stages">
      {STAGES.map((s) => (
        <button key={s.id} type="button" className="map-rail-stage" style={tint(s.color)} aria-current={s.id === current}
          onClick={() => navigate({ section: 'stage', [STAGE_PARAM]: s.id, [GROUP_PARAM]: null })}>
          {/* Where the stage's bubbles rest while another stage is open; its icon when it has none. */}
          <span className="map-rail-icon" ref={(el) => { if (el) slots.current[s.id] = el; else delete slots.current[s.id]; }}>
            {(s.id === current || !nodes[s.id].length) && STAGE_ICONS[s.id]}
          </span>
          <span className="map-rail-name">{s.label}</span>
          <span className="map-rail-caption">{plural(nodes[s.id].length, s.unit)}</span>
          {s.id === current && <span className="map-rail-here">Shown on the right →</span>}
        </button>
      ))}
    </nav>
  );
}

function Card({ node }: { node: StageNode }) {
  return (
    <div className="map-card" role="tooltip">
      <strong>{node.label}</strong>
      {node.datasetName !== node.label && <span className="muted">{node.datasetName}</span>}
      <span className="muted">
        {[node.size ? formatBytes(node.size) : null, formatDate(node.date) || null, node.versions ? plural(node.versions, ['version', 'versions']) : null]
          .filter(Boolean).join(' · ')}
      </span>
    </div>
  );
}

export function StageView({ stage, nodes, onScene }: {
  stage: StageId; nodes: Record<StageId, StageNode[]>; onScene: (scene: Scene) => void;
}) {
  const route = useRoute();
  const info = stageOf(stage);
  const grouping = (route.params.get(BY_PARAM) as Grouping | null) ?? 'folders';
  const focusPath = route.params.get(GROUP_PARAM) ?? '';
  const [filter, setFilter] = useState('');
  // A stage of many items opens with their list beside the bubbles: too many to name inside them.
  const [list, setList] = useState(() => nodes[stage].length > LIST_FROM);
  const [hover, setHover] = useState<StageNode | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const slots = useRef<Partial<Record<StageId, HTMLElement>>>({});
  const { width, height } = useSize(ref);
  const side = Math.max(1, Math.min(width, height));

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? nodes[stage].filter((n) => `${n.label} ${n.datasetName} ${n.tags.join(' ')} ${n.folders.join(' ')}`.toLowerCase().includes(f)) : nodes[stage];
  }, [nodes, stage, filter]);

  const root = useMemo(() => {
    const largest = Math.max(1, ...shown.map((n) => n.size));
    return packTree(groupTree(shown, grouping), 1000, 1000, largest * FLOOR_SHARE);
  }, [shown, grouping]);

  const focus: PackedNode = root.descendants().find((d) => !d.data.node && d.data.path === focusPath) ?? root;

  // The bubble grows over the page, then the page opens; the map coming back shrinks it
  // into its place again (parkBubble).
  const open = (n: StageNode) => {
    const go = () => openItem(n.target.datasetId, n.target.path, n.target.lens ? { [LENS_PARAM]: n.target.lens } : {});
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !page.current) {
      go();
      return;
    }
    const at = page.current.getBoundingClientRect();
    parkBubble(n.key, { x: at.left + at.width / 2, y: at.top + at.height / 2, r: Math.hypot(at.width, at.height) / 2, a: OPEN_TINT });
    setOpening(n.key);
    setTimeout(go, OPEN_MS);
  };

  useLayoutEffect(() => {
    if (!ref.current || !page.current || !width) return;
    const at = ref.current.getBoundingClientRect();
    const scale = side / (2 * focus.r * VIEW_MARGIN);
    const toScreen = (x: number, y: number) => [at.left + width / 2 + (x - focus.x) * scale, at.top + height / 2 + (y - focus.y) * scale] as const;
    const bubbles: Bubble[] = root.descendants().slice(1).map((d): Bubble => {
      const [x, y] = toScreen(d.x, d.y);
      const r = d.r * scale;
      const n = d.data.node;
      if (!n) {
        return {
          key: `group:${grouping}:${d.data.path}`, kind: 'group', x, y, r, tint: info.color, opacity: opening ? 0 : 1,
          label: r > 40 ? d.data.name : undefined, onClick: () => navigate({ [GROUP_PARAM]: d.data.path }),
        };
      }
      if (n.key === opening) {
        const p = page.current!.getBoundingClientRect();
        return { key: n.key, kind: 'leaf', x: p.left + p.width / 2, y: p.top + p.height / 2, r: Math.hypot(p.width, p.height) / 2, opacity: OPEN_TINT, tint: info.color };
      }
      return {
        key: n.key, kind: 'leaf', x, y, r, tint: info.color, versions: n.versions, opacity: opening ? 0 : 1,
        label: n.label, onClick: () => open(n), onHover: (over) => setHover((h) => (over ? n : h === n ? null : h)),
      };
    });
    // The other stages rest in their places in the rail (hidden on a narrow screen,
    // where they leave the picture instead).
    for (const s of STAGES) {
      const slot = slots.current[s.id];
      const box = slot?.getBoundingClientRect();
      if (s.id === stage || !box?.width || !nodes[s.id].length) continue;
      const largest = Math.max(1, ...nodes[s.id].map((n) => n.size));
      for (const p of packCluster(nodes[s.id], box.width, largest * FLOOR_SHARE)) {
        bubbles.push({ key: p.node.key, kind: 'leaf', x: box.left + p.x, y: box.top + p.y, r: p.r, tint: s.color, versions: p.node.versions, opacity: opening ? 0 : 1 });
      }
    }
    onScene({ id: opening ? `open:${opening}` : `stage:${stage}:${grouping}:${focus.data.path}:${filter}`, bubbles, duration: opening ? OPEN_MS : undefined });
  }, [root, focus, grouping, stage, nodes, width, height, side, opening, filter, info.color, onScene]);

  const stepOut = () => {
    if (!focus.parent) return;
    stepBack({ [GROUP_PARAM]: focus.parent.data.path || null });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.popover-panel')) return;
      if (focus.parent) stepOut();
      else stepBack({ section: 'home', [STAGE_PARAM]: null, [GROUP_PARAM]: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const crumbs = focus.ancestors().reverse().slice(1);
  const inFocus = focus.leaves().filter((l) => l.data.node).map((l) => l.data.node!);

  return (
    <div className="map-stage-view" style={tint(info.color)} ref={page}>
      <Rail current={stage} nodes={nodes} slots={slots} />
      <section className="map-main">
        <div className="map-bar">
          <nav className="map-crumbs" aria-label="Where you are">
            <button type="button" className="map-crumb" onClick={() => navigate({ section: 'home', [STAGE_PARAM]: null, [GROUP_PARAM]: null })}>
              <span className="map-crumb-dot" /> All data
            </button>
            <span className="map-sep">›</span>
            <button type="button" className="map-crumb" disabled={!crumbs.length} onClick={() => navigate({ [GROUP_PARAM]: null })}>
              <span className="map-crumb-dot" style={{ color: `var(${info.color})` }} /> {info.label}
            </button>
            {crumbs.map((c, i) => (
              <span key={c.data.path} className="map-crumb-step">
                <span className="map-sep">›</span>
                <button type="button" className="map-crumb" disabled={i === crumbs.length - 1} onClick={() => navigate({ [GROUP_PARAM]: c.data.path })}>
                  <span className="map-crumb-dot" /> {c.data.name}
                </button>
              </span>
            ))}
          </nav>
          <input className="input map-search" type="search" placeholder={`Filter ${info.unit[1]}`} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="map-seg" role="group" aria-label="Group by">
            {GROUPINGS.map((g) => (
              <button key={g.id} type="button" aria-pressed={grouping === g.id}
                onClick={() => navigate({ [BY_PARAM]: g.id === 'folders' ? null : g.id, [GROUP_PARAM]: null }, { replace: true })}>
                {g.label}
              </button>
            ))}
          </div>
          <button type="button" className="map-tool" aria-pressed={list} onClick={() => setList((l) => !l)}>List</button>
        </div>
        <div className="map-canvas" ref={ref} onClick={(e) => { if (e.target === e.currentTarget) stepOut(); }}>
          {!shown.length && <p className="map-empty-note muted">{filter ? 'Nothing matches the filter.' : `No ${info.unit[1]} in this project yet.`}</p>}
          {hover && <Card node={hover} />}
          {list && (
            <aside className="map-list" aria-label={`${info.label} here`}>
              <ul>
                {inFocus.map((n) => (
                  <li key={n.key}>
                    <button type="button" className="map-list-row" onClick={() => open(n)}>
                      <span className="map-list-dot" />
                      <span className="map-list-text">
                        <span>{n.label}</span>
                        <span className="muted">
                          {[n.datasetName !== n.label ? n.datasetName : null, n.versions ? plural(n.versions, ['version', 'versions']) : null].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="muted">{n.size ? formatBytes(n.size) : ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </div>
        <p className="map-hint">Click a group to step into it and an item to open it; Esc or a click on empty space steps back out.</p>
      </section>
    </div>
  );
}
