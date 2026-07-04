import { useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { subsetSession, deleteSession } from '../api';
import { reportError } from '../lib/errors';
import { useDrawSelection } from '../hooks/useDrawSelection';
import DrawControls from './DrawControls';
import type { SessionSummary } from '../types';

interface Props {
  onNewSession: () => void;
  sessions: SessionSummary[];
}

interface TreeNode {
  session: SessionSummary;
  children: TreeNode[];
}

function buildTree(sessions: SessionSummary[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const s of sessions) {
    const node = byId.get(s.id)!;
    if (s.parent_id && byId.has(s.parent_id)) {
      byId.get(s.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function StatusDot({ status }: { status: SessionSummary['status'] }) {
  const cls =
    status === 'ready'
      ? 'bg-success'
      : status === 'errored'
      ? 'bg-danger'
      : 'bg-warn animate-pulse';
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cls}`} />;
}

function SessionNode({
  node,
  depth,
  activeSessionId,
  onSelect,
  onDelete,
}: {
  node: TreeNode;
  depth: number;
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onDelete: (e: React.MouseEvent, id: string, name: string) => void;
}) {
  const { session } = node;
  const isActive = session.id === activeSessionId;
  const isResident = session.status === 'ready';

  return (
    <li>
      <div className="group relative">
        <button
          onClick={() => isResident && onSelect(session.id)}
          disabled={!isResident}
          className={[
            'w-full text-left py-1.5 pr-6 flex items-start gap-1.5 transition-colors',
            isActive ? 'bg-accent-lo text-text' : 'text-text/80 hover:bg-accent-lo/20',
            !isResident ? 'opacity-50 cursor-default' : 'cursor-pointer',
          ].join(' ')}
          style={{ paddingLeft: `${12 + depth * 12}px` }}
        >
          {depth > 0 && (
            <span className="text-muted/40 text-[10px] shrink-0 mt-0.5">&#8627;</span>
          )}
          <StatusDot status={session.status} />
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[11px] truncate leading-tight">{session.name}</span>
            <div className="flex items-center gap-2 mt-0.5">
              {isResident && session.resident_mb > 0 && (
                <span className="text-[9px] text-muted/60 font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {session.resident_mb.toFixed(0)} MB
                </span>
              )}
              {!isResident && (
                <span className="text-[9px] text-muted/50 font-mono">evicted</span>
              )}
              {isActive && (
                <span className="text-[9px] text-accent font-mono">active</span>
              )}
            </div>
          </div>
        </button>
        <button
          onClick={(e) => onDelete(e, session.id, session.name)}
          title="Delete session"
          className="absolute top-1.5 right-1.5 w-4 h-4 flex items-center justify-center rounded text-muted/50 opacity-0 group-hover:opacity-100 hover:text-danger hover:bg-danger/10 transition-all"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <SessionNode
              key={child.session.id}
              node={child}
              depth={depth + 1}
              activeSessionId={activeSessionId}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function SubsettingPanel({ onNewSession, sessions }: Props) {
  const { activeSessionId, setActiveSessionId, removeSession } = useAppStore();
  const { drawPolygons, drawRing, regionCount, allPolygons, commitDrawRing, clearDraw } = useDrawSelection();

  const [saveParent, setSaveParent] = useState(false);
  const [working, setWorking] = useState(false);

  const tree = buildTree(sessions);

  async function handleDeleteSession(e: React.MouseEvent, id: string, name: string) {
    e.stopPropagation();
    if (!window.confirm(`Delete session "${name}"? Any unsaved changes are lost.`)) return;
    try {
      await deleteSession(id);
      removeSession(id);
      if (activeSessionId === id) {
        const next = sessions.find((s) => s.id !== id && s.status === 'ready');
        setActiveSessionId(next ? next.id : null);
      }
    } catch (err) {
      reportError('Delete session failed', err);
    }
  }

  async function handleSubset() {
    if (!activeSessionId || regionCount === 0) return;
    setWorking(true);
    try {
      await subsetSession(activeSessionId, { polygons: allPolygons, save_parent: saveParent });
      clearDraw();
    } catch (err) {
      reportError('Subset failed', err);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex flex-col gap-0">
      {/* Draw controls — drawing happens on the canvas; actions live here. */}
      <div className="px-3 py-2 border-b border-border/50 flex flex-col gap-1.5">
        <span className="text-[10px] text-muted font-mono uppercase tracking-wide">Selection</span>
        <DrawControls
          regionCount={regionCount}
          drawRingLength={drawRing.length}
          drawPolygonsLength={drawPolygons.length}
          onFinish={commitDrawRing}
          onClear={clearDraw}
        />
        <label className="flex items-center gap-2 text-[11px] text-muted cursor-pointer">
          <input type="checkbox" checked={saveParent} onChange={(e) => setSaveParent(e.target.checked)} className="accent-accent" />
          Save parent first
        </label>
        <button
          type="button"
          onClick={handleSubset}
          disabled={working || regionCount === 0}
          className="py-1.5 text-xs bg-accent hover:bg-accent/80 disabled:opacity-40 text-white rounded transition-colors"
        >
          {working ? 'Subsetting...' : `Subset to selection${regionCount ? ` (${regionCount})` : ''}`}
        </button>
        <p className="text-[10px] text-muted/60 leading-snug">Creates a child session; the parent is evicted.</p>
      </div>

      {/* Session lineage tree */}
      <div className="px-3 py-2 border-b border-border/50">
        <span className="text-[10px] text-muted font-mono uppercase tracking-wide">Session lineage</span>
      </div>

      {sessions.length === 0 ? (
        <div className="px-3 py-4 text-xs text-muted/60 text-center">No sessions</div>
      ) : (
        <ul className="border-b border-border/50">
          {tree.map((node) => (
            <SessionNode
              key={node.session.id}
              node={node}
              depth={0}
              activeSessionId={activeSessionId}
              onSelect={setActiveSessionId}
              onDelete={handleDeleteSession}
            />
          ))}
        </ul>
      )}

      {/* New session shortcut */}
      <div className="px-3 py-2">
        <button
          onClick={onNewSession}
          className="w-full py-1.5 text-xs bg-bg border border-border rounded text-muted hover:text-text hover:border-accent/50 transition-colors"
        >
          New session...
        </button>
      </div>
    </div>
  );
}
