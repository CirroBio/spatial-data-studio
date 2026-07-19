import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAppStore } from '../store/sessionStore';
import { deleteSession } from '../api';
import { reportError } from '../lib/errors';

// Header switcher over the currently-loaded sessions. Selecting a resident
// session calls setActiveSessionId, which drives the whole view swap (useSession
// refetches on the id change). Non-resident (evicted/errored) sessions can't be
// displayed without a reload, so they show but aren't selectable. Each row also
// exposes a delete control.
export default function SessionPicker() {
  const { sessions, activeSessionId, setActiveSessionId, removeSession } = useAppStore();
  if (sessions.length === 0) return null;
  const active = sessions.find((s) => s.id === activeSessionId);

  async function handleDelete(e: React.MouseEvent, id: string, name: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Delete session "${name}"? Any unsaved changes are lost.`)) return;
    try {
      await deleteSession(id);
      removeSession(id);
      if (activeSessionId === id) {
        const next = sessions.find((s) => s.id !== id && s.status === 'ready');
        setActiveSessionId(next ? next.id : null);
      }
    } catch (err) {
      reportError('Delete session failed', err);
    }
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="flex items-center gap-1 max-w-[240px] px-2 py-1 rounded text-xs text-text/80 hover:bg-accent-lo/30 hover:text-text transition-colors"
          title="Switch session"
        >
          <span className="truncate">{active ? active.name : 'Select session'}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-50 min-w-[240px] max-w-[360px] max-h-[70vh] overflow-y-auto rounded-md border border-border bg-surface shadow-2xl py-1"
        >
          <div className="px-3 py-1 text-[10px] text-muted font-mono uppercase tracking-wide">
            Loaded sessions ({sessions.length})
          </div>
          {sessions.map((s) => {
            const isActive = s.id === activeSessionId;
            const isResident = s.status === 'ready';
            return (
              <DropdownMenu.Item
                key={s.id}
                disabled={!isResident}
                onSelect={() => setActiveSessionId(s.id)}
                className={[
                  'group flex items-center gap-2 px-3 py-1.5 text-xs outline-none',
                  isActive ? 'bg-accent-lo text-text' : 'text-text/80',
                  isResident ? 'cursor-pointer data-[highlighted]:bg-accent-lo/40' : 'opacity-50 cursor-default',
                ].join(' ')}
              >
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="truncate leading-tight">{s.name}</span>
                  <div className="flex items-center gap-2 mt-0.5">
                    {isResident && s.resident_mb > 0 && (
                      <span className="text-[9px] text-muted/60 font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {s.resident_mb.toFixed(0)} MB
                      </span>
                    )}
                    {s.status === 'errored' && <span className="text-[9px] text-danger font-mono">errored</span>}
                    {s.status === 'loading' && <span className="text-[9px] text-muted/50 font-mono">loading</span>}
                    {isActive && <span className="text-[9px] text-accent font-mono">active</span>}
                  </div>
                </div>
                {isActive && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-accent shrink-0">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
                <button
                  onClick={(e) => handleDelete(e, s.id, s.name)}
                  title="Delete session"
                  className="w-4 h-4 flex items-center justify-center rounded text-muted/50 opacity-0 group-hover:opacity-100 hover:text-danger hover:bg-danger/10 transition-all shrink-0"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
