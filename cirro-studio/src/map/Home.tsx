// The project at a glance: the four stages side by side, each a cluster of bubbles whose
// areas share one scale of bytes, with lines from each run or image to the spatial data
// made from it. A bubble opens its item, anywhere else in a stage opens the stage's list,
// and the bubbles carry on into it: they are drawn by the map's BubbleLayer, which this
// only tells where they belong.
import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { STAGES, type StageId } from '../app/library';
import { LEAVING_STAGE, LENS_PARAM, navigate, openItem, STAGE_PARAM } from '../app/route';
import { useStudio } from '../app/studio';
import { formatBytes, plural, STAGE_ICONS, tint } from '../app/ui';
import { useSize } from '../lib/useSize';
import type { Bubble, Scene } from './BubbleLayer';
import { packCluster, type StageNode } from './nodes';

const HEAD_HEIGHT = 176;
// The headings are smaller where the stages wrap (app.css), leaving the bubbles more of each row.
const NARROW_HEAD_HEIGHT = 124;
const FOOT_HEIGHT = 24;
// The stylesheet's breakpoint (app.css, .map-landing) where the stages wrap to two
// columns; the bubbles follow their labels into the second row.
const TWO_COLUMNS_BELOW = 860;
// A bubble's area is the square root of its bytes, so a 10 GB store doesn't leave a 10 MB
// one a speck; and no bubble is narrower than this share of the largest, so every item
// (a figure, which has no bytes of its own) is something to point at.
const FLOOR_WIDTH = 0.3;

interface Placed { x: number; y: number; r: number; node: StageNode }

export function Home({ nodes, onScene }: { nodes: Record<StageId, StageNode[]>; onScene: (scene: Scene) => void }) {
  const { catalog, library } = useStudio();
  const ref = useRef<HTMLDivElement>(null);
  const { width, height } = useSize(ref);

  const layout = useMemo(() => {
    if (!width || !height) return null;
    const narrow = width <= TWO_COLUMNS_BELOW;
    const perRow = narrow ? 2 : STAGES.length;
    const head = narrow ? NARROW_HEAD_HEIGHT : HEAD_HEIGHT;
    const rows = Math.ceil(STAGES.length / perRow);
    const colWidth = width / perRow;
    const rowHeight = height / rows;
    const maxD = Math.max(60, Math.min(colWidth - 40, rowHeight - head - FOOT_HEIGHT - 24));
    const all = STAGES.flatMap((s) => nodes[s.id]);
    const floor = Math.sqrt(Math.max(1, ...all.map((n) => n.size))) * FLOOR_WIDTH ** 2;
    const weight = (n: StageNode) => Math.max(Math.sqrt(n.size), floor);
    const totals = STAGES.map((s) => nodes[s.id].reduce((sum, n) => sum + weight(n), 0));
    const maxTotal = Math.max(1, ...totals);
    const placed = new Map<string, Placed>();
    const columns = STAGES.map((s, i) => {
      const d = totals[i] ? Math.max(48, maxD * Math.sqrt(totals[i] / maxTotal)) : 0;
      const cx = colWidth * ((i % perRow) + 0.5);
      const row = Math.floor(i / perRow);
      // On one line under the headings, the widest cluster just clear of them.
      const cy = row * rowHeight + head + maxD / 2;
      if (d) {
        for (const p of packCluster(nodes[s.id], d, weight)) placed.set(p.node.key, { ...p, x: cx - d / 2 + p.x, y: cy - d / 2 + p.y });
      }
      return { stage: s, cx, cy, d };
    });
    return { columns, placed };
  }, [nodes, width, height]);

  useLayoutEffect(() => {
    if (!layout || !ref.current) return;
    const at = ref.current.getBoundingClientRect();
    const bubbles = layout.columns.flatMap(({ stage }) => nodes[stage.id].flatMap((n): Bubble[] => {
      const p = layout.placed.get(n.key);
      return p ? [{ key: n.key, kind: 'leaf', x: at.left + p.x, y: at.top + p.y, r: p.r, tint: stage.color, versions: n.versions, label: n.label }] : [];
    }));
    onScene({ id: 'home', bubbles });
  }, [layout, nodes, onScene]);

  // The bubble under the pointer, found by position: the bubbles are drawn on a layer
  // over the page, and the stage's button sits beneath them.
  const [hovered, setHovered] = useState<StageNode | null>(null);
  const bubbleAt = (e: MouseEvent, stage: StageId): StageNode | null => {
    if (!layout || !ref.current) return null;
    const at = ref.current.getBoundingClientRect();
    const [x, y] = [e.clientX - at.left, e.clientY - at.top];
    return nodes[stage].find((n) => {
      const p = layout.placed.get(n.key);
      return p !== undefined && (x - p.x) ** 2 + (y - p.y) ** 2 <= p.r ** 2;
    }) ?? null;
  };
  const open = (e: MouseEvent, stage: StageId) => {
    const n = bubbleAt(e, stage);
    if (n) openItem(n.target.datasetId, n.target.path, n.target.lens ? { [LENS_PARAM]: n.target.lens } : {});
    else navigate({ section: 'stage', [STAGE_PARAM]: stage, ...LEAVING_STAGE });
  };

  const totalBytes = (id: StageId) => nodes[id].reduce((s, n) => s + n.size, 0);
  const caption = (id: StageId) => {
    const n = nodes[id];
    const stage = STAGES.find((s) => s.id === id)!;
    if (!n.length) {
      if (catalog.status === 'loading' || catalog.status === 'scanning') return 'Looking…';
      return `No ${stage.unit[1]} yet`;
    }
    return id === 'figures' ? plural(n.length, stage.unit) : `${plural(n.length, stage.unit)} · ${formatBytes(totalBytes(id))}`;
  };

  return (
    <div className="map-home" ref={ref}>
      {layout && (
        <svg className="map-home-canvas" width={width} height={height} aria-hidden="true">
          {/* Drawn once the bubbles have landed: they join bubbles the layer is still moving. */}
          <g className="map-links">
            {library.links.map((l) => {
              const a = layout.placed.get(l.from);
              const b = layout.placed.get(l.to);
              if (!a || !b) return null;
              const mx = (a.x + b.x) / 2;
              return <path key={`${l.from}->${l.to}`} d={`M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`} />;
            })}
          </g>
        </svg>
      )}
      <div className="map-landing">
        {STAGES.map((s) => (
          <button key={s.id} type="button" className={nodes[s.id].length ? 'map-stage' : 'map-stage map-stage-empty'} style={tint(s.color)}
            title={hovered?.stage === s.id ? `Open ${hovered.label}` : `List the ${s.unit[1]}`}
            onClick={(e) => open(e, s.id)} onMouseMove={(e) => setHovered(bubbleAt(e, s.id))} onMouseLeave={() => setHovered(null)}>
            <span className="map-stage-head">
              <span className="map-icon">{STAGE_ICONS[s.id]}</span>
              <span className="map-stage-name">{s.label}</span>
              <span className="map-stage-caption">{caption(s.id)}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="map-tagline">Click a bubble to open it, or a heading to list everything there.</p>
      {hovered && layout?.placed.has(hovered.key) && (() => {
        const p = layout.placed.get(hovered.key)!;
        return (
          <p className="map-bubble-name" style={{ left: p.x, top: p.y - p.r }}>
            {hovered.label}{hovered.size > 0 && <span className="muted"> · {formatBytes(hovered.size)}</span>}
          </p>
        );
      })()}
    </div>
  );
}
