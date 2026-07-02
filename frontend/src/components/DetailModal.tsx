import { useEffect } from 'react';
import StatusBadge, { type Status } from './StatusBadge';

interface Props {
  onClose: () => void;
  children: React.ReactNode;
}

interface DetailHeaderProps {
  title: string;
  status: Status;
  onClose: () => void;
  children?: React.ReactNode;
}

// Header shared by ComputeDetail/PlotDetail: a close icon, the namespace.function
// label, a status badge, and per-view action buttons passed in as children.
export function DetailHeader({ title, status, onClose, children }: DetailHeaderProps) {
  return (
    <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
      <div className="flex items-center gap-3">
        <button onClick={onClose} className="text-muted hover:text-text transition-colors" aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        <span className="text-sm font-mono text-text">{title}</span>
        <StatusBadge status={status} />
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

// Parameters block shared by ComputeDetail/PlotDetail; callers keep their own
// outer wrapper since the two views embed it in different layouts.
export function ParametersSection({ params }: { params: Record<string, unknown> }) {
  return (
    <>
      <h3 className="text-xs font-mono text-muted uppercase tracking-wide mb-2">Parameters</h3>
      <pre className="bg-bg border border-border rounded p-3 text-xs font-mono text-text overflow-x-auto">
        {Object.keys(params).length ? JSON.stringify(params, null, 2) : 'No parameters.'}
      </pre>
    </>
  );
}

// Shell for the compute/plot detail views — a large centered panel over the
// current viewer (canvas or table inspector). Closes on backdrop click or Esc.
export default function DetailModal({ onClose, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border rounded-lg shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
