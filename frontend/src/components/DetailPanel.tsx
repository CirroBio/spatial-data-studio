import { useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

// Docked shell for the compute/plot detail views: a flex-column sibling placed
// immediately after the left sidebar, so its left edge sits flush against the
// sidebar's right edge and opening it pushes the viewer rather than overlaying
// it. Mirrors the width animation of Sidebar/SettingsPanel; the inner column
// keeps a fixed width (2/3 of the detail view's original max-w-5xl modal, i.e.
// 64rem × 2/3) so content doesn't reflow mid-animation. Closes on Esc.
export default function DetailPanel({ open, onClose, children }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <aside className={`shrink-0 overflow-hidden border-r border-border bg-surface transition-[width] duration-200 ease-in-out ${open ? 'w-[42.67rem]' : 'w-0'}`}>
      <div className="w-[42.67rem] h-full flex flex-col">{children}</div>
    </aside>
  );
}
