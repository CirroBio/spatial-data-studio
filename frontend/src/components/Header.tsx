import { useAppStore } from '../store/sessionStore';
import { saveSession } from '../api';
import { reportError } from '../lib/errors';

interface Props {
  onNewSession: () => void;
}

const ICON_BTN ='p-1.5 rounded border border-border bg-bg text-text hover:border-accent hover:text-accent transition-colors disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text';

export default function Header({ onNewSession }: Props) {
  const {
    activeSessionId, activeJobIds, sessions,
    aiEnabled, chatOpen, setChatOpen,
    theme, setTheme, savingJobId,
  } = useAppStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const runningCount = activeJobIds.size;

  function handleSave() {
    if (!activeSessionId) return;
    saveSession(activeSessionId)
      .then(({ job_id }) => useAppStore.getState().setSavingJobId(job_id))
      .catch((err) => reportError('Save failed', err));
  }

  return (
    <header className="flex items-center justify-between px-4 h-12 bg-surface border-b border-border shrink-0">
      <div className="flex items-center gap-3">
        <span className="text-accent font-semibold tracking-wide text-sm">Spatial Data Studio</span>
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

        <button onClick={onNewSession} className={ICON_BTN} title="New session" aria-label="New session">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 3v4a1 1 0 0 0 1 1h4" />
            <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
            <path d="M12 11v6M9 14h6" />
          </svg>
        </button>
        <button onClick={handleSave} disabled={!activeSessionId || !!savingJobId} className={ICON_BTN} title="Save session" aria-label="Save session">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <path d="M17 21v-8H7v8M7 3v5h8" />
          </svg>
        </button>

        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className={ICON_BTN}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>

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
