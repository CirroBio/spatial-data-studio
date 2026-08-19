import { useAppStore } from '../store/sessionStore';
import CirroMark from './CirroMark';
import SessionPicker from './SessionPicker';
import CheckpointPicker from './CheckpointPicker';
import { useDataSource } from '@cirrobio/spatial-viewer';
import LockBadge from './LockBadge';
import { TourAnchors } from '../tours';

const ICON_BTN ='p-1.5 rounded border border-border bg-bg text-text hover:border-accent hover:text-accent transition-colors disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text';

export default function Header() {
  const {
    activeSessionId, activeJobIds, sessionState, cirroUploads, checkpointIndex,
    menuOpen, setMenuOpen, leftMenuOpen, setLeftMenuOpen,
  } = useAppStore();
  // A checkpoint's "sessions" are the files listed by index.json, switched by
  // navigation — a different thing from the live session list, so a different picker.
  // The synthetic session's id is the checkpoint's own URL (useCheckpointSession).
  const isCheckpoint = useDataSource()?.kind === 'checkpoint';
  const runningCount = activeJobIds.size;
  const readOnly = sessionState?.summary.read_only ?? false;
  const unsaved = !!activeSessionId && sessionState?.summary.saved === false;
  const uploadsActive = cirroUploads.filter((u) => u.state === 'pending' || u.state === 'uploading').length;
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
        <span className="flex items-center gap-2">
          <CirroMark className="h-5 w-auto shrink-0" />
          {/* The header is a fixed 48px, so the wordmark must never wrap into it. Below
              `lg` the rest of the left group (picker, cell count, badges) leaves too
              little room for the full name, so it drops to "Spatial" rather than
              stacking — which is also what keeps a narrow embedded iframe readable. */}
          <span
            className="text-accent tracking-wide text-sm whitespace-nowrap shrink-0"
            title="Spatial Data Studio"
          >
            Spatial<span className="hidden lg:inline"> Data Studio</span>
          </span>
        </span>
        <span data-tour={TourAnchors.SessionPicker}>
          {isCheckpoint
            ? (checkpointIndex?.entries.length
              ? <CheckpointPicker index={checkpointIndex} currentUrl={sessionState?.summary.id ?? null} />
              : <span className="px-2 py-1 text-xs text-text/80 truncate max-w-[240px] inline-block align-middle">
                  {sessionState?.summary.name}
                </span>)
            : <SessionPicker />}
        </span>
        <LockBadge />
        {fields?.n_obs != null && (
          <span className="text-[11px] text-muted font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fields.n_obs.toLocaleString()} cells
            {img && ` · ${img.width.toLocaleString()} × ${img.height.toLocaleString()} px`}
          </span>
        )}
        {readOnly && (
          <span
            className="text-[11px] px-1.5 py-0.5 rounded bg-warn/15 text-warn font-medium"
            title="Opened from a snapshot — pinned view, no compute or edits"
          >
            Read-only
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
