// The map's bubbles: one SVG over the whole map that stays while the views change around
// it. Each view says where every bubble belongs, and the bubbles move there, so the one
// for a dataset keeps its identity from the overview into its stage, between groupings,
// in and out of folders, and into the page it opens (as Expression Studio's map does).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { tint } from '../app/ui';
import { labelLines } from './nodes';

export interface Bubble {
  key: string;
  kind: 'leaf' | 'group';
  // Where it belongs, in viewport pixels.
  x: number;
  y: number;
  r: number;
  opacity?: number;
  // The stage color's CSS variable.
  tint: string;
  versions?: number;
  // A leaf's name, drawn inside it; a group's, drawn above it.
  label?: string;
  // A bubble with an action takes the pointer; the rest let it through to the page.
  onClick?: () => void;
  onHover?: (over: boolean) => void;
}

export interface Scene {
  // A new id moves the bubbles; the same id (a resize) puts them in place at once.
  id: string;
  bubbles: Bubble[];
  duration?: number;
}

interface Pose { x: number; y: number; r: number; a: number }
interface Live { bubble: Bubble; from: Pose; to: Pose; cur: Pose; leaving: boolean }

const DURATION = 800;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a: Pose, b: Pose, e: number): Pose => ({
  x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, r: a.r + (b.r - a.r) * e, a: a.a + (b.a - a.a) * e,
});
const ringRadius = (r: number, k: number) => r * (0.86 - k * 0.09);
// Groups under what they hold, leaving ones included (they are kept after the rest).
const LAYER: Record<Bubble['kind'], number> = { group: 0, leaf: 1 };
// Smaller than this, a bubble's name wouldn't fit enough of itself to read; from
// LABEL_THREE_LINES_R it has room for a third line.
const LABEL_MIN_R = 34;
const LABEL_THREE_LINES_R = 44;
const MAX_RINGS = 8;

// The bubble a page was opened from, as it covered the page: the map coming back grows
// out of the page into it rather than starting from nothing.
let parked: { key: string; pose: Pose } | null = null;
export function parkBubble(key: string, pose: Pose) {
  parked = { key, pose };
}

export function BubbleLayer({ scene }: { scene: Scene | null }) {
  const svg = useRef<SVGSVGElement>(null);
  const live = useRef(new Map<string, Live>());
  const elements = useRef(new Map<string, SVGGElement>());
  const lastScene = useRef<string | null>(null);
  const frame = useRef(0);
  const [, rerender] = useState(0);
  const [moving, setMoving] = useState(false);

  useLayoutEffect(() => {
    if (!scene || !svg.current) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // A parked bubble belongs to the first scene of a map that has just come back.
    const returning = lastScene.current === null ? parked : null;
    const duration = reduce || scene.id === lastScene.current ? 0 : scene.duration ?? DURATION;
    lastScene.current = scene.id;
    const origin = svg.current.getBoundingClientRect();
    const local = (p: Pose): Pose => ({ ...p, x: p.x - origin.left, y: p.y - origin.top });
    const next = new Map<string, Live>();
    for (const bubble of scene.bubbles) {
      const to = local({ x: bubble.x, y: bubble.y, r: bubble.r, a: bubble.opacity ?? 1 });
      const prev = live.current.get(bubble.key);
      const from = prev ? prev.cur : returning?.key === bubble.key ? local(returning.pose) : { ...to, r: 0, a: 0 };
      next.set(bubble.key, { bubble, from, to, cur: duration ? from : to, leaving: false });
    }
    if (returning) parked = null;
    if (duration) {
      for (const [key, n] of live.current) {
        if (!next.has(key)) next.set(key, { ...n, from: n.cur, to: { ...n.cur, r: 0, a: 0 }, leaving: true });
      }
    }
    live.current = next;
    cancelAnimationFrame(frame.current);
    setMoving(duration > 0);
    rerender((v) => v + 1);
    if (!duration) return;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = ease(t);
      for (const [key, n] of live.current) {
        n.cur = lerp(n.from, n.to, e);
        const g = elements.current.get(key);
        if (!g) continue;
        g.setAttribute('transform', `translate(${n.cur.x} ${n.cur.y})`);
        g.style.opacity = String(n.cur.a);
        const circles = g.querySelectorAll('circle');
        circles.forEach((c, k) => c.setAttribute('r', String(Math.max(0, k === 0 ? n.cur.r : ringRadius(n.cur.r, k - 1)))));
      }
      if (t < 1) {
        frame.current = requestAnimationFrame(step);
        return;
      }
      for (const [key, n] of live.current) if (n.leaving) live.current.delete(key);
      setMoving(false);
      rerender((v) => v + 1);
    };
    frame.current = requestAnimationFrame(step);
  }, [scene]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return (
    <svg ref={svg} className={moving ? 'bubble-layer bubble-layer-moving' : 'bubble-layer'} aria-hidden="true">
      {[...live.current].sort(([, a], [, b]) => LAYER[a.bubble.kind] - LAYER[b.bubble.kind]).map(([key, n]) => {
        const { bubble: b, cur } = n;
        const rings = b.kind === 'leaf' ? Math.min(b.versions ?? 0, MAX_RINGS) : 0;
        // Labels are laid out for where the bubble ends up, and shown once it is there.
        const lines = b.kind === 'leaf' && b.label && n.to.r >= LABEL_MIN_R ? labelLines(b.label, Math.floor(n.to.r / 4), n.to.r >= LABEL_THREE_LINES_R ? 3 : 2) : [];
        return (
          <g key={key} ref={(el) => { if (el) elements.current.set(key, el); else elements.current.delete(key); }}
            className={`bubble bubble-${b.kind}`} data-active={b.onClick && !n.leaving ? '' : undefined}
            transform={`translate(${cur.x} ${cur.y})`} style={{ ...tint(b.tint), opacity: cur.a }}
            onClick={b.onClick && !n.leaving ? (e) => { e.stopPropagation(); b.onClick!(); } : undefined}
            onMouseEnter={b.onHover ? () => b.onHover!(true) : undefined}
            onMouseLeave={b.onHover ? () => b.onHover!(false) : undefined}>
            <circle r={Math.max(0, cur.r)} />
            {Array.from({ length: rings }, (_, k) => <circle key={k} r={Math.max(0, ringRadius(cur.r, k))} className="bubble-ring" />)}
            {lines.length > 0 && (
              <text y={4 - (lines.length - 1) * 7} textAnchor="middle" className="bubble-label">
                {lines.map((line, i) => <tspan key={i} x={0} dy={i ? 14 : 0}>{line}</tspan>)}
              </text>
            )}
            {b.kind === 'group' && b.label && <text y={-n.to.r - 6} textAnchor="middle" className="bubble-name">{b.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}
