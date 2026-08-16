import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAppStore } from '../store/sessionStore';
import { deleteSession } from '../api';
import { reportError } from '@cirrobio/spatial-viewer';
import { lockStateOf } from '../lib/presence';

// Header switcher over the currently-loaded sessions. Selecting a session calls
// setActiveSessionId, which drives the whole view swap (useSession refetches on
// the id change). Loading/errored sessions are selectable too, so a user can check
// their status or error message (App.renderMain renders a status view for them
// instead of the canvas). Each row also exposes a delete control.
export default function SessionPicker() {
  const { sessions, activeSessionId, setActiveSessionId, removeSession, sessionState, presence } = useAppStore();
  if (sessions.length === 0) return null;
  const active = sessions.find((s) => s.id === activeSessionId);
  // Does the active session have a job in flight? Derived from its durable history
  // (not the ephemeral activeJobIds set, which is wiped on switch) so the signal is
  // correct after switching back into a session whose job is still running — the
  // header "running" pill can't show that on return, so bind the cue to the switcher,
  // which is where a returning user reorients (designer critique). Only the active
  // session's state is loaded, so only its row/trigger can carry the dot today.
  const activeHasJob =
    !!sessionState &&
    (sessionState.app_state.compute_history.some((h) => h.status === 'queued' || h.status === 'running') ||
      sessionState.app_state.plots.some((p) => p.status === 'queued' || p.status === 'running'));
  // Every viewer counted once, however many sessions they are spread across (a viewer
  // is attached to at most one session, so the sum is the app-wide viewer count).
  const totalViewers = Object.values(presence).reduce((n, p) => n + p.viewers.length, 0);

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
          {activeHasJob && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0"
              title="A job is running in this session"
            />
          )}
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
            {totalViewers > 0 && ` · ${totalViewers} viewing`}
          </div>
          {sessions.map((s) => {
            const isActive = s.id === activeSessionId;
            const isResident = s.status === 'ready';
            const lock = lockStateOf(presence[s.id]);
            const viewers = presence[s.id]?.viewers.length ?? 0;
            return (
              <DropdownMenu.Item
                key={s.id}
                onSelect={() => setActiveSessionId(s.id)}
                className={[
                  'group flex items-center gap-2 px-3 py-1.5 text-xs outline-none cursor-pointer data-[highlighted]:bg-accent-lo/40',
                  isActive ? 'bg-accent-lo text-text' : 'text-text/80',
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
                    {/* Who holds the edit lock, and how many people are on this session. */}
                    {lock.state !== 'none' && (
                      <span
                        className={`text-[9px] font-mono ${lock.state === 'you' ? 'text-accent' : 'text-warn'}`}
                        title={lock.state === 'you'
                          ? 'You hold this session\'s edit lock'
                          : `${lock.holder} holds this session's edit lock`}
                      >
                        {lock.state === 'you' ? 'locked to you' : `locked: ${lock.holder}`}
                      </span>
                    )}
                    {viewers > 0 && (
                      <span className="text-[9px] text-muted/60 font-mono" title={presence[s.id]?.viewers.join(', ')}>
                        {viewers} viewing
                      </span>
                    )}
                    {isActive && activeHasJob && (
                      <span className="text-[9px] text-accent font-mono flex items-center gap-1">
                        <span className="w-1 h-1 rounded-full bg-accent animate-pulse" />running
                      </span>
                    )}
                  </div>
                </div>
                {isActive && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-accent shrink-0">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
                {/* Closing a session another viewer holds the lock on is refused (423),
                    so the control reads that row's own lock, not the active session's
                    edit gate. A read-only session can still be closed. */}
                <button
                  onClick={(e) => handleDelete(e, s.id, s.name)}
                  disabled={lock.state === 'other'}
                  title={lock.state === 'other'
                    ? `${lock.holder} holds this session's edit lock — they have to unlock it before it can be deleted`
                    : 'Delete session'}
                  className="w-4 h-4 flex items-center justify-center rounded text-muted/50 opacity-0 group-hover:opacity-100 hover:text-danger hover:bg-danger/10 transition-all shrink-0 disabled:hover:text-muted/50 disabled:hover:bg-transparent disabled:cursor-not-allowed"
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
