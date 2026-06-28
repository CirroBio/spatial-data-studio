import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAppStore } from '../store/sessionStore';
import { saveSession, getRecipe, deleteSession } from '../api';
import type { SessionSummary } from '../types';

interface Props {
  onNewSession: () => void;
  sessions: SessionSummary[];
}

export default function Header({ onNewSession, sessions }: Props) {
  const { activeSessionId, setActiveSessionId, activeJobIds, squidpyVersion, removeSession } = useAppStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const runningCount = activeJobIds.size;

  function handleSave() {
    if (!activeSessionId) return;
    saveSession(activeSessionId).catch(console.error);
  }

  function handleExportRecipe() {
    if (!activeSessionId) return;
    getRecipe(activeSessionId)
      .then((recipe) => {
        const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'recipe.json';
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(console.error);
  }

  function handleDelete() {
    if (!activeSessionId) return;
    if (!confirm('Delete this session?')) return;
    deleteSession(activeSessionId)
      .then(() => {
        removeSession(activeSessionId);
        setActiveSessionId(null);
      })
      .catch(console.error);
  }

  return (
    <header className="flex items-center justify-between px-4 h-12 bg-surface border-b border-border shrink-0">
      <div className="flex items-center gap-3">
        <span className="text-accent font-semibold tracking-wide text-sm">squidpy-viewer</span>
        {squidpyVersion && (
          <span className="text-muted text-xs font-mono">{squidpyVersion}</span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {runningCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-accent animate-pulse">
            <span className="w-2 h-2 rounded-full bg-accent inline-block" />
            {runningCount} running
          </span>
        )}

        {/* Session selector */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="flex items-center gap-2 px-3 py-1 rounded bg-bg border border-border text-sm hover:border-accent/50 transition-colors">
              <span className="max-w-[160px] truncate">
                {activeSession?.name ?? 'Select session'}
              </span>
              <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor" className="text-muted shrink-0">
                <path d="M0 0l5 6 5-6H0z" />
              </svg>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="z-50 bg-surface border border-border rounded shadow-xl py-1 min-w-[200px]"
              sideOffset={4}
            >
              {sessions.map((s) => (
                <DropdownMenu.Item
                  key={s.id}
                  onSelect={() => setActiveSessionId(s.id)}
                  className={`px-3 py-2 text-sm cursor-pointer outline-none flex items-center gap-2 ${
                    s.id === activeSessionId ? 'text-accent' : 'text-text hover:bg-accent-lo'
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      s.status === 'ready' ? 'bg-success' : s.status === 'errored' ? 'bg-danger' : 'bg-warn animate-pulse'
                    }`}
                  />
                  <span className="truncate">{s.name}</span>
                </DropdownMenu.Item>
              ))}
              {sessions.length === 0 && (
                <div className="px-3 py-2 text-sm text-muted">No sessions</div>
              )}
              <DropdownMenu.Separator className="h-px bg-border my-1" />
              <DropdownMenu.Item
                onSelect={onNewSession}
                className="px-3 py-2 text-sm cursor-pointer outline-none text-text hover:bg-accent-lo"
              >
                New session...
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        {/* Gear menu */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="p-1.5 rounded hover:bg-accent/20 text-muted hover:text-text transition-colors"
              aria-label="Settings"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="z-50 bg-surface border border-border rounded shadow-xl py-1 min-w-[160px]"
              sideOffset={4}
              align="end"
            >
              <DropdownMenu.Item
                onSelect={onNewSession}
                className="px-3 py-2 text-sm cursor-pointer outline-none text-text hover:bg-accent-lo"
              >
                New session...
              </DropdownMenu.Item>
              {activeSessionId && (
                <>
                  <DropdownMenu.Item
                    onSelect={handleSave}
                    className="px-3 py-2 text-sm cursor-pointer outline-none text-text hover:bg-accent-lo"
                  >
                    Save session
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={handleExportRecipe}
                    className="px-3 py-2 text-sm cursor-pointer outline-none text-text hover:bg-accent-lo"
                  >
                    Export recipe
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="h-px bg-border my-1" />
                  <DropdownMenu.Item
                    onSelect={handleDelete}
                    className="px-3 py-2 text-sm cursor-pointer outline-none text-danger hover:bg-danger/10"
                  >
                    Delete session
                  </DropdownMenu.Item>
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}
