import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useAppStore } from '../store/sessionStore';
import StatusBadge from './StatusBadge';
import FunctionPicker from './FunctionPicker';

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
  } = useAppStore();

  const [showPicker, setShowPicker] = useState(false);

  const computeItems = sessionState?.app_state.compute_history ?? [];
  const plotItems = sessionState?.app_state.plots ?? [];

  return (
    <aside className="w-60 shrink-0 bg-surface border-r border-border flex flex-col overflow-hidden">
      <Tabs.Root
        value={sidebarTab}
        onValueChange={(v) => setSidebarTab(v as 'compute' | 'plot')}
        className="flex flex-col flex-1 overflow-hidden"
      >
        <Tabs.List className="flex border-b border-border shrink-0">
          <Tabs.Trigger
            value="compute"
            className="flex-1 py-2 text-xs font-medium text-muted data-[state=active]:text-text data-[state=active]:border-b-2 data-[state=active]:border-accent transition-colors"
          >
            Compute
            {computeItems.length > 0 && (
              <span className="ml-1 text-muted/70">({computeItems.length})</span>
            )}
          </Tabs.Trigger>
          <Tabs.Trigger
            value="plot"
            className="flex-1 py-2 text-xs font-medium text-muted data-[state=active]:text-text data-[state=active]:border-b-2 data-[state=active]:border-accent transition-colors"
          >
            Plot
            {plotItems.length > 0 && (
              <span className="ml-1 text-muted/70">({plotItems.length})</span>
            )}
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="compute" className="flex-1 overflow-y-auto">
          {computeItems.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted/60 text-center">No compute history</div>
          ) : (
            <ul>
              {[...computeItems].reverse().map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() => setSelectedComputeId(item.id)}
                    className={`w-full text-left px-3 py-2 border-b border-border/50 hover:bg-accent-lo/30 transition-colors ${
                      selectedComputeId === item.id ? 'bg-accent-lo text-text' : 'text-text/80'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-0.5">
                      <span className="text-xs font-mono truncate">{item.namespace}.{item.function}</span>
                      <StatusBadge status={item.status} size="xs" />
                    </div>
                    {item.finished_at && (
                      <div className="text-[10px] text-muted/60">
                        {new Date(item.finished_at).toLocaleTimeString()}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Tabs.Content>

        <Tabs.Content value="plot" className="flex-1 overflow-y-auto">
          {plotItems.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted/60 text-center">No plots</div>
          ) : (
            <ul>
              {[...plotItems].reverse().map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() => setSelectedPlotId(item.id)}
                    className={`w-full text-left px-3 py-2 border-b border-border/50 hover:bg-accent-lo/30 transition-colors ${
                      selectedPlotId === item.id ? 'bg-accent-lo text-text' : 'text-text/80'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-0.5">
                      <span className="text-xs font-mono truncate">{item.namespace}.{item.function}</span>
                      <StatusBadge status={item.status} size="xs" />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Tabs.Content>
      </Tabs.Root>

      {/* Add button */}
      {activeSessionId && (
        <div className="p-2 border-t border-border shrink-0">
          <button
            onClick={() => setShowPicker(true)}
            className="w-full py-1.5 text-xs bg-accent/20 hover:bg-accent/30 text-accent rounded transition-colors"
          >
            + Add {sidebarTab} function
          </button>
        </div>
      )}

      {showPicker && activeSessionId && (
        <FunctionPicker
          sessionId={activeSessionId}
          effectClass={sidebarTab}
          onClose={() => setShowPicker(false)}
        />
      )}
    </aside>
  );
}
