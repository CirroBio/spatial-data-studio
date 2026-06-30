import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAppStore } from '../store/sessionStore';
import { saveSession, getRecipe, deleteSession } from '../api';

function reportError(prefix: string, err: unknown) {
  useAppStore.getState().pushNotification({
    kind: 'error',
    message: `${prefix}: ${err instanceof Error ? err.message : String(err)}`,
  });
}

interface Props {
  onNewSession: () => void;
}

export default function Header({ onNewSession }: Props) {
  const { activeSessionId, setActiveSessionId, activeJobIds, squidpyVersion, removeSession, sessions } = useAppStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const runningCount = activeJobIds.size;

  function handleSave() {
    if (!activeSessionId) return;
    saveSession(activeSessionId).catch((err) => reportError('Save failed', err));
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
      .catch((err) => reportError('Export recipe failed', err));
  }

  function handleDelete() {
    if (!activeSessionId) return;
    if (!confirm('Delete this session?')) return;
    deleteSession(activeSessionId)
      .then(() => {
        removeSession(activeSessionId);
        setActiveSessionId(null);
      })
      .catch((err) => reportError('Delete failed', err));
  }

  return (
    <header className="flex items-center justify-between px-4 h-12 bg-surface border-b border-border shrink-0">
      <div className="flex items-center gap-3">
        <span className="text-accent font-semibold tracking-wide text-sm">Spatial Data Studio</span>
        {squidpyVersion && (
          <span className="text-muted text-xs font-mono">{squidpyVersion}</span>
        )}
        {activeSession && (
          <span className="text-text/70 text-xs truncate max-w-[200px]">{activeSession.name}</span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {runningCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-accent animate-pulse">
            <span className="w-2 h-2 rounded-full bg-accent inline-block" />
            {runningCount} running
          </span>
        )}

        {/* Gear menu — global ops only; session switching moved to Subsetting tab */}
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
