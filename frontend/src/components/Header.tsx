import { useAppStore } from '../store/sessionStore';
import { saveSession } from '../api';

function reportError(prefix: string, err: unknown) {
  useAppStore.getState().pushNotification({
    kind: 'error',
    message: `${prefix}: ${err instanceof Error ? err.message : String(err)}`,
  });
}

interface Props {
  onNewSession: () => void;
}

const BTN = 'px-2.5 py-1 text-xs rounded border border-border bg-bg text-text hover:border-accent transition-colors disabled:opacity-40';

export default function Header({ onNewSession }: Props) {
  const {
    activeSessionId, activeJobIds, squidpyVersion, sessions,
    aiEnabled, chatOpen, setChatOpen,
  } = useAppStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const runningCount = activeJobIds.size;

  function handleSave() {
    if (!activeSessionId) return;
    saveSession(activeSessionId)
      .then(() => useAppStore.getState().pushNotification({ kind: 'info', message: 'Saving session…' }))
      .catch((err) => reportError('Save failed', err));
  }

  return (
    <header className="flex items-center justify-between px-4 h-12 bg-surface border-b border-border shrink-0">
      <div className="flex items-center gap-3">
        <span className="text-accent font-semibold tracking-wide text-sm">Spatial Data Studio</span>
        {squidpyVersion && (
          <span className="text-muted text-xs font-mono">squidpy {squidpyVersion}</span>
        )}
        {activeSession && (
          <span className="text-text/70 text-xs truncate max-w-[200px]">{activeSession.name}</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {runningCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-accent animate-pulse mr-1">
            <span className="w-2 h-2 rounded-full bg-accent inline-block" />
            {runningCount} running
          </span>
        )}

        <button onClick={onNewSession} className={BTN}>New session</button>
        <button onClick={handleSave} disabled={!activeSessionId} className={BTN}>Save session</button>

        {/* Dedicated AI panel toggle — only when Bedrock is configured */}
        {aiEnabled && (
          <button
            onClick={() => setChatOpen(!chatOpen)}
            aria-pressed={chatOpen}
            className={`px-2.5 py-1 text-xs rounded border transition-colors ${
              chatOpen
                ? 'bg-accent/20 border-accent/40 text-accent'
                : 'border-border bg-bg text-text hover:border-accent'
            }`}
          >
            AI panel
          </button>
        )}
      </div>
    </header>
  );
}
