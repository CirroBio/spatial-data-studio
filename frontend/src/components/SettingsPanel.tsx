import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useAppStore } from '../store/sessionStore';
import { saveSession } from '../api';
import { reportError } from '../lib/errors';
import AcknowledgementsDialog from './AcknowledgementsDialog';
import CirroUploadDialog from './CirroUploadDialog';
const SnapshotBrowser = lazy(() => import('./SnapshotBrowser'));
import { useTour, spatialDataStudioTour } from '../tours';

interface Props {
  onNewSession: () => void;
}

// One row of the settings panel: icon + label, greyed and non-clickable when
// `disabled` (with `title` explaining why), optional trailing status marker.
function PanelItem({ icon, label, onClick, disabled, title, trailing }: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'flex items-center gap-2.5 w-full px-3 py-2 text-xs text-left transition-colors',
        disabled ? 'opacity-40 cursor-default' : 'text-text/90 hover:bg-accent-lo/40 hover:text-text',
      ].join(' ')}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
  );
}

// The collapsible right-hand sidebar holding the app-wide actions (new/save
// session, save/browse snapshots, theme, tour, about, Cirro upload). Shown/hidden
// only via the header hamburger or the in-panel chevron (store.menuOpen); actions
// never collapse it as a side effect. Dialogs render as siblings of the collapsing
// panel so its width animation never clips them.
export default function SettingsPanel({ onNewSession }: Props) {
  const [showAbout, setShowAbout] = useState(false);
  const [showCirroUpload, setShowCirroUpload] = useState(false);
  const {
    activeSessionId, sessionState, theme, setTheme, savingJobId,
    cirroEnabled, cirroUploads, snapshotHandler, menuOpen, setMenuOpen,
    snapshotsOpen, snapshotsInitialSelect, openSnapshots, closeSnapshots,
  } = useAppStore();
  const unsaved = !!activeSessionId && sessionState?.summary.saved === false;
  const readOnly = sessionState?.summary.read_only ?? false;
  const { start: startTour } = useTour(spatialDataStudioTour.id, true);
  const uploadsActive = cirroUploads.uploading + cirroUploads.pending;
  const uploadTitle = uploadsActive > 0
    ? `Cirro: ${cirroUploads.uploading} uploading`
      + (cirroUploads.pending ? `, ${cirroUploads.pending} pending` : '')
    : 'Upload to Cirro';

  const saveDisabledReason = !activeSessionId
    ? undefined
    : readOnly
    ? 'Viewing a read-only snapshot — save a new session from New Session instead.'
    : undefined;

  // Saving a snapshot requires a live checkpoint — the session must be saved so the
  // snapshot has an immutable .zarr.zip to point at. When it can't be saved, the
  // item is greyed and its title says what to do first.
  const snapshotDisabledReason = !activeSessionId
    ? 'Load a session and save it as a checkpoint to save a snapshot.'
    : readOnly
    ? 'Viewing a read-only snapshot — it already pins its own view.'
    : !sessionState || sessionState.summary.saved === false
    ? 'Save the session as a checkpoint first — a snapshot captures a saved checkpoint.'
    : !snapshotHandler
    ? 'Open the Spatial or Embeddings view to save a snapshot.'
    : null;

  function handleSave() {
    if (!activeSessionId) return;
    saveSession(activeSessionId)
      .then(({ job_id }) => useAppStore.getState().setSavingJobId(job_id))
      .catch((err) => reportError('Save failed', err));
  }

  return (
    <>
      <aside className={`shrink-0 overflow-hidden border-l border-border bg-surface transition-[width] duration-200 ease-in-out ${menuOpen ? 'w-60' : 'w-0'}`}>
        <div className="w-60 h-full flex flex-col">
          <div className="flex items-center justify-between px-3 h-10 border-b border-border shrink-0">
            <span className="text-[11px] text-muted font-mono uppercase tracking-wide">Menu</span>
            <button
              type="button"
              onClick={() => setMenuOpen(false)}
              className="p-1 rounded text-muted hover:text-text hover:bg-accent-lo/30 transition-colors"
              title="Hide menu"
              aria-label="Hide menu"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </div>

          <div className="flex flex-col py-1">
            <PanelItem
              label="New session"
              onClick={onNewSession}
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 3v4a1 1 0 0 0 1 1h4" />
                  <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
                  <path d="M12 11v6M9 14h6" />
                </svg>
              }
            />
            <PanelItem
              label="Save session"
              onClick={handleSave}
              disabled={!activeSessionId || !!savingJobId || readOnly}
              title={saveDisabledReason ?? (unsaved ? 'Save session — unsaved changes' : undefined)}
              trailing={unsaved ? <span className="w-1.5 h-1.5 rounded-full bg-warn" title="Unsaved changes" /> : undefined}
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <path d="M17 21v-8H7v8M7 3v5h8" />
                </svg>
              }
            />
            <PanelItem
              label="Save snapshot"
              onClick={() => snapshotHandler?.()}
              disabled={snapshotDisabledReason !== null}
              title={snapshotDisabledReason ?? undefined}
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              }
            />
            <PanelItem
              label="Browse snapshots"
              onClick={() => openSnapshots()}
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
              }
            />

            <div className="my-1 h-px bg-border" />

            <PanelItem
              label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              icon={theme === 'dark' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            />
            <PanelItem
              label="Take the tour"
              onClick={startTour}
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
                </svg>
              }
            />
            <PanelItem
              label="About / Acknowledgements"
              onClick={() => setShowAbout(true)}
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4M12 8h.01" />
                </svg>
              }
            />

            {/* Cirro upload — only when a service-account identity is configured */}
            {cirroEnabled && (
              <PanelItem
                label="Upload to Cirro"
                onClick={() => setShowCirroUpload(true)}
                title={uploadsActive > 0 ? uploadTitle : undefined}
                trailing={uploadsActive > 0 ? (
                  <span className="w-2 h-2 rounded-full border border-accent border-t-transparent animate-spin" />
                ) : undefined}
                icon={
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7 18a4.5 4.5 0 0 1-1.44-8.77A5.5 5.5 0 0 1 16.3 6.03 4.5 4.5 0 0 1 17.5 15H17" />
                    <path d="M12 12v9M9 15l3-3 3 3" />
                  </svg>
                }
              />
            )}
          </div>
        </div>
      </aside>

      {showAbout && <AcknowledgementsDialog onClose={() => setShowAbout(false)} />}
      {snapshotsOpen && (
        <Suspense fallback={null}>
          <SnapshotBrowser onClose={closeSnapshots} initialSelect={snapshotsInitialSelect} />
        </Suspense>
      )}
      {showCirroUpload && <CirroUploadDialog onClose={() => setShowCirroUpload(false)} />}
    </>
  );
}
