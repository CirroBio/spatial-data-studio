import { useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { saveSession } from '../api';
import { reportError } from '../lib/errors';
import AcknowledgementsDialog from './AcknowledgementsDialog';
import CirroUploadDialog from './CirroUploadDialog';

interface Props {
  onNewSession: () => void;
}

const ICON_BTN ='p-1.5 rounded border border-border bg-bg text-text hover:border-accent hover:text-accent transition-colors disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text';

export default function Header({ onNewSession }: Props) {
  const [showAbout, setShowAbout] = useState(false);
  const [showCirroUpload, setShowCirroUpload] = useState(false);
  const {
    activeSessionId, activeJobIds, sessions,
    theme, setTheme, savingJobId, cirroEnabled,
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

        <button onClick={() => setShowAbout(true)} className={ICON_BTN} title="About / Acknowledgements" aria-label="About / Acknowledgements">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
        </button>

        {/* Cirro upload — only when a service-account identity is configured */}
        {cirroEnabled && (
          <button
            onClick={() => setShowCirroUpload(true)}
            disabled={!activeSessionId}
            className={ICON_BTN}
            title="Upload to Cirro"
            aria-label="Upload to Cirro"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 18a4.5 4.5 0 0 1-1.44-8.77A5.5 5.5 0 0 1 16.3 6.03 4.5 4.5 0 0 1 17.5 15H17" />
              <path d="M12 12v9M9 15l3-3 3 3" />
            </svg>
          </button>
        )}
      </div>

      {showAbout && <AcknowledgementsDialog onClose={() => setShowAbout(false)} />}
      {showCirroUpload && activeSessionId && (
        <CirroUploadDialog sessionId={activeSessionId} onClose={() => setShowCirroUpload(false)} />
      )}
    </header>
  );
}
