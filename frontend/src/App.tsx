import { lazy, Suspense, useEffect, useState } from 'react';
import { useAppStore } from './store/sessionStore';
import { getSessions, getFunctions, getCirroStatus, getCirroUploads, getReadyz } from './api';
import { isSpatialDisplay, isEmbeddingDisplay } from './types';
import { resolveRegionSetColumn } from './lib/regions';
import { useSSE } from './hooks/useSSE';
import { useSession } from './hooks/useSession';
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
import DetailModal from './components/DetailModal';
import NewSessionDialog from './components/NewSessionDialog';
import Toaster from './components/Toaster';
import SavingOverlay from './components/SavingOverlay';
import StartupSplash from './components/StartupSplash';
import { TourAnchors } from './tours';

export default function App() {
  useSSE();

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

  useSession(activeSessionId);

  const [showNewSession, setShowNewSession] = useState(false);
  const [backendReady, setBackendReady] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  // Gates the initial render on the backend's own readiness signal, so the
  // multi-second squidpy import + registry introspection at startup shows a
  // splash instead of an app that looks empty.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        try {
          await getReadyz();
          if (!cancelled) setBackendReady(true);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
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
  }, [setSessions, setFunctions, activeSessionId, setActiveSessionId, setCirroEnabled, setCirroUploads]);

  const display = sessionState?.app_state.displays.find(isSpatialDisplay) ?? null;
  const embeddingDisplay = sessionState?.app_state.displays.find(isEmbeddingDisplay) ?? null;

  // The Spatial/Embeddings/Tables switcher floats over the viewer.
  const showViewSwitcher = !!activeSessionId;

  // Compute/plot detail opens in a modal over the current view, so it works
  // whether the canvas or the table inspector is showing.
  const detail = selectedComputeId ? <ComputeDetail /> : selectedPlotId ? <PlotDetail /> : null;

  // Canvas mode is set by which tab is active — never a drawing mode on a
  // read-only snapshot session (Sidebar also resets off a mutating tab, but the
  // canvas checks read_only directly too rather than depending on that timing).
  const readOnly = sessionState?.summary.read_only ?? false;
  const canvasMode = readOnly ? null
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
            className="px-4 py-2 bg-accent hover:bg-accent/80 text-white rounded text-sm transition-colors"
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

    // The viewer mode switch toggles between the canvas, embeddings, and the table inspector.
    if (mainView === 'tables') return <DataInspector />;

    if (mainView === 'embedding') {
      return (
        <EmbeddingCanvas
          key={activeSessionId}
          display={embeddingDisplay}
          sessionId={activeSessionId}
          obsmFields={sessionState.fields.obsm}
          obsFields={sessionState.fields.obs}
          layerNames={sessionState.fields.layers}
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

  return (
    <div className="flex flex-col h-full bg-bg text-text">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden relative">
          {showViewSwitcher && (
            <div data-tour={TourAnchors.ViewSwitcher} className="absolute top-2 left-2 z-20 flex rounded-md border border-border bg-surface/90 backdrop-blur overflow-hidden text-xs shadow">
              {([
                ['canvas', 'Spatial'],
                ['embedding', 'Embeddings'],
                ['tables', 'Tables'],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setMainView(mode)}
                  className={`px-3 py-1 font-medium transition-colors ${
                    mainView === mode ? 'bg-accent text-white' : 'text-muted hover:text-text'
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
      <ResourceStrip />
      <Toaster />
      <SavingOverlay />
      {detail && (
        <DetailModal onClose={() => { setSelectedComputeId(null); setSelectedPlotId(null); }}>
          {detail}
        </DetailModal>
      )}
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
  );
}
