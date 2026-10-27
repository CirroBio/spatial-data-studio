// One stage opened: the stage's items as a tree of their folders (StageTree.tsx), beside a
// rail of the four stages, each a small cluster of its bubbles: the open stage's is its
// minimap, dimmed where the search leaves items out, with the selected item and its lineage
// ringed. The bubbles are the map's BubbleLayer, so the overview's carry on into the rail, and
// an item opened from its row grows from the row's dot over the page.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { STAGES, stageOf, type StageId } from '../app/library';
import {
  FILTER_PARAM, FLAT_PARAM, LENS_PARAM, navigate, openItem, QUERY_PARAM, SELECT_PARAM, SORT_PARAM, STAGE_PARAM, stepBack, useRoute,
} from '../app/route';
import { plural, STAGE_ICONS, tint } from '../app/ui';
import { useSize } from '../lib/useSize';
import { SORT_KEYS, type SortKey } from './browse';
import { parkBubble, type Bubble, type Scene } from './BubbleLayer';
import { packCluster, type StageNode } from './nodes';
import { StageTree, type BrowseState } from './StageTree';

const FLOOR_SHARE = 0.01;
// Opening an item: its row's dot grows to cover the page, faded to a tint of its color.
const OPEN_MS = 450;
const OPEN_TINT = 0.12;
// How the minimap shows the open stage's items the search or filters leave out.
const DIMMED = 0.25;
const FILTER_SEP = '|';

// What the browser shows, as the address holds it.
function browseOf(params: URLSearchParams): BrowseState {
  const sort = params.get(SORT_PARAM) as SortKey | null;
  return {
    selected: params.get(SELECT_PARAM),
    query: params.get(QUERY_PARAM) ?? '',
    sort: sort && SORT_KEYS.includes(sort) ? sort : 'name',
    flat: params.get(FLAT_PARAM) === '1',
    filters: new Set((params.get(FILTER_PARAM) ?? '').split(FILTER_SEP).filter(Boolean)),
  };
}

function addressOf(patch: Partial<BrowseState>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if ('selected' in patch) out[SELECT_PARAM] = patch.selected ?? null;
  if ('query' in patch) out[QUERY_PARAM] = patch.query || null;
  if (patch.sort) out[SORT_PARAM] = patch.sort === 'name' ? null : patch.sort;
  if ('flat' in patch) out[FLAT_PARAM] = patch.flat ? '1' : null;
  if (patch.filters) out[FILTER_PARAM] = patch.filters.size ? [...patch.filters].join(FILTER_SEP) : null;
  return out;
}

// Moving to another stage, or back to the overview, leaves this stage's selection and search behind.
const leaving = { [SELECT_PARAM]: null, [QUERY_PARAM]: null, [FILTER_PARAM]: null };

function Rail({ current, nodes, slots }: {
  current: StageId; nodes: Record<StageId, StageNode[]>; slots: RefObject<Partial<Record<StageId, HTMLElement>>>;
}) {
  return (
    <nav className="map-rail" aria-label="Stages">
      {STAGES.map((s) => (
        <button key={s.id} type="button" className="map-rail-stage" style={tint(s.color)} aria-current={s.id === current}
          onClick={() => navigate({ section: 'stage', [STAGE_PARAM]: s.id, ...leaving })}>
          <span className="map-rail-name">{s.label}</span>
          <span className="map-rail-caption">{plural(nodes[s.id].length, s.unit)}</span>
          {/* Where the stage's bubbles rest as its minimap; its icon when it has none. */}
          <span className="map-rail-map" ref={(el) => { if (el) slots.current[s.id] = el; else delete slots.current[s.id]; }}>
            {!nodes[s.id].length && STAGE_ICONS[s.id]}
          </span>
        </button>
      ))}
    </nav>
  );
}

interface Opening { node: StageNode; dot: { x: number; y: number; r: number }; grown: boolean }

export function StageView({ stage, nodes, onScene }: {
  stage: StageId; nodes: Record<StageId, StageNode[]>; onScene: (scene: Scene) => void;
}) {
  const route = useRoute();
  const info = stageOf(stage);
  // One object per address, so what is derived from it (the search, the filters) holds still.
  const state = useMemo(() => browseOf(route.params), [route.params]);
  const onState = useCallback((patch: Partial<BrowseState>) => navigate(addressOf(patch), { replace: true }), []);
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [match, setMatch] = useState<Set<string> | null>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const slots = useRef<Partial<Record<StageId, HTMLElement>>>({});
  const search = useRef<HTMLInputElement>(null);
  const { width, height } = useSize(page);

  const selected = nodes[stage].find((n) => n.key === state.selected) ?? null;

  const openNode = (n: StageNode, dot: Element | null) => {
    const go = () => openItem(n.target.datasetId, n.target.path, n.target.lens ? { [LENS_PARAM]: n.target.lens } : {});
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !dot || !page.current) {
      go();
      return;
    }
    const d = dot.getBoundingClientRect();
    const at = page.current.getBoundingClientRect();
    // The map coming back shrinks the bubble from the page into its place again.
    parkBubble(n.key, { x: at.left + at.width / 2, y: at.top + at.height / 2, r: Math.hypot(at.width, at.height) / 2, a: OPEN_TINT });
    setOpening({ node: n, dot: { x: d.left + d.width / 2, y: d.top + d.height / 2, r: d.width / 2 }, grown: false });
    setTimeout(go, OPEN_MS);
  };
  // The dot is put in place first, then grows: two scenes, a frame apart.
  useEffect(() => {
    if (!opening || opening.grown) return;
    const frame = requestAnimationFrame(() => setOpening({ ...opening, grown: true }));
    return () => cancelAnimationFrame(frame);
  }, [opening]);

  const reveal = (n: StageNode) => navigate({ section: 'stage', [STAGE_PARAM]: n.stage, ...leaving, [SELECT_PARAM]: n.key });

  useLayoutEffect(() => {
    if (!page.current || !width) return;
    const marked = new Set(selected ? [selected.key, ...selected.from, ...selected.into] : []);
    const bubbles: Bubble[] = [];
    for (const s of STAGES) {
      const box = slots.current[s.id]?.getBoundingClientRect();
      if (!box?.width || !nodes[s.id].length) continue;
      const largest = Math.max(1, ...nodes[s.id].map((n) => n.size));
      // A circle as wide as the slot allows, in its middle.
      const d = Math.min(box.width, box.height);
      const left = box.left + (box.width - d) / 2;
      const top = box.top + (box.height - d) / 2;
      for (const p of packCluster(nodes[s.id], d, largest * FLOOR_SHARE)) {
        if (p.node.key === opening?.node.key) continue;
        const dim = s.id === stage && match && !match.has(p.node.key);
        bubbles.push({
          key: p.node.key, kind: 'leaf', x: left + p.x, y: top + p.y, r: p.r, tint: s.color, versions: p.node.versions,
          marked: marked.has(p.node.key), opacity: opening ? 0 : dim ? DIMMED : 1,
        });
      }
    }
    if (opening) {
      const at = page.current.getBoundingClientRect();
      const pose = opening.grown
        ? { x: at.left + at.width / 2, y: at.top + at.height / 2, r: Math.hypot(at.width, at.height) / 2, opacity: OPEN_TINT }
        : { ...opening.dot, opacity: 1 };
      bubbles.push({ key: opening.node.key, kind: 'leaf', tint: info.color, ...pose });
    }
    const id = opening ? `open:${opening.node.key}:${opening.grown}` : `stage:${stage}:${state.selected}:${[...(match ?? [])].length}:${state.query}`;
    onScene({ id, bubbles, duration: opening ? (opening.grown ? OPEN_MS : 0) : undefined });
  }, [nodes, stage, selected, match, opening, width, height, state.selected, state.query, info.color, onScene]);

  // Esc closes the look under a row, then goes back to the overview; / finds.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select');
      if (e.key === '/' && !typing) {
        e.preventDefault();
        search.current?.focus();
        return;
      }
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.popover-panel, .modal-backdrop')) return;
      if (state.selected) onState({ selected: null });
      else stepBack({ section: 'home', [STAGE_PARAM]: null, ...leaving });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.selected, onState]);

  return (
    <div className="map-stage-view" style={tint(info.color)} ref={page}>
      <Rail current={stage} nodes={nodes} slots={slots} />
      <section className="map-main">
        <div className="map-bar">
          <nav className="map-crumbs" aria-label="Where you are">
            <button type="button" className="map-crumb" onClick={() => navigate({ section: 'home', [STAGE_PARAM]: null, ...leaving })}>
              <span className="map-crumb-dot" /> All data
            </button>
            <span className="map-sep">›</span>
            <button type="button" className="map-crumb" disabled>
              <span className="map-crumb-dot" style={{ color: `var(${info.color})` }} /> {info.label}
            </button>
          </nav>
        </div>
        <div className="map-browser">
          <StageTree stage={stage} nodes={nodes} state={state} onState={onState} open={open} onOpenFolders={setOpen}
            onOpen={openNode} onReveal={reveal} onMatch={setMatch} searchRef={search} />
        </div>
        <p className="map-hint">Click a row for more about it; double-click it, or Enter, opens it. / finds; Esc steps back.</p>
      </section>
    </div>
  );
}
