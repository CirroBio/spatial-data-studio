import { useEffect, useRef, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useAppStore } from '../store/sessionStore';
import { deleteHistoryEntry, getRecipe, importRecipe, getSession, runAllPending } from '../api';
import { reportError } from '../lib/errors';
import StatusBadge, { type Status } from './StatusBadge';
import FunctionPicker from './FunctionPicker';
import RecipeGallery from './RecipeGallery';
import RegionsPanel from './RegionsPanel';
import AnnotationsPanel from './AnnotationsPanel';
import SubsettingPanel from './SubsettingPanel';
import { TourAnchors } from '../tours';

type SidebarTab = 'compute' | 'plots' | 'regions' | 'annotations' | 'subsetting';

// The left-nav tabs render icon-only; the active one expands to icon + label.
// Icons follow the app's inline-SVG convention (24×24, stroke=currentColor).
const SIDEBAR_TABS: { id: SidebarTab; label: string; icon: React.ReactNode }[] = [
  {
    id: 'compute',
    label: 'Compute',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M15 2v2M9 2v2M15 20v2M9 20v2M20 15h2M20 9h2M2 15h2M2 9h2" />
      </svg>
    ),
  },
  {
    id: 'plots',
    label: 'Plots',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v18h18" />
        <path d="M18 17V9M13 17V5M8 17v-3" />
      </svg>
    ),
  },
  {
    id: 'regions',
    label: 'Regions',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2z" />
        <path d="M9 4v14M15 6v14" />
      </svg>
    ),
  },
  {
    id: 'annotations',
    label: 'Annotations',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <circle cx="17.5" cy="17.5" r="3.5" />
      </svg>
    ),
  },
  {
    id: 'subsetting',
    label: 'Subset',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
      </svg>
    ),
  },
];

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
  readOnly,
}: {
  items: HistoryItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  emptyLabel: string;
  readOnly: boolean;
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
          {!readOnly && item.status !== 'queued' && item.status !== 'running' && (
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

export default function Sidebar() {
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
    leftMenuOpen,
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

  const readOnly = sessionState?.summary.read_only ?? false;
  const computeItems = sessionState?.app_state.compute_history ?? [];
  const plotItems = sessionState?.app_state.plots ?? [];
  const pendingCount =
    computeItems.filter((i) => i.status === 'pending').length +
    plotItems.filter((i) => i.status === 'pending').length;

  const isOperationTab = sidebarTab === 'compute' || sidebarTab === 'plots';
  const effectClass = sidebarTab === 'plots' ? 'plot' : 'compute';
  const MUTATING_TABS: SidebarTab[] = ['regions', 'annotations', 'subsetting'];

  // A mutating tab left active from a previous (editable) session must not stay
  // selected after switching to a read-only one — its trigger disables, but Radix
  // Tabs.Content still renders whatever `value` already is.
  useEffect(() => {
    if (readOnly && MUTATING_TABS.includes(sidebarTab)) setSidebarTab('compute');
  }, [readOnly, sidebarTab, setSidebarTab]);

  return (
    <aside className={`shrink-0 overflow-hidden border-r border-border bg-surface transition-[width] duration-200 ease-in-out ${leftMenuOpen ? 'w-60' : 'w-0'}`}>
      <div className="w-60 h-full flex flex-col">
      <Tabs.Root
        value={sidebarTab}
        onValueChange={(v) => setSidebarTab(v as SidebarTab)}
        className="flex flex-col flex-1 overflow-hidden"
      >
        <Tabs.List data-tour={TourAnchors.SidebarTabs} className="flex items-stretch border-b border-border shrink-0">
          {SIDEBAR_TABS.map(({ id, label, icon }) => {
            const active = sidebarTab === id;
            const disabled = readOnly && MUTATING_TABS.includes(id);
            return (
              <Tabs.Trigger
                key={id}
                value={id}
                title={disabled ? `${label} (unavailable — viewing a read-only snapshot)` : label}
                disabled={disabled}
                className={`flex items-center justify-center gap-1.5 py-2 min-w-0 text-muted data-[state=active]:text-text data-[state=active]:border-b-2 data-[state=active]:border-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors ${
                  active ? 'flex-1 px-2' : 'px-1.5'
                }`}
              >
                <span className="shrink-0">{icon}</span>
                {active && <span className="text-[11px] font-medium truncate">{label}</span>}
              </Tabs.Trigger>
            );
          })}
        </Tabs.List>

        <Tabs.Content value="compute" className="flex-1 overflow-y-auto">
          <HistoryList
            items={computeItems}
            selectedId={selectedComputeId}
            onSelect={(id) => setSelectedComputeId(selectedComputeId === id ? null : id)}
            onDelete={handleDelete}
            emptyLabel="No compute history"
            readOnly={readOnly}
          />
        </Tabs.Content>

        <Tabs.Content value="plots" className="flex-1 overflow-y-auto">
          <HistoryList
            items={plotItems}
            selectedId={selectedPlotId}
            onSelect={(id) => setSelectedPlotId(selectedPlotId === id ? null : id)}
            onDelete={handleDelete}
            emptyLabel="No plots"
            readOnly={readOnly}
          />
        </Tabs.Content>

        <Tabs.Content value="regions" className="flex-1 overflow-y-auto">
          <RegionsPanel />
        </Tabs.Content>

        <Tabs.Content value="annotations" className="flex-1 overflow-y-auto">
          <AnnotationsPanel />
        </Tabs.Content>

        <Tabs.Content value="subsetting" className="flex-1 overflow-y-auto">
          <SubsettingPanel />
        </Tabs.Content>
      </Tabs.Root>

      {/* Add + recipe controls — only for compute/plots operation tabs, and never
          on a read-only snapshot session (every route here would 403). */}
      {activeSessionId && isOperationTab && !readOnly && (
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
            {sidebarTab === 'plots' ? '+ Add plot function' : '+ Run function'}
          </button>
          <button
            onClick={() => setShowRecipes(true)}
            data-tour={TourAnchors.BrowseRecipes}
            className="w-full py-1.5 text-xs bg-accent hover:bg-accent/90 text-white rounded transition-colors"
          >
            + Run recipe
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
      </div>

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
