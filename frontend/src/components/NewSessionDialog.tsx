import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { createSession, browsePath, getDatasets } from '../api';
import { useAppStore } from '../store/sessionStore';
import { formatError } from '../lib/errors';
import type { SessionSummary, FunctionEntry } from '../types';
import type { FsEntry, FsListing, NewSessionSource, DatasetEntry } from '../api';

interface Props {
  onClose: () => void;
  onCreated: (session: SessionSummary) => void;
}

// Directory portion of the current input (what we ask the backend to list, import
// mode only) and the trailing fragment used to filter the listing as the user types.
function splitPath(input: string): { dir: string; partial: string } {
  const i = input.lastIndexOf('/');
  if (i < 0) return { dir: '', partial: input };
  return { dir: input.slice(0, i), partial: input.slice(i + 1) };
}

function readerLabel(r: FunctionEntry): string {
  return r.label ?? `${r.function} (${r.source.replace(/_/g, '-')})`;
}

export default function NewSessionDialog({ onClose, onCreated }: Props) {
  const functions = useAppStore((s) => s.functions);
  const readers = functions.filter((f) => f.effect_class === 'read');

  const [mode, setMode] = useState<'load' | 'import'>('load');
  const [reader, setReader] = useState('');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [datasets, setDatasets] = useState<DatasetEntry[]>([]);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { dir, partial } = splitPath(path);

  // Load mode: autodetect every loadable dataset under the data folders once.
  useEffect(() => {
    getDatasets()
      .then(({ datasets: d }) => setDatasets(d))
      .catch(() => setDatasets([]));
  }, []);

  // Import mode: browse the filesystem so the user can navigate to a raw folder.
  useEffect(() => {
    if (!open || mode !== 'import') return;
    const t = setTimeout(() => {
      browsePath(dir || undefined, true).then(setListing).catch(() => setListing(null));
    }, 150);
    return () => clearTimeout(t);
  }, [dir, open, mode]);

  const q = path.trim().toLowerCase();
  const datasetMatches = datasets.filter(
    (d) => d.name.toLowerCase().includes(q) || d.path.toLowerCase().includes(q)
  );
  const browseMatches: FsEntry[] = (listing?.entries ?? []).filter((e) =>
    e.name.toLowerCase().includes(partial.toLowerCase())
  );

  function chooseDataset(d: DatasetEntry) {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    setPath(d.path);
    setOpen(false);
  }

  function chooseEntry(entry: FsEntry) {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    if (entry.kind === 'dir') {
      setPath(entry.path + '/'); // drill in; the effect re-lists
      setOpen(true);
    } else {
      setPath(entry.path);
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
      setError(mode === 'import' ? 'Dataset folder is required' : 'Select a dataset');
      return;
    }
    let source: NewSessionSource;
    if (mode === 'import') {
      const r = readers.find((f) => f.key === reader);
      if (!r) { setError('Select a reader for the dataset format'); return; }
      const req = ((r.json_schema as { required?: string[] }).required) ?? [];
      const pathParam = req.find((p) => ['path', 'input', 'image_path'].includes(p)) ?? req[0] ?? 'path';
      source = { kind: 'read', namespace: r.namespace, function: r.function, params: { [pathParam]: path.trim() } };
    } else {
      source = { kind: 'load', path: path.trim() };
    }
    setLoading(true);
    setError(null);
    try {
      const session = await createSession({ name: name.trim() || undefined, source });
      onCreated(session);
    } catch (err) {
      setError(formatError(err));
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
            {/* Source mode: open an existing .zarr, or import a raw dataset via a reader */}
            <div className="grid grid-cols-2 gap-1 p-0.5 bg-bg border border-border rounded">
              {(['load', 'import'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setMode(m); setError(null); setPath(''); setOpen(false); if (m === 'import' && !reader && readers[0]) setReader(readers[0].key); }}
                  className={`py-1.5 text-xs rounded transition-colors ${
                    mode === m ? 'bg-accent/20 text-accent' : 'text-muted hover:text-text'
                  }`}
                >
                  {m === 'load' ? 'Open dataset (.zarr)' : 'Import raw data'}
                </button>
              ))}
            </div>

            {mode === 'import' && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-mono text-muted">
                  Format / reader <span className="text-danger">*</span>
                </label>
                <select
                  value={reader}
                  onChange={(e) => setReader(e.target.value)}
                  className="bg-bg border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-accent"
                >
                  <option value="">-- select a reader --</option>
                  {readers.map((r) => (
                    <option key={r.key} value={r.key}>{readerLabel(r)}</option>
                  ))}
                </select>
                {readers.length === 0 && (
                  <span className="text-[11px] text-muted/60">Readers unavailable — is the backend running?</span>
                )}
              </div>
            )}

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
                {mode === 'import' ? 'Dataset folder' : 'Dataset'} <span className="text-danger">*</span>
                <span className="ml-1 normal-case font-sans text-muted/60">
                  {mode === 'import' ? '(raw dataset folder for the chosen reader)' : '(.zarr / .zarr.zip)'}
                </span>
              </label>
              <input
                type="text"
                placeholder={mode === 'import' ? 'navigate to the raw dataset folder…' : 'click to see available datasets, or type to filter…'}
                value={path}
                onChange={(e) => { setPath(e.target.value); setOpen(true); }}
                onFocus={() => setOpen(true)}
                onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
                autoComplete="off"
                spellCheck={false}
                className="bg-bg border border-border rounded px-3 py-2 text-sm text-text placeholder-muted/50 focus:outline-none focus:border-accent font-mono"
              />

              {open && mode === 'load' && (
                <div className="absolute top-full left-0 right-0 mt-1 z-10 max-h-60 overflow-y-auto bg-surface border border-border rounded shadow-xl">
                  {datasetMatches.map((d) => (
                    <button
                      key={d.path}
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); chooseDataset(d); }}
                      title={d.path}
                      className="w-full text-left px-3 py-1.5 hover:bg-accent-lo/30 flex items-center gap-2"
                    >
                      <span className="text-accent">▣</span>
                      <span className="text-xs font-mono text-text truncate">{d.name}</span>
                    </button>
                  ))}
                  {datasetMatches.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted/60">
                      {datasets.length ? 'No matching datasets' : 'No datasets found under the data folders'}
                    </div>
                  )}
                </div>
              )}

              {open && mode === 'import' && (
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
                  {browseMatches.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); chooseEntry(entry); }}
                      className="w-full text-left px-3 py-1.5 hover:bg-accent-lo/30 flex items-center gap-2"
                    >
                      <span className={entry.kind === 'dataset' ? 'text-accent' : 'text-muted'}>
                        {entry.kind === 'dataset' ? '▣' : entry.kind === 'dir' ? '📁' : '📄'}
                      </span>
                      <span className="text-xs font-mono text-text truncate">{entry.name}</span>
                      {entry.kind !== 'dir' && (
                        <span className="ml-auto text-[10px] text-muted/60">
                          {entry.kind === 'dataset' ? 'dataset' : 'file'}
                        </span>
                      )}
                    </button>
                  ))}
                  {browseMatches.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted/60">No matching folders or files</div>
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
