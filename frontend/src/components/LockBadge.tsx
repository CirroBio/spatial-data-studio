import { useRef, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { takeSessionLock, releaseSessionLock } from '../api';
import { reportError } from '@cirrobio/spatial-viewer';
import { lockStateOf, randomClientName } from '../lib/presence';
import { useClickOutside } from '../hooks/useClickOutside';

// Header status control for the active session's edit lock: a closed padlock when it
// is locked (to you, or to the viewer named on the badge) and an open one when it is
// unlocked and free to take. Clicking opens the panel that takes/releases the lock,
// lists who else is here, and edits your own display name. Same click-outside popover
// pattern as VarNameSelect (a Radix menu can't hold a text input — its typeahead eats
// the keystrokes).
export default function LockBadge() {
  const { activeSessionId, presence, clientName, renameClient } = useAppStore();
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useClickOutside(wrapRef, () => setOpen(false), open);

  if (!activeSessionId) return null;

  const here = presence[activeSessionId];
  const lock = lockStateOf(here);
  const viewers = here?.viewers ?? [];

  const label = lock.state === 'you' ? 'Locked to you'
    : lock.state === 'other' ? lock.holder
    : 'Unlocked';
  const tone = lock.state === 'you' ? 'bg-accent-lo text-accent border-accent/40'
    : lock.state === 'other' ? 'bg-warn/15 text-warn border-warn/40'
    : 'bg-bg text-muted border-border';
  const explain = lock.state === 'you'
    ? 'You hold the edit lock. Unlock it to let someone else make changes.'
    : lock.state === 'other'
    ? `${lock.holder} holds the edit lock. You can look around and change display settings, but they stay on your screen only.`
    : 'Nobody holds the edit lock. Take it to make changes.';

  async function act(fn: () => Promise<void>, what: string) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      reportError(what, err);
    } finally {
      setBusy(false);
    }
  }

  function commitName() {
    if (draftName !== null && draftName.trim() && draftName.trim() !== clientName) {
      renameClient(draftName);
    }
    setDraftName(null);
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-medium transition-colors hover:brightness-125 ${tone}`}
        title={explain}
        aria-label={`Session lock: ${label}`}
        aria-expanded={open}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="11" width="16" height="10" rx="2" />
          {lock.state === 'none'
            ? <path d="M8 11V7a4 4 0 0 1 7.5-2" />
            : <path d="M8 11V7a4 4 0 0 1 8 0v4" />}
        </svg>
        <span className="max-w-[140px] truncate">{label}</span>
        {viewers.length > 1 && <span className="opacity-70">· {viewers.length}</span>}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 w-64 rounded-md border border-border bg-surface shadow-2xl p-3 text-xs text-text">
          <p className="text-muted leading-snug">{explain}</p>

          {lock.state === 'you' ? (
            <button
              onClick={() => void act(() => releaseSessionLock(activeSessionId), 'Unlock failed')}
              disabled={busy}
              className="mt-2.5 w-full py-1.5 rounded bg-accent hover:bg-accent/90 text-on-accent transition-colors disabled:opacity-50"
            >
              Unlock session
            </button>
          ) : (
            <button
              onClick={() => void act(() => takeSessionLock(activeSessionId), 'Take lock failed')}
              disabled={busy || lock.state === 'other'}
              title={lock.state === 'other' ? `${lock.holder} has to unlock it first` : undefined}
              className="mt-2.5 w-full py-1.5 rounded bg-accent hover:bg-accent/90 text-on-accent transition-colors disabled:opacity-40"
            >
              Take the lock
            </button>
          )}

          <div className="mt-3 pt-2.5 border-t border-border">
            <label className="block text-[10px] text-muted font-mono uppercase tracking-wide">Your name</label>
            <div className="flex items-center gap-1.5 mt-1">
              <input
                value={draftName ?? clientName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitName();
                  if (e.key === 'Escape') setDraftName(null);
                }}
                maxLength={40}
                aria-label="Your display name"
                className="flex-1 min-w-0 px-1.5 py-1 rounded border border-border bg-bg text-text focus:border-accent outline-none"
              />
              <button
                onClick={() => { setDraftName(null); renameClient(randomClientName()); }}
                title="Pick another random name"
                className="shrink-0 p-1 rounded border border-border text-muted hover:text-accent hover:border-accent transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
                </svg>
              </button>
            </div>
          </div>

          <div className="mt-3 pt-2.5 border-t border-border">
            <div className="text-[10px] text-muted font-mono uppercase tracking-wide">
              Viewing ({viewers.length})
            </div>
            <ul className="mt-1 space-y-0.5">
              {viewers.map((name, i) => (
                <li key={`${name}-${i}`} className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent/70 shrink-0" />
                  <span className="truncate">{name}</span>
                  {name === clientName && <span className="text-muted">(you)</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
