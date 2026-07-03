import { useAppStore } from '../store/sessionStore';
import { cancelJob } from '../api';

// Blocks the whole UI while a "save session" job is in flight. The queue only
// supports cancelling a QUEUED job (RUNNING is non-interruptible, DESIGN §6.1),
// so Stop either cancels cleanly or reports that the write already started.
export default function SavingOverlay() {
  const { activeSessionId, savingJobId, setSavingJobId, removeActiveJob, pushNotification } = useAppStore();

  if (!activeSessionId || !savingJobId) return null;

  function handleStop() {
    cancelJob(activeSessionId!, savingJobId!)
      .then(() => {
        removeActiveJob(savingJobId!);
        setSavingJobId(null);
        pushNotification({ kind: 'info', message: 'Save cancelled.' });
      })
      .catch(() => {
        pushNotification({ kind: 'info', message: "Save is already writing to disk and can't be stopped." });
      });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[1px]">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 rounded-full border-2 border-border border-t-accent animate-spin" />
        <span className="text-sm text-white">Saving session…</span>
      </div>

      <button
        type="button"
        onClick={handleStop}
        title="Stop saving"
        className="absolute bottom-4 right-4 flex items-center gap-1 px-2.5 py-1 rounded border border-border/70 bg-surface/80 text-[11px] text-muted hover:text-text hover:border-accent transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
        Stop
      </button>
    </div>
  );
}
