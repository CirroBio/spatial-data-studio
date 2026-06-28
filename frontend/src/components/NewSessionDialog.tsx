import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useForm } from 'react-hook-form';
import { createSession } from '../api';
import type { SessionSummary } from '../types';

interface Props {
  onClose: () => void;
  onCreated: (session: SessionSummary) => void;
}

interface FormValues {
  name: string;
  path: string;
}

export default function NewSessionDialog({ onClose, onCreated }: Props) {
  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit({ name, path }: FormValues) {
    setLoading(true);
    setError(null);
    try {
      const session = await createSession({
        name: name.trim() || undefined,
        source: { kind: 'load', path: path.trim() },
      });
      onCreated(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
        <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface border border-border rounded-lg shadow-2xl w-[480px]">
          <div className="flex items-center justify-between p-4 border-b border-border">
            <Dialog.Title className="text-sm font-semibold text-text">New Session</Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-muted hover:text-text transition-colors" aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </Dialog.Close>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="p-4 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-mono text-muted">Session name (optional)</label>
              <input
                type="text"
                placeholder="e.g. visium_hne"
                {...register('name')}
                className="bg-bg border border-border rounded px-3 py-2 text-sm text-text placeholder-muted/50 focus:outline-none focus:border-accent"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-mono text-muted">File path <span className="text-danger">*</span></label>
              <input
                type="text"
                placeholder="/path/to/data.h5ad"
                {...register('path', { required: 'File path is required' })}
                className="bg-bg border border-border rounded px-3 py-2 text-sm text-text placeholder-muted/50 focus:outline-none focus:border-accent font-mono"
              />
              {errors.path && (
                <span className="text-xs text-danger">{errors.path.message}</span>
              )}
            </div>

            {error && (
              <div className="text-xs text-danger bg-danger/10 border border-danger/20 rounded px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-muted hover:text-text border border-border rounded hover:bg-bg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="px-4 py-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white rounded text-sm transition-colors"
              >
                {loading ? 'Creating...' : 'Create'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
