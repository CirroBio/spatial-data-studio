// The views of an opened store, as tabs over its canvas the way the Studio switches
// between its spatial and embedding views: the tissue, the cell map, the composition,
// the versions, and the reports and figures kept with it (each in a menu, since there
// can be many).
import type { KeyboardEvent } from 'react';
import { Popover } from '../app/ui';

export interface ViewDef { id: string; label: string }

function ViewMenu({ items, current, one, many, onChoose }: {
  items: ViewDef[]; current: string; one: string; many: string; onChoose: (id: string) => void;
}) {
  if (!items.length) return null;
  const open = items.find((f) => f.id === current);
  return (
    <Popover className={open ? 'view-tab-menu view-tab-menu-on' : 'view-tab-menu'}
      label={<>{open ? `${one} · ${open.label}` : `${many} · ${items.length}`} ▾</>}>
      {(close) => (
        <div className="menu" role="menu">
          {items.map((f) => (
            <button key={f.id} type="button" role="menuitemradio" aria-checked={f.id === current} className="menu-item"
              onClick={() => { close(); onChoose(f.id); }}>
              {f.label}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

export function ViewTabs({ views, reports, figures, current, onChoose }: {
  views: ViewDef[]; reports: ViewDef[]; figures: ViewDef[]; current: string; onChoose: (id: string) => void;
}) {
  // Arrow keys move along the tabs, as in the Studio's switch.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const at = views.findIndex((v) => v.id === current);
    const next = views[Math.min(views.length - 1, Math.max(0, (at < 0 ? 0 : at) + (e.key === 'ArrowRight' ? 1 : -1)))];
    e.preventDefault();
    onChoose(next.id);
  };
  return (
    <div className="view-tabs" role="tablist" aria-label="Views" onKeyDown={onKey}>
      {views.map((v) => (
        <button key={v.id} type="button" role="tab" aria-selected={v.id === current} tabIndex={v.id === current ? 0 : -1}
          className="view-tab" onClick={() => onChoose(v.id)}>
          {v.label}
        </button>
      ))}
      <ViewMenu items={reports} current={current} one="Report" many="Reports" onChoose={onChoose} />
      <ViewMenu items={figures} current={current} one="Figure" many="Figures" onChoose={onChoose} />
    </div>
  );
}
