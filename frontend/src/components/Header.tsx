import { useAppStore } from '../store/sessionStore';
import SessionPicker from './SessionPicker';
import { TourAnchors } from '../tours';

const ICON_BTN ='p-1.5 rounded border border-border bg-bg text-text hover:border-accent hover:text-accent transition-colors disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text';

export default function Header() {
  const {
    activeSessionId, activeJobIds, sessionState, cirroUploads,
    menuOpen, setMenuOpen, leftMenuOpen, setLeftMenuOpen,
  } = useAppStore();
  const runningCount = activeJobIds.size;
  const unsaved = !!activeSessionId && sessionState?.summary.saved === false;
  const uploadsActive = cirroUploads.uploading + cirroUploads.pending;
  const fields = sessionState?.fields;
  // `fields` is an empty object while a session is still loading (the backend has
  // no table yet), so guard every access — image_dims/n_obs are absent until ready.
  const img = fields?.image_dims?.[0];

  return (
    <header className="flex items-center justify-between px-4 h-12 bg-surface border-b border-border shrink-0">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setLeftMenuOpen(!leftMenuOpen)}
          className={ICON_BTN}
          title={leftMenuOpen ? 'Hide sidebar' : 'Show sidebar'}
          aria-label="Toggle sidebar"
          aria-expanded={leftMenuOpen}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
          </svg>
        </button>
        <span className="text-accent font-semibold tracking-wide text-sm">Spatial Data Studio</span>
        <span data-tour={TourAnchors.SessionPicker}>
          <SessionPicker />
        </span>
        {fields?.n_obs != null && (
          <span className="text-[11px] text-muted font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fields.n_obs.toLocaleString()} cells
            {img && ` · ${img.width.toLocaleString()} × ${img.height.toLocaleString()} px`}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {runningCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-accent animate-pulse mr-1">
            <span className="w-2 h-2 rounded-full bg-accent inline-block" />
            {runningCount} running
          </span>
        )}

        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className={`${ICON_BTN} relative`}
          title="Menu"
          aria-label="Menu"
          aria-expanded={menuOpen}
          data-tour={TourAnchors.Menu}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
          {(unsaved || uploadsActive > 0) && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-warn" />
          )}
        </button>
      </div>
    </header>
  );
}
