// An opened item as the Studio shows one: its view fills the page and its controls float
// over it in two drawers, the tasks on the left (where the Studio keeps its compute
// sidebar) and the display settings on the right (where the Studio's gear is), pulled in
// and pushed away with their tabs or the [ and ] keys; \ moves both.
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { appKey } from '../app/appInfo';

type Side = 'left' | 'right';
interface Open { left: boolean; right: boolean }

const STORAGE_KEY = appKey('drawers');
const LEFT_WIDTH = 300;
// A task's panel holds charts and tables, so the tasks drawer widens while one is open.
const TASK_WIDTH = 380;
const RIGHT_WIDTH = 288;
const GAP = 12;
// The room a closed drawer's tab takes at the top corner, which the views bar keeps clear of.
const TAB_ROOM = 124;
/** The strip at the top of the frame the views bar takes, which the canvas' overlays and a
 * sheet's content start below. */
export const BAR_ROOM = 40;
// Below this the drawers start closed: open, they would cover most of the view.
const ROOMY_WIDTH = 1100;

function initialOpen(): Open {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Open | null;
    if (saved) return saved;
  } catch {
    // Storage refused or unreadable: fall back to the default below.
  }
  const roomy = window.innerWidth >= ROOMY_WIDTH;
  return { left: roomy, right: roomy };
}

function remember(open: Open) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(open));
  } catch {
    // Not remembered; the drawers still move.
  }
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export interface Drawers {
  open: Open;
  toggle: (side: Side) => void;
  widths: { left: number; right: number };
  /** How much of the view's left and right edges the open drawers cover. */
  inset: { left: number; right: number };
}

/** The drawers' state: remembered in this browser, and the tasks drawer opens with a task. */
export function useDrawers(working: boolean): Drawers {
  const [open, setOpen] = useState(initialOpen);
  const toggle = useCallback((side: Side) => setOpen((o) => {
    const next = { ...o, [side]: !o[side] };
    remember(next);
    return next;
  }), []);
  // Both away, or both back: the view alone for presenting, then the controls again.
  const toggleBoth = useCallback(() => setOpen((o) => {
    const shown = !(o.left || o.right);
    const next = { left: shown, right: shown };
    remember(next);
    return next;
  }), []);
  useEffect(() => {
    if (working) setOpen((o) => (o.left ? o : { ...o, left: true }));
  }, [working]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === '[') toggle('left');
      else if (e.key === ']') toggle('right');
      else if (e.key === '\\') toggleBoth();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, toggleBoth]);
  const left = working ? TASK_WIDTH : LEFT_WIDTH;
  // Kept as one object while the drawers stay put: the canvas host is rebuilt when it changes.
  const inset = useMemo(
    () => ({ left: open.left ? left + GAP : 0, right: open.right ? RIGHT_WIDTH + GAP : 0 }),
    [open.left, open.right, left],
  );
  return { open, toggle, widths: { left, right: RIGHT_WIDTH }, inset };
}

const Chevron = ({ to }: { to: Side }) => (
  <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d={to === 'left' ? 'M10 3L5 8l5 5' : 'M6 3l5 5-5 5'} fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

export interface DrawerSpec {
  label: string;
  // Shown on the drawer's tab while it is away (the Display drawer's gear).
  icon?: ReactNode;
  content: ReactNode;
}

function Drawer({ side, spec, open, onToggle }: { side: Side; spec: DrawerSpec; open: boolean; onToggle: () => void }) {
  const key = side === 'left' ? '[' : ']';
  return (
    <>
      <aside className={`drawer drawer-${side}`} data-open={open} inert={!open} aria-label={spec.label}>
        <div className="drawer-head">
          <span className="drawer-label">{spec.label}</span>
          <button type="button" className="drawer-close" onClick={onToggle} title={`Hide (${key})`} aria-label={`Hide ${spec.label.toLowerCase()}`}>
            <Chevron to={side} />
          </button>
        </div>
        <div className="drawer-body">{spec.content}</div>
      </aside>
      {!open && (
        <button type="button" className={`drawer-tab drawer-tab-${side}`} onClick={onToggle} title={`Show (${key})`}>
          {side === 'right' && <Chevron to="left" />}
          {spec.icon}
          {spec.label}
          {side === 'left' && <Chevron to="right" />}
        </button>
      )}
    </>
  );
}

/** `main` fills the frame and `bar` (the views) floats over its top; a `sheet` (a list or
 * chart rather than the tissue) keeps clear of the open drawers instead of running under
 * them. Without `right` (a view with nothing to set) the right drawer and its tab are
 * away, and the view has that side to itself. */
export function ViewFrame({ drawers, left, right, bar, main, sheet = false }: {
  drawers: Drawers; left: DrawerSpec; right?: DrawerSpec; bar?: ReactNode; main: ReactNode; sheet?: boolean;
}) {
  const insetRight = right ? drawers.inset.right : 0;
  const style = {
    '--drawer-left': `${drawers.widths.left}px`, '--drawer-right': `${drawers.widths.right}px`, '--drawer-gap': `${GAP}px`,
    '--inset-left': `${drawers.inset.left}px`, '--inset-right': `${insetRight}px`,
    '--bar-left': `${drawers.open.left ? drawers.inset.left + GAP : TAB_ROOM}px`,
    '--bar-right': `${!right ? GAP : drawers.open.right ? insetRight + GAP : TAB_ROOM}px`,
    '--bar-room': `${BAR_ROOM}px`,
  } as CSSProperties;
  return (
    <div className={bar ? 'frame frame-barred' : 'frame'} style={style}>
      <div className={sheet ? 'frame-main frame-sheet' : 'frame-main'}>{main}</div>
      {bar && <div className="frame-bar">{bar}</div>}
      <Drawer side="left" spec={left} open={drawers.open.left} onToggle={() => drawers.toggle('left')} />
      {right && <Drawer side="right" spec={right} open={drawers.open.right} onToggle={() => drawers.toggle('right')} />}
    </div>
  );
}
