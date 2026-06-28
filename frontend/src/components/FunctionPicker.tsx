import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAppStore } from '../store/sessionStore';
import { submitJob } from '../api';
import FunctionForm from './forms/FunctionForm';
import type { FunctionEntry } from '../types';

interface Props {
  sessionId: string;
  effectClass: 'compute' | 'plot';
  onClose: () => void;
}

export default function FunctionPicker({ sessionId, effectClass, onClose }: Props) {
  const { functions, sessionState } = useAppStore();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<FunctionEntry | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fields = sessionState?.fields ?? {
    obs: [], obsm: [], var_names_count: 0, obsp: [], layers: [], images: [], shapes: [],
  };

  const filtered = functions.filter((fn) => {
    if (fn.effect_class !== effectClass) return false;  // Compute tab -> compute fns only, etc.
    const q = search.toLowerCase();
    return (
      fn.key.toLowerCase().includes(q) ||
      fn.summary.toLowerCase().includes(q)
    );
  });

  async function handleSubmit(params: Record<string, unknown>) {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitJob(sessionId, {
        namespace: selected.namespace,
        function: selected.function,
        params,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
        <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface border border-border rounded-lg shadow-2xl w-[640px] max-h-[80vh] flex flex-col overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
            <Dialog.Title className="text-sm font-semibold text-text">
              {selected ? (
                <button
                  onClick={() => setSelected(null)}
                  className="flex items-center gap-2 text-muted hover:text-text transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M19 12H5M12 5l-7 7 7 7" />
                  </svg>
                  Back
                </button>
              ) : (
                `Add ${effectClass} function`
              )}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-muted hover:text-text transition-colors" aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </Dialog.Close>
          </div>

          {!selected ? (
            <>
              <div className="p-3 border-b border-border shrink-0">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search functions..."
                  className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm text-text placeholder-muted focus:outline-none focus:border-accent"
                  autoFocus
                />
              </div>
              <div className="overflow-y-auto flex-1">
                {filtered.map((fn) => (
                  <button
                    key={fn.key}
                    onClick={() => setSelected(fn)}
                    className="w-full text-left px-4 py-3 border-b border-border/50 hover:bg-accent-lo/30 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-accent">{fn.namespace}</span>
                      <span className="text-sm text-text">{fn.function}</span>
                      <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded ${fn.effect_class === 'plot' ? 'bg-warn/20 text-warn' : 'bg-accent/20 text-accent'}`}>
                        {fn.effect_class}
                      </span>
                      {fn.partially_supported && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/20 text-muted">partial</span>
                      )}
                    </div>
                    <p className="text-xs text-muted mt-0.5 line-clamp-1">{fn.summary}</p>
                  </button>
                ))}
                {filtered.length === 0 && (
                  <div className="px-4 py-8 text-sm text-muted text-center">No functions match</div>
                )}
              </div>
            </>
          ) : (
            <div className="p-4 overflow-y-auto flex-1">
              <div className="mb-4">
                <div className="text-sm font-semibold text-text font-mono">{selected.namespace}.{selected.function}</div>
                {selected.doc ? (
                  <pre className="mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border bg-bg/60 px-3 py-2 text-[11px] leading-snug text-muted font-mono">
                    {selected.doc}
                  </pre>
                ) : (
                  <p className="text-xs text-muted mt-1">{selected.summary || 'No description available.'}</p>
                )}
              </div>
              {error && (
                <div className="mb-3 text-xs text-danger bg-danger/10 border border-danger/20 rounded px-3 py-2">
                  {error}
                </div>
              )}
              <FunctionForm
                fn={selected}
                fields={fields}
                onSubmit={handleSubmit}
                submitting={submitting}
              />
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
