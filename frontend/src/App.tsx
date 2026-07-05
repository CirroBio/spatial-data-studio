import { useEffect, useState } from 'react';
import { useAppStore } from './store/sessionStore';
import { getSessions, getFunctions, getCirroStatus, getReadyz } from './api';
import { isSpatialDisplay, isEmbeddingDisplay } from './types';
import { resolveRegionSetColumn } from './lib/regions';
import { useSSE } from './hooks/useSSE';
import { useSession } from './hooks/useSession';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import ResourceStrip from './components/ResourceStrip';
import SpatialCanvas from './components/canvas/SpatialCanvas';
import EmbeddingCanvas from './components/canvas/EmbeddingCanvas';
import ComputeDetail from './components/ComputeDetail';
import PlotDetail from './components/PlotDetail';
import DataInspector from './components/DataInspector';
import DetailModal from './components/DetailModal';
import NewSessionDialog from './components/NewSessionDialog';
import Toaster from './components/Toaster';
import SavingOverlay from './components/SavingOverlay';
import StartupSplash from './components/StartupSplash';

export default function App() {
  useSSE();

  const {
    setSessions,
    setFunctions,
    activeSessionId,
    setActiveSessionId,
    sessions,
    selectedComputeId,
    selectedPlotId,
    setSelectedComputeId,
    setSelectedPlotId,
    sessionState,
    sidebarTab,
    mainView,
    setMainView,
    annotationNewSetName,
    annotationCategoryName,
    annotationColor,
    activeRegionSetId,
    setCirroEnabled,
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
          const { functions, squidpy_version } = await getFunctions();
          if (cancelled) return;
          setFunctions(functions, squidpy_version);
          if (functions.length) return;
        } catch { /* fall through to retry */ }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    })();

    getCirroStatus().then((s) => setCirroEnabled(s.enabled)).catch(() => setCirroEnabled(false));

    return () => { cancelled = true; };
  }, [setSessions, setFunctions, activeSessionId, setActiveSessionId, setCirroEnabled]);

  const display = sessionState?.app_state.displays.find(isSpatialDisplay) ?? null;
  const embeddingDisplay = sessionState?.app_state.displays.find(isEmbeddingDisplay) ?? null;

  // The Spatial/Embeddings/Tables switcher floats over the viewer.
  const showViewSwitcher = !!activeSessionId;

  // Compute/plot detail opens in a modal over the current view, so it works
  // whether the canvas or the table inspector is showing.
  const detail = selectedComputeId ? <ComputeDetail /> : selectedPlotId ? <PlotDetail /> : null;

  // Canvas mode is set by which tab is active
  const canvasMode = sidebarTab === 'annotations'
    ? 'annotate'
    : sidebarTab === 'subsetting'
    ? 'subset'
    : null;

  // Build the annotation target from store state
  const annotationTarget =
    canvasMode === 'annotate' && annotationCategoryName
      ? {
          regionSetId: resolveRegionSetColumn(
            annotationNewSetName,
            activeRegionSetId,
            sessionState?.app_state.regions ?? []
          ),
          category: annotationCategoryName,
          color: annotationColor,
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

    // The viewer mode switch toggles between the canvas, embeddings, and the table inspector.
    if (mainView === 'tables') return <DataInspector />;

    if (mainView === 'embedding') {
      return (
        <EmbeddingCanvas
          display={embeddingDisplay}
          sessionId={activeSessionId}
          obsmFields={sessionState?.fields.obsm ?? []}
          obsFields={sessionState?.fields.obs ?? []}
          layerNames={sessionState?.fields.layers ?? []}
        />
      );
    }

    // Canvas-workflow tabs always show the canvas
    if (display) {
      return (
        <SpatialCanvas
          display={display}
          sessionId={activeSessionId}
          canvasMode={canvasMode}
          annotationTarget={annotationTarget}
        />
      );
    }
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        {sessionState ? 'No spatial canvas display found' : 'Loading session...'}
      </div>
    );
  }

  if (!backendReady) return <StartupSplash />;

  return (
    <div className="flex flex-col h-full bg-bg text-text">
      <Header onNewSession={() => setShowNewSession(true)} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar onNewSession={() => setShowNewSession(true)} sessions={sessions} />
        <main className="flex-1 overflow-hidden relative">
          {showViewSwitcher && (
            <div className="absolute top-2 left-2 z-20 flex rounded-md border border-border bg-surface/90 backdrop-blur overflow-hidden text-xs shadow">
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
          {renderMain()}
        </main>
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
