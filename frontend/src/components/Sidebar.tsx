import { useRef, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useAppStore } from '../store/sessionStore';
import { deleteHistoryEntry, getRecipe, importRecipe, getSession, runAllPending } from '../api';
import { reportError } from '../lib/errors';
import StatusBadge, { type Status } from './StatusBadge';
import FunctionPicker from './FunctionPicker';
import RecipeGallery from './RecipeGallery';
import AnnotationsPanel from './AnnotationsPanel';
import SubsettingPanel from './SubsettingPanel';
import { TourAnchors } from '../tours';
import type { SessionSummary } from '../types';

interface Props {
  onNewSession: () => void;
  sessions: SessionSummary[];
}

interface HistoryItem {
  id: string;
  namespace: string;
  function: string;
  status: Status;
  finished_at?: string | null;
}

// Compute-history and plot rows share the same layout: name + status badge, an
// optional finished timestamp, and a hover-reveal delete button.
function HistoryList({
  items,
  selectedId,
  onSelect,
  onDelete,
  emptyLabel,
}: {
  items: HistoryItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  emptyLabel: string;
}) {
  if (items.length === 0) {
    return <div className="px-3 py-4 text-xs text-muted/60 text-center">{emptyLabel}</div>;
  }
  return (
    <ul>
      {[...items].reverse().map((item) => (
        <li key={item.id} className="group relative">
          <button
            onClick={() => onSelect(item.id)}
            className={`w-full text-left px-3 py-2 border-b border-border/50 hover:bg-accent-lo/30 transition-colors ${
              selectedId === item.id ? 'bg-accent-lo text-text' : 'text-text/80'
            }`}
          >
            <div className="flex items-center justify-between gap-1 mb-0.5 pr-5">
              <span className="text-xs font-mono truncate">{item.namespace}.{item.function}</span>
              <StatusBadge status={item.status} size="xs" />
            </div>
            {item.finished_at && (
              <div className="text-[10px] text-muted/60">
                {new Date(item.finished_at).toLocaleTimeString()}
              </div>
            )}
          </button>
          {item.status !== 'queued' && item.status !== 'running' && (
            <button
              onClick={(e) => onDelete(e, item.id)}
              title="Delete from history"
              className="absolute top-1.5 right-1.5 w-4 h-4 flex items-center justify-center rounded text-muted/50 opacity-0 group-hover:opacity-100 hover:text-danger hover:bg-danger/10 transition-all"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function Sidebar({ onNewSession, sessions }: Props) {
  const {
    sessionState,
    sidebarTab,
    setSidebarTab,
    selectedComputeId,
    setSelectedComputeId,
    selectedPlotId,
    setSelectedPlotId,
    activeSessionId,
    setSessionState,
    pushNotification,
  } = useAppStore();

  const [showPicker, setShowPicker] = useState(false);
  const [showRecipes, setShowRecipes] = useState(false);
  const recipeFileRef = useRef<HTMLInputElement>(null);

  function handleExportRecipe() {
    if (!activeSessionId) return;
    getRecipe(activeSessionId)
      .then((recipe) => {
        const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'recipe.json';
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((err) => reportError('Export recipe failed', err));
  }

  async function handleLoadRecipe(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !activeSessionId) return;
    try {
      const recipe = JSON.parse(await file.text());
      // Import as pending steps so params can be reviewed/edited before running.
      await importRecipe(activeSessionId, recipe, 'stage');
      setSessionState(await getSession(activeSessionId));
      pushNotification({ kind: 'info', message: 'Recipe staged — review and run.' });
    } catch (err) {
      reportError('Load recipe failed', err);
    }
  }

  async function handleRunAllPending() {
    if (!activeSessionId) return;
    // Each staged step's job.queued event flips its row to queued live; a refetch
    // here would block on the session read lock until the first step finishes.
    try {
      await runAllPending(activeSessionId);
    } catch (err) {
      reportError('Run all pending failed', err);
    }
  }

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!activeSessionId) return;
    try {
      await deleteHistoryEntry(activeSessionId, id);
      if (selectedComputeId === id) setSelectedComputeId(null);
      if (selectedPlotId === id) setSelectedPlotId(null);
      setSessionState(await getSession(activeSessionId));
    } catch (err) {
      reportError('Delete failed', err);
    }
  }

  const computeItems = sessionState?.app_state.compute_history ?? [];
  const plotItems = sessionState?.app_state.plots ?? [];
  const pendingCount =
    computeItems.filter((i) => i.status === 'pending').length +
    plotItems.filter((i) => i.status === 'pending').length;

  const isOperationTab = sidebarTab === 'compute' || sidebarTab === 'plots';
  const effectClass = sidebarTab === 'plots' ? 'plot' : 'compute';

  return (
    <aside className="w-60 shrink-0 bg-surface border-r border-border flex flex-col overflow-hidden">
      <Tabs.Root
        value={sidebarTab}
        onValueChange={(v) => setSidebarTab(v as 'compute' | 'plots' | 'annotations' | 'subsetting')}
        className="flex flex-col flex-1 overflow-hidden"
      >
        <Tabs.List data-tour={TourAnchors.SidebarTabs} className="grid grid-cols-4 border-b border-border shrink-0">
          {(['compute', 'plots', 'annotations', 'subsetting'] as const).map((tab) => (
            <Tabs.Trigger
              key={tab}
              value={tab}
              className="py-2 text-[10px] font-medium text-muted data-[state=active]:text-text data-[state=active]:border-b-2 data-[state=active]:border-accent transition-colors capitalize"
            >
              {tab === 'annotations' ? 'Annot.' : tab === 'subsetting' ? 'Subset' : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="compute" className="flex-1 overflow-y-auto">
          <HistoryList
            items={computeItems}
            selectedId={selectedComputeId}
            onSelect={(id) => setSelectedComputeId(selectedComputeId === id ? null : id)}
            onDelete={handleDelete}
            emptyLabel="No compute history"
          />
        </Tabs.Content>

        <Tabs.Content value="plots" className="flex-1 overflow-y-auto">
          <HistoryList
            items={plotItems}
            selectedId={selectedPlotId}
            onSelect={(id) => setSelectedPlotId(selectedPlotId === id ? null : id)}
            onDelete={handleDelete}
            emptyLabel="No plots"
          />
        </Tabs.Content>

        <Tabs.Content value="annotations" className="flex-1 overflow-y-auto">
          <AnnotationsPanel />
        </Tabs.Content>

        <Tabs.Content value="subsetting" className="flex-1 overflow-y-auto">
          <SubsettingPanel onNewSession={onNewSession} sessions={sessions} />
        </Tabs.Content>
      </Tabs.Root>

      {/* Add + recipe controls — only for compute/plots operation tabs */}
      {activeSessionId && isOperationTab && (
        <div className="p-2 border-t border-border shrink-0 flex flex-col gap-1.5">
          {pendingCount > 0 && (
            <button
              onClick={handleRunAllPending}
              className="w-full py-1.5 text-xs bg-warn/20 hover:bg-warn/30 text-warn rounded transition-colors"
            >
              Run all pending ({pendingCount})
            </button>
          )}
          <button
            onClick={() => setShowPicker(true)}
            data-tour={TourAnchors.AddFunction}
            className="w-full py-1.5 text-xs bg-accent hover:bg-accent/90 text-white rounded transition-colors"
          >
            + Add {sidebarTab === 'plots' ? 'plot' : 'compute'} function
          </button>
          <button
            onClick={() => setShowRecipes(true)}
            data-tour={TourAnchors.BrowseRecipes}
            className="w-full py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent transition-colors"
          >
            Browse recipes
          </button>
          <div className="flex gap-1">
            <button
              onClick={() => recipeFileRef.current?.click()}
              className="flex-1 py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent transition-colors"
            >
              Load recipe
            </button>
            <button
              onClick={handleExportRecipe}
              className="flex-1 py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent transition-colors"
            >
              Export recipe
            </button>
          </div>
          <input
            ref={recipeFileRef}
            type="file"
            accept="application/json,.json"
            onChange={handleLoadRecipe}
            className="hidden"
          />
        </div>
      )}

      {showPicker && activeSessionId && (
        <FunctionPicker
          sessionId={activeSessionId}
          effectClass={effectClass}
          onClose={() => setShowPicker(false)}
        />
      )}

      {showRecipes && activeSessionId && (
        <RecipeGallery sessionId={activeSessionId} onClose={() => setShowRecipes(false)} />
      )}
    </aside>
  );
}
