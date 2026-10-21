// Small shared pieces of UI: number formats, the popover, and the stage icons.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useClickOutside } from '@cirrobio/studio-ui';
import type { StageId } from './library';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  const v = bytes / 1000 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const formatCount = (n: number) => n.toLocaleString('en-US');

export const plural = (n: number, [one, many]: [string, string]) => `${formatCount(n)} ${n === 1 ? one : many}`;

export function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A button that opens a panel below it; Esc or a click outside closes it. */
export function Popover({ label, children, align = 'left', className = '' }: {
  label: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className={`popover ${className}`} ref={ref}>
      <button type="button" className="topbar-button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && <div className={`popover-panel popover-${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

// The Studio's display-settings gear (packages/studio-ui CanvasSettingsShell), on the tab
// of the Display drawer that holds the same settings.
export const SettingsIcon = () => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

// Line art for each stage, drawn to read at 20–44 px.
export const STAGE_ICONS: Record<StageId, ReactNode> = {
  // A slide with a stained section on it.
  images: (
    <svg viewBox="0 0 44 44" aria-hidden="true">
      <rect x="5" y="12" width="34" height="20" rx="2" {...stroke} />
      <path d="M13 26c1-5 5-8 9-8s7 2 8 5-2 5-6 5-9 2-11-2z" fill="currentColor" opacity="0.35" />
      <path d="M31 14v16" {...stroke} opacity="0.5" />
    </svg>
  ),
  // An instrument's cartridge: a grid of fields of view.
  runs: (
    <svg viewBox="0 0 44 44" aria-hidden="true">
      <rect x="9" y="7" width="26" height="30" rx="3" {...stroke} />
      {[0, 1, 2].flatMap((r) => [0, 1].map((c) => (
        <rect key={`${r}${c}`} x={14 + c * 9} y={12 + r * 8} width="7" height="6" rx="1" fill="currentColor" opacity={0.25 + 0.15 * (r + c)} />
      )))}
    </svg>
  ),
  // Cells in tissue, with the stacked versions behind them.
  spatial: (
    <svg viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r="16" {...stroke} />
      <circle cx="22" cy="22" r="12" {...stroke} opacity="0.45" />
      {[[17, 17], [24, 15], [28, 22], [21, 23], [15, 25], [25, 28], [19, 30]].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="2.4" fill="currentColor" opacity={0.4 + (i % 3) * 0.2} />
      ))}
    </svg>
  ),
  // A framed chart.
  figures: (
    <svg viewBox="0 0 44 44" aria-hidden="true">
      <rect x="7" y="8" width="30" height="28" rx="2" {...stroke} />
      <path d="M12 30l7-8 5 5 8-11" {...stroke} />
      <circle cx="19" cy="22" r="1.6" fill="currentColor" />
      <circle cx="32" cy="16" r="1.6" fill="currentColor" />
    </svg>
  ),
};

/** A stage's tint as an inline style, for elements that read `--c`. */
export const tint = (cssVar: string) => ({ '--c': `var(${cssVar})` }) as CSSProperties;

export function Spinner({ label }: { label: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}
