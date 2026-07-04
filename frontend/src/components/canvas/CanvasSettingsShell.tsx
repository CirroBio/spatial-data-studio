import type { ReactNode } from 'react';

interface Props {
  collapsed: boolean;
  onToggleCollapsed: (collapsed: boolean) => void;
  children: ReactNode;
}

/* Settings panel chrome — top right; minimizes to a gear icon in the same corner.
   Shared by CanvasControls (Spatial) and EmbeddingControls (Embeddings). */
export default function CanvasSettingsShell({ collapsed, onToggleCollapsed, children }: Props) {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => onToggleCollapsed(false)}
        title="Show controls"
        aria-label="Show controls"
        className="absolute top-3 right-3 z-10 p-1.5 rounded border border-border bg-surface/90 text-muted hover:text-accent hover:border-accent transition-colors backdrop-blur-sm"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    );
  }

  return (
    <div className="absolute top-3 right-3 z-10 bg-surface/90 border border-border rounded p-3 flex flex-col gap-2 min-w-[200px] backdrop-blur-sm">
      <div className="flex justify-end -mt-1 -mr-1">
        <button
          type="button"
          onClick={() => onToggleCollapsed(true)}
          title="Minimize controls"
          aria-label="Minimize controls"
          className="w-5 h-5 flex items-center justify-center rounded text-muted hover:text-accent hover:bg-bg transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M5 12h14" />
          </svg>
        </button>
      </div>
      {children}
    </div>
  );
}
