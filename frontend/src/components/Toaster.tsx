import { useEffect } from 'react';
import { useAppStore } from '../store/sessionStore';
import type { AppNotification } from '../store/sessionStore';

const AUTO_DISMISS_MS = 10000;

function Toast({ n }: { n: AppNotification }) {
  const dismiss = useAppStore((s) => s.dismissNotification);
  useEffect(() => {
    // Errors persist until dismissed (a failure the user must see); info auto-clears.
    if (n.kind !== 'error') {
      const t = setTimeout(() => dismiss(n.id), AUTO_DISMISS_MS);
      return () => clearTimeout(t);
    }
  }, [n.id, n.kind, dismiss]);

  const color = n.kind === 'error' ? 'border-danger/40 bg-danger/15 text-danger' : 'border-border bg-surface text-text';
  return (
    <div className={`pointer-events-auto flex items-start gap-2 rounded border px-3 py-2 text-xs shadow-lg max-w-md ${color}`}>
      <span className="flex-1 whitespace-pre-wrap break-words">{n.message}</span>
      <button onClick={() => dismiss(n.id)} className="shrink-0 opacity-70 hover:opacity-100" aria-label="Dismiss">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export default function Toaster() {
  const notifications = useAppStore((s) => s.notifications);
  if (notifications.length === 0) return null;
  return (
    <div className="fixed bottom-12 right-4 z-[60] flex flex-col gap-2 pointer-events-none">
      {notifications.map((n) => <Toast key={n.id} n={n} />)}
    </div>
  );
}
