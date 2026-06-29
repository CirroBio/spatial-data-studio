import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { createSession, browsePath } from '../api';
import type { SessionSummary } from '../types';
import type { FsEntry, FsListing } from '../api';

interface Props {
  onClose: () => void;
  onCreated: (session: SessionSummary) => void;
}

// Directory portion of the current input — what we ask the backend to list — and
// the trailing fragment used to filter the listing client-side as the user types.
function splitPath(input: string): { dir: string; partial: string } {
  const i = input.lastIndexOf('/');
  if (i < 0) return { dir: '', partial: input };
  return { dir: input.slice(0, i), partial: input.slice(i + 1) };
}

export default function NewSessionDialog({ onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [listing, setListing] = useState<FsListing | null>(null);
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { dir, partial } = splitPath(path);

  // Fetch the directory listing (debounced) whenever the directory part changes.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      browsePath(dir || undefined)
        .then(setListing)
        .catch(() => setListing(null));
    }, 150);
    return () => clearTimeout(t);
  }, [dir, open]);

  const suggestions: FsEntry[] = (listing?.entries ?? []).filter((e) =>
    e.name.toLowerCase().startsWith(partial.toLowerCase())
  );

  function choose(entry: FsEntry) {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    if (entry.kind === 'dir') {
      setPath(entry.path + '/'); // drill in; the effect re-lists
      setOpen(true);
    } else {
      setPath(entry.path);       // dataset selected; ready to create
      setOpen(false);
    }
  }

  function goUp() {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    setPath(listing?.parent ? listing.parent + '/' : '');
    setOpen(true);
  }

  async function submit() {
    if (!path.trim()) {
      setError('File path is required');
      return;
    }
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
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
        <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface border border-border rounded-lg shadow-2xl w-[520px]">
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

          <form
            onSubmit={(e) => { e.preventDefault(); submit(); }}
            className="p-4 flex flex-col gap-4"
          >
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-mono text-muted">Session name (optional)</label>
              <input
                type="text"
                placeholder="e.g. visium_hne"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="bg-bg border border-border rounded px-3 py-2 text-sm text-text placeholder-muted/50 focus:outline-none focus:border-accent"
              />
            </div>

            <div className="flex flex-col gap-1.5 relative">
              <label className="text-xs font-mono text-muted">
                Dataset <span className="text-danger">*</span>
                <span className="ml-1 normal-case font-sans text-muted/60">(.zarr / .zarr.zip)</span>
              </label>
              <input
                type="text"
                placeholder="start typing or pick from the data folder…"
                value={path}
                onChange={(e) => { setPath(e.target.value); setOpen(true); }}
                onFocus={() => setOpen(true)}
                onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
                autoComplete="off"
                spellCheck={false}
                className="bg-bg border border-border rounded px-3 py-2 text-sm text-text placeholder-muted/50 focus:outline-none focus:border-accent font-mono"
              />

              {open && (
                <div className="absolute top-full left-0 right-0 mt-1 z-10 max-h-60 overflow-y-auto bg-surface border border-border rounded shadow-xl">
                  {path !== '' && (
                    <button
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); goUp(); }}
                      className="w-full text-left px-3 py-1.5 text-xs font-mono text-muted hover:bg-accent-lo/30 border-b border-border/50"
                    >
                      ⬆ ..
                    </button>
                  )}
                  {suggestions.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); choose(entry); }}
                      className="w-full text-left px-3 py-1.5 hover:bg-accent-lo/30 flex items-center gap-2"
                    >
                      <span className={entry.kind === 'dataset' ? 'text-accent' : 'text-muted'}>
                        {entry.kind === 'dataset' ? '▣' : '📁'}
                      </span>
                      <span className="text-xs font-mono text-text truncate">{entry.name}</span>
                      {entry.kind === 'dataset' && (
                        <span className="ml-auto text-[10px] text-muted/60">dataset</span>
                      )}
                    </button>
                  ))}
                  {suggestions.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted/60">No matching datasets or folders</div>
                  )}
                </div>
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
