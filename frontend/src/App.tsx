import { useEffect } from 'react';
import { useAppStore } from './store/sessionStore';
import { getSessions, getFunctions, getAiStatus } from './api';
import ChatPanel from './components/ChatPanel';
import { useSSE } from './hooks/useSSE';
import { useSession } from './hooks/useSession';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import ResourceStrip from './components/ResourceStrip';
import SpatialCanvas from './components/canvas/SpatialCanvas';
import ComputeDetail from './components/ComputeDetail';
import PlotDetail from './components/PlotDetail';
import NewSessionDialog from './components/NewSessionDialog';
import Toaster from './components/Toaster';
import { useState } from 'react';

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
    sessionState,
    sidebarTab,
    annotationNewSetName,
    annotationCategoryName,
    annotationColor,
    activeRegionSetId,
    aiEnabled,
    setAiEnabled,
  } = useAppStore();

  useSession(activeSessionId);

  const [showNewSession, setShowNewSession] = useState(false);

  useEffect(() => {
    getSessions()
      .then(({ sessions: s }) => {
        setSessions(s);
        if (s.length === 1 && !activeSessionId) {
          setActiveSessionId(s[0].id);
        }
      })
      .catch(console.error);

    getFunctions()
      .then(({ functions, squidpy_version }) => {
        setFunctions(functions, squidpy_version);
      })
      .catch(console.error);

    getAiStatus().then((s) => setAiEnabled(s.enabled)).catch(() => setAiEnabled(false));
  }, [setSessions, setFunctions, activeSessionId, setActiveSessionId, setAiEnabled]);

  const display = sessionState?.app_state.displays.find((d) => d.type === 'spatial_canvas') ?? null;

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
          regionSetId: annotationNewSetName || activeRegionSetId || '',
          category: annotationCategoryName,
          color: annotationColor,
        }
      : null;

  function renderMain() {
    if (!activeSessionId) {
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

    // Operation-log tabs show the selected item detail, then fall back to canvas
    if (sidebarTab === 'compute' && selectedComputeId) return <ComputeDetail />;
    if (sidebarTab === 'plots' && selectedPlotId) return <PlotDetail />;

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

  return (
    <div className="flex flex-col h-full bg-bg text-text">
      <Header onNewSession={() => setShowNewSession(true)} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar onNewSession={() => setShowNewSession(true)} sessions={sessions} />
        <main className="flex-1 overflow-hidden relative">
          {renderMain()}
        </main>
        {aiEnabled && activeSessionId && <ChatPanel sessionId={activeSessionId} />}
      </div>
      <ResourceStrip />
      <Toaster />
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
