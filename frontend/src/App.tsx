import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useAppStore } from './store/sessionStore';
import { getSessions, getFunctions, getCirroStatus, getCirroUploads, getReadyz } from './api';
import { isSpatialDisplay, isEmbeddingDisplay } from './types';
import { resolveRegionSetColumn } from './lib/regions';
import { DataSourceProvider, useApiSource } from './data/context';
import { checkpointUrlFromLocation, useCheckpointSession } from './data/useCheckpointSession';
import { fetchCheckpointIndex } from './data/checkpointIndex';
import CheckpointIndexPage from './components/CheckpointIndexPage';
import { useSSE } from './hooks/useSSE';
import { useSession } from './hooks/useSession';
import { usePresence, useEditGate } from './hooks/usePresence';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import SettingsPanel from './components/SettingsPanel';
import ResourceStrip from './components/ResourceStrip';
// deck.gl + geoarrow + apache-arrow ride in with the canvases; code-split them so
// the landing shell paints without pulling that multi-MB graph (loaded on first
// session open instead).
const SpatialCanvas = lazy(() => import('./components/canvas/SpatialCanvas'));
const EmbeddingCanvas = lazy(() => import('./components/canvas/EmbeddingCanvas'));
import ComputeDetail from './components/ComputeDetail';
import AnsiLog from './components/AnsiLog';
import PlotDetail from './components/PlotDetail';
import DataInspector from './components/DataInspector';
import DetailPanel from './components/DetailPanel';
import NewSessionDialog from './components/NewSessionDialog';
import Toaster from './components/Toaster';
import BlockingOverlay from './components/BlockingOverlay';
import StartupSplash from './components/StartupSplash';
import { TourAnchors } from './tours';

export default function App() {
  // Serverless mode: no backend at all — no session list, no event stream, no
  // presence, no function registry. Entered either by `?checkpoint=<url>` naming one
  // file, or by a sibling `index.json` listing a collection (see the bootstrap effect
  // below, and DESIGN §14.3).
  const checkpointUrl = useMemo(checkpointUrlFromLocation, []);
  const { checkpointIndex, setCheckpointIndex } = useAppStore();
  const serverless = checkpointUrl !== null || (checkpointIndex?.entries.length ?? 0) > 0;
  const checkpoint = useCheckpointSession(checkpointUrl);

  useSSE(!serverless);

  const {
    setSessions,
    setFunctions,
    activeSessionId,
    setActiveSessionId,
    selectedComputeId,
    selectedPlotId,
    setSelectedComputeId,
    setSelectedPlotId,
    sessionState,
    sidebarTab,
    mainView,
    setMainView,
    regionNewSetName,
    regionCategoryName,
    regionColor,
    activeRegionSetId,
    setCirroEnabled,
    setCirroUploads,
    jobLogs,
  } = useAppStore();

  useSession(activeSessionId, !serverless);
  // Announce this viewer on the session it is looking at, which also takes that
  // session's edit lock when nobody holds it (hooks/usePresence.ts). Nobody to
  // announce to in serverless mode.
  usePresence(activeSessionId, !serverless);
  const { canEdit } = useEditGate();

  // The canvas reads through whichever source backs the active session.
  const apiSource = useApiSource(serverless ? null : activeSessionId);
  const dataSource = serverless ? checkpoint.source : apiSource;

  const [showNewSession, setShowNewSession] = useState(false);
  const [backendReady, setBackendReady] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  // Resolves which mode the app is in, and gates the initial render on it. For a live
  // app that means the backend's own readiness signal, so the multi-second squidpy
  // import + registry introspection at startup shows a splash instead of an app that
  // looks empty. When nothing answers, a sibling `index.json` is what distinguishes a
  // static deployment from a backend that is merely still booting — probed once, so a
  // slow boot doesn't retry it every tick.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (checkpointUrl) {
        setBackendReady(true);
        const index = await fetchCheckpointIndex();
        if (!cancelled && index.entries.length) setCheckpointIndex(index);
        return;
      }
      let probedIndex = false;
      while (!cancelled) {
        try {
          await getReadyz();
          if (!cancelled) setBackendReady(true);
          return;
        } catch {
          if (!probedIndex) {
            probedIndex = true;
            const index = await fetchCheckpointIndex();
            if (cancelled) return;
            if (index.entries.length) {
              setCheckpointIndex(index);
              setBackendReady(true);
              return;
            }
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [checkpointUrl, setCheckpointIndex]);

  useEffect(() => {
    if (serverless || !backendReady) {
      if (serverless) setSessionsLoading(false);
      return;
    }
    getSessions()
      .then(({ sessions: s }) => {
        setSessions(s);
        if (s.length === 1 && !activeSessionId) {
          setActiveSessionId(s[0].id);
        }
      })
      .catch(console.error)
      .finally(() => setSessionsLoading(false));

    // The function registry drives the reader dropdown and function picker; retry so a
    // slow/briefly-unavailable backend at startup doesn't leave the app permanently empty.
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 5 && !cancelled; attempt++) {
        try {
          const { functions, library_versions } = await getFunctions();
          if (cancelled) return;
          setFunctions(functions, library_versions);
          if (functions.length) return;
        } catch { /* fall through to retry */ }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    })();

    getCirroStatus().then((s) => setCirroEnabled(s.enabled)).catch(() => setCirroEnabled(false));
    // Initial upload-queue depth so a reload mid-upload shows the indicator before
    // the next SSE state event; live updates arrive via cirro.upload.state.
    getCirroUploads().then(setCirroUploads).catch(() => {});

    return () => { cancelled = true; };
  }, [serverless, backendReady, setSessions, setFunctions, activeSessionId, setActiveSessionId, setCirroEnabled, setCirroUploads]);

  const display = sessionState?.app_state.displays.find(isSpatialDisplay) ?? null;
  const embeddingDisplay = sessionState?.app_state.displays.find(isEmbeddingDisplay) ?? null;

  // The Spatial/Embeddings/Tables switcher floats over the viewer.
  const showViewSwitcher = !!activeSessionId;

  // Compute/plot detail opens in a side panel docked to the right of the sidebar,
  // pushing the viewer aside; it works whether the canvas or the table inspector
  // is showing.
  const detail = selectedComputeId ? <ComputeDetail /> : selectedPlotId ? <PlotDetail /> : null;

  // Canvas mode is set by which tab is active — never a drawing mode when this viewer
  // can neither change the session nor make browser-only changes (another viewer holds
  // the edit lock, say). A checkpoint qualifies via `serverless`: its region/shape/
  // subset tools all resolve locally. Sidebar also resets off a mutating tab, but the
  // canvas checks the gate directly too rather than depending on that timing.
  const canvasMode = !(canEdit || serverless) ? null
    : sidebarTab === 'regions'
    ? 'regions'
    : sidebarTab === 'annotations'
    ? 'shapes'
    : sidebarTab === 'subsetting'
    ? 'subset'
    : null;

  // Build the region-labeling target from store state
  const annotationTarget =
    canvasMode === 'regions' && regionCategoryName
      ? {
          regionSetId: resolveRegionSetColumn(
            regionNewSetName,
            activeRegionSetId,
            sessionState?.app_state.regions ?? []
          ),
          category: regionCategoryName,
          color: regionColor,
        }
      : null;

  function renderMain() {
    if (serverless && (checkpoint.loading || checkpoint.error)) {
      return checkpoint.error ? (
        <div className="flex flex-col items-center justify-center h-full gap-2 text-muted px-6 text-center">
          <span className="text-lg text-text">Could not open this checkpoint</span>
          <span className="text-sm">{checkpoint.error}</span>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-muted">
          <div className="w-6 h-6 rounded-full border-2 border-border border-t-accent animate-spin" />
          <span className="text-sm">Opening checkpoint…</span>
        </div>
      );
    }
    if (!activeSessionId) {
      if (sessionsLoading) {
        return (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted">
            <div className="w-6 h-6 rounded-full border-2 border-border border-t-accent animate-spin" />
            <span className="text-sm">Loading sessions…</span>
          </div>
        );
      }
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 text-muted">
          <span className="text-lg">No session open</span>
          <button
            onClick={() => setShowNewSession(true)}
            className="px-4 py-2 bg-accent hover:bg-accent/80 text-on-accent rounded text-sm transition-colors"
          >
            New Session
          </button>
        </div>
      );
    }

    // Until the active session's state has loaded, show one shared spinner
    // across every tab (spatial, embeddings, tables) rather than letting each
    // tab paint its own empty state while the fetch is in flight.
    if (!sessionState) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-muted">
          <div className="w-6 h-6 rounded-full border-2 border-border border-t-accent animate-spin" />
          <span className="text-sm">Loading session...</span>
        </div>
      );
    }

    // A read-imported session is created empty; its data arrives from a background
    // reader/parse job (create_from_read enqueues the reader as the first job), so no
    // display exists until that job finishes. Show a spinner across every tab while the
    // spatialdata-io / reader parse runs, rather than the bare "no display" fallback.
    const readJob = sessionState.app_state.displays.length === 0
      ? sessionState.app_state.compute_history.find((h) => h.status === 'running' || h.status === 'queued')
      : undefined;
    if (readJob) {
      const liveLog = jobLogs[readJob.id];
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-muted px-6">
          <div className="w-6 h-6 rounded-full border-2 border-border border-t-accent animate-spin" />
          <span className="text-sm">Importing data…</span>
          {liveLog && (
            <AnsiLog
              text={liveLog}
              className="w-full max-w-2xl mt-1 bg-bg border border-border rounded p-3 text-xs font-mono text-muted overflow-auto max-h-64 whitespace-pre-wrap"
            />
          )}
        </div>
      );
    }

    // A loading/errored session can be selected from the picker so the user can check on
    // it; it has no canvas to show, so render its status instead of the bare "no display"
    // fallback. Placed after the import spinner so an in-flight read import (also
    // status 'loading') keeps its live-log view; this catches a checkpoint load still in
    // progress (its load job isn't in compute_history) and a failed load/bootstrap.
    if (sessionState.summary.status === 'errored') {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-muted px-6">
          <span className="text-sm text-danger font-medium">This session failed to load</span>
          {sessionState.summary.error && (
            <AnsiLog
              text={sessionState.summary.error}
              className="w-full max-w-2xl mt-1 bg-bg border border-border rounded p-3 text-xs font-mono text-danger overflow-auto max-h-64 whitespace-pre-wrap"
            />
          )}
        </div>
      );
    }
    if (sessionState.summary.status === 'loading') {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-muted">
          <div className="w-6 h-6 rounded-full border-2 border-border border-t-accent animate-spin" />
          <span className="text-sm">Session is still loading…</span>
        </div>
      );
    }

    // The viewer mode switch toggles between the canvas, embeddings, and the table inspector.
    // `mainView` persists across sessions, so a checkpoint opened while Tables was
    // the last view must not land on the (backend-only) inspector.
    if (mainView === 'tables' && !serverless) return <DataInspector />;

    if (mainView === 'embedding') {
      return (
        <EmbeddingCanvas
          key={activeSessionId}
          display={embeddingDisplay}
          sessionId={activeSessionId}
          obsmFields={sessionState.fields.obsm}
          obsFields={sessionState.fields.obs}
          layerNames={sessionState.fields.layers}
          canvasMode={canvasMode}
          annotationTarget={annotationTarget}
        />
      );
    }

    // Canvas-workflow tabs always show the canvas
    if (display) {
      return (
        <SpatialCanvas
          key={activeSessionId}
          display={display}
          sessionId={activeSessionId}
          canvasMode={canvasMode}
          annotationTarget={annotationTarget}
        />
      );
    }
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No spatial canvas display found
      </div>
    );
  }

  if (!backendReady) return <StartupSplash />;
  // A serverless deployment opened without `?checkpoint=` shows its collection and
  // nothing else — there is no session yet, so the sidebar, display settings and
  // resource strip would all be empty chrome.
  if (serverless && !checkpointUrl && checkpointIndex) {
    return <CheckpointIndexPage index={checkpointIndex} />;
  }

  return (
    <DataSourceProvider source={dataSource}>
    <div className="flex flex-col h-full bg-bg text-text">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <DetailPanel
          open={!!detail}
          onClose={() => { setSelectedComputeId(null); setSelectedPlotId(null); }}
        >
          {detail}
        </DetailPanel>
        <main className="flex-1 overflow-hidden relative min-w-0">
          {showViewSwitcher && (
            <div data-tour={TourAnchors.ViewSwitcher} className="absolute top-2 left-2 z-20 flex rounded-md border border-border bg-surface/90 backdrop-blur overflow-hidden text-xs shadow">
              {([
                ['canvas', 'Spatial'],
                ['embedding', 'Embeddings'],
                // The table inspector pages dataframes through the backend
                // (`/elements`, `/table-preview`), which a checkpoint has none of.
                ...(serverless ? [] : [['tables', 'Tables'] as const]),
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setMainView(mode)}
                  className={`px-3 py-1 font-medium transition-colors ${
                    mainView === mode ? 'bg-accent text-on-accent' : 'text-muted hover:text-text'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <Suspense fallback={
            <div className="flex items-center justify-center h-full text-muted">
              <div className="w-6 h-6 rounded-full border-2 border-border border-t-accent animate-spin" />
            </div>
          }>
            {renderMain()}
          </Suspense>
        </main>
        <SettingsPanel onNewSession={() => setShowNewSession(true)} />
      </div>
      {/* Resource telemetry arrives over SSE from the backend; a checkpoint has none. */}
      {!serverless && <ResourceStrip />}
      <Toaster />
      <BlockingOverlay />
      {showNewSession && (
        <NewSessionDialog
          onClose={() => setShowNewSession(false)}
          onCreated={(session) => {
            useAppStore.getState().upsertSession(session);
            setActiveSessionId(session.id);
            setShowNewSession(false);
          }}
        />
      )}
    </div>
    </DataSourceProvider>
  );
}
