import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { createSession, browsePath, getDatasets } from '../api';
import { useAppStore } from '../store/sessionStore';
import { formatError } from '../lib/format';
import AnsiLog from './AnsiLog';
import type { SessionSummary, FunctionEntry } from '../types';
import type { FsEntry, FsListing, NewSessionSource, DatasetEntry } from '../api';

interface Props {
  onClose: () => void;
  onCreated: (session: SessionSummary) => void;
}

function readerLabel(r: FunctionEntry): string {
  return r.label ?? `${r.function} (${r.source.replace(/_/g, '-')})`;
}

// Default session name derived from a selected path: the basename with any store
// extension and the auto-appended content-hash suffix ("-<12 hex>", see backend
// persistence.store.strip_content_hash) stripped — matches what the backend would
// derive from a checkpoint filename, and gives folder imports the folder's name.
function deriveSessionName(path: string): string {
  const base = path.replace(/\/+$/, '').split('/').pop() ?? '';
  const stem = base
    .replace(/\.sdata\.zarr\.zip$/, '')
    .replace(/\.zarr\.tar\.gz$/, '')
    .replace(/\.zarr\.tgz$/, '')
    .replace(/\.zarr\.zip$/, '')
    .replace(/\.zarr$/, '');
  return stem.replace(/-[0-9a-f]{12}$/, '');
}

// Save time of a dataset/session file as a sortable "YYYY-MM-DD HH:mm" prefix.
function formatTimestamp(mtime: number): string {
  if (!mtime) return '';
  const d = new Date(mtime * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function NewSessionDialog({ onClose, onCreated }: Props) {
  const functions = useAppStore((s) => s.functions);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const loadProgress = useAppStore((s) => s.loadProgress);
  const setLoadProgress = useAppStore((s) => s.setLoadProgress);
  const loadLog = useAppStore((s) => s.loadLog);
  const resetLoadLog = useAppStore((s) => s.resetLoadLog);
  const readers = functions.filter((f) => f.effect_class === 'read');

  const [mode, setMode] = useState<'load' | 'import'>('load');
  const [reader, setReader] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);  // user typed a name -> stop autofilling
  const [selectedPath, setSelectedPath] = useState('');  // chosen checkpoint / folder / file
  const [loading, setLoading] = useState(false);
  const [loadId, setLoadId] = useState<string | null>(null);  // nonce matching this load's SSE progress
  const [error, setError] = useState<string | null>(null);

  const selectedReader = readers.find((f) => f.key === reader);
  // What the import picker should let the user land on: spatialdata-io readers take
  // a raw acquisition folder; the SpatialData reader takes a folder or an archive.
  const inputKind = selectedReader?.input_kind ?? 'folder';
  const browserTitle = mode === 'load' ? 'Checkpoints'
    : inputKind === 'folder' ? 'Data folder' : inputKind === 'file' ? 'Data file' : 'Data path';
  const browserHint = mode === 'load' ? 'saved .sdata.zarr.zip checkpoints in the data folder'
    : inputKind === 'folder' ? 'open the raw data folder for the chosen reader'
    : inputKind === 'file' ? 'pick a data file for the chosen reader'
    : 'pick a .zarr folder, or a .zarr.zip / .zarr.tar.gz archive';

  const [datasets, setDatasets] = useState<DatasetEntry[]>([]);
  const [datasetsLoading, setDatasetsLoading] = useState(true);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [browseDir, setBrowseDir] = useState('');  // directory currently listed (import mode; '' = roots)
  const [filter, setFilter] = useState('');        // filters the current listing by name

  // Load mode: autodetect every loadable checkpoint under the checkpoint folders once.
  useEffect(() => {
    getDatasets()
      .then(({ datasets: d }) => setDatasets(d))
      .catch(() => setDatasets([]))
      .finally(() => setDatasetsLoading(false));
  }, []);

  // Import mode: list the current directory so the user can navigate to a dataset.
  // Folder-only readers hide files (so the user lands on a folder); file/either
  // readers list files too, so archives and data files are selectable.
  useEffect(() => {
    if (mode !== 'import') return;
    browsePath(browseDir || undefined, inputKind !== 'folder').then(setListing).catch(() => setListing(null));
  }, [browseDir, mode, inputKind]);

  const q = filter.trim().toLowerCase();
  const datasetMatches = datasets
    .filter((d) => d.name.toLowerCase().includes(q) || d.path.toLowerCase().includes(q))
    .sort((a, b) => b.mtime - a.mtime);
  const browseMatches: FsEntry[] = (listing?.entries ?? []).filter((e) =>
    e.name.toLowerCase().includes(q)
  );

  // Fill the (empty, untouched) name field from a chosen path so the user rarely
  // has to type one; a name they typed themselves is never overwritten.
  function selectPath(p: string) {
    setSelectedPath(p);
    if (!nameEdited) setName(deriveSessionName(p));
    setError(null);
  }

  // Navigate into a directory. For folder-input readers, entering a folder also
  // selects it as the dataset target (there is nothing to pick inside it).
  function navTo(dir: string) {
    setBrowseDir(dir);
    setFilter('');
    if (mode === 'import' && inputKind === 'folder' && dir) selectPath(dir);
  }

  function chooseEntry(entry: FsEntry) {
    if (entry.kind === 'dir') navTo(entry.path);
    else selectPath(entry.path);
  }

  function goUp() {
    navTo(listing?.parent ?? '');
  }

  function switchMode(m: 'load' | 'import') {
    setMode(m);
    setError(null);
    setSelectedPath('');
    setFilter('');
    setBrowseDir('');
    if (m === 'import' && !reader && readers[0]) setReader(readers[0].key);
  }

  async function submit() {
    const chosen = selectedPath.trim();
    if (!chosen) {
      setError(mode === 'import'
        ? (inputKind === 'folder' ? 'Open the dataset folder' : 'Pick a dataset')
        : 'Select a checkpoint');
      return;
    }
    let source: NewSessionSource;
    if (mode === 'import') {
      const r = readers.find((f) => f.key === reader);
      if (!r) { setError('Select a reader for the dataset format'); return; }
      const req = ((r.json_schema as { required?: string[] }).required) ?? [];
      const pathParam = req.find((p) => ['path', 'input', 'image_path'].includes(p)) ?? req[0] ?? 'path';
      source = { kind: 'read', namespace: r.namespace, function: r.function, params: { [pathParam]: chosen } };
    } else {
      source = { kind: 'load', path: chosen };
    }
    const id = crypto.randomUUID();
    setLoadId(id);
    setLoading(true);
    setError(null);
    resetLoadLog();
    try {
      const finalName = name.trim() || deriveSessionName(chosen);
      const session = await createSession({ name: finalName || undefined, source, load_id: id });
      if (session.hash_check) {
        pushNotification({
          kind: session.hash_check.ok ? 'info' : 'error',
          message: session.hash_check.message,
        });
      }
      onCreated(session);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
      setLoadId(null);
      setLoadProgress(null);
      resetLoadLog();
    }
  }

  const fieldClass = 'w-full bg-bg border border-border rounded px-3 py-2 text-sm text-text placeholder-muted/50 focus:outline-none focus:border-accent';

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
        <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface border border-border rounded-lg shadow-2xl w-[860px] max-w-[94vw] h-[620px] max-h-[90vh] overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
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
            className="flex flex-col min-h-0 flex-1"
          >
            <div className="flex flex-1 min-h-0">
              {/* Left: source options */}
              <aside className="w-64 shrink-0 border-r border-border p-4 flex flex-col gap-4 overflow-y-auto">
                {/* Open an existing checkpoint, or import a raw dataset via a reader */}
                <div className="grid grid-cols-2 gap-1 p-0.5 bg-bg border border-border rounded">
                  {(['load', 'import'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => switchMode(m)}
                      className={`py-1.5 text-xs rounded transition-colors ${
                        mode === m ? 'bg-accent/20 text-accent' : 'text-muted hover:text-text'
                      }`}
                    >
                      {m === 'load' ? 'Open Checkpoint' : 'Import Data'}
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
                      onChange={(e) => { setReader(e.target.value); setSelectedPath(''); }}
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
                  {/* role=presentation makes Chrome skip address/profile autofill (it ignores
                      autocomplete=off); ARIA ignores the role on focusable elements, so a11y is
                      unaffected. Applied to every text input in this dialog for the same reason. */}
                  <input
                    type="text"
                    placeholder="e.g. visium_hne"
                    value={name}
                    onChange={(e) => { setName(e.target.value); setNameEdited(e.target.value.trim() !== ''); }}
                    autoComplete="off"
                    role="presentation"
                    className={fieldClass}
                  />
                </div>

                {error && (
                  <div className="text-xs text-danger bg-danger/10 border border-danger/20 rounded px-3 py-2">
                    {error}
                  </div>
                )}
              </aside>

              {/* Right: file browser */}
              <section className="flex-1 min-w-0 flex flex-col bg-bg/40">
                <div className="shrink-0 border-b border-border px-3 py-2 flex flex-col gap-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-semibold text-text">{browserTitle}</span>
                    <span className="text-[11px] text-muted/70 truncate">{browserHint}</span>
                  </div>

                  {mode === 'import' && (
                    <div className="flex items-center gap-2 min-w-0">
                      <button
                        type="button"
                        onClick={goUp}
                        disabled={!browseDir}
                        className="shrink-0 px-2 py-1 text-xs font-mono rounded border border-border text-muted hover:text-text hover:bg-bg disabled:opacity-40 disabled:hover:text-muted disabled:hover:bg-transparent transition-colors"
                        title="Up one level"
                      >
                        ⬆ Up
                      </button>
                      <span className="text-[11px] font-mono text-muted truncate" title={listing?.path || '/'}>
                        {listing?.path || 'roots'}
                      </span>
                    </div>
                  )}

                  <input
                    type="text"
                    placeholder={mode === 'load' ? 'Search checkpoints…' : 'Filter this folder…'}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    autoComplete="off"
                    role="presentation"
                    spellCheck={false}
                    className="w-full bg-bg border border-border rounded px-3 py-1.5 text-xs text-text placeholder-muted/50 focus:outline-none focus:border-accent font-mono"
                  />
                </div>

                <div className="flex-1 overflow-y-auto">
                  {mode === 'load' && (
                    <>
                      {datasetMatches.map((d) => {
                        const active = d.path === selectedPath;
                        return (
                          <button
                            key={d.path}
                            type="button"
                            onClick={() => selectPath(d.path)}
                            onDoubleClick={() => { selectPath(d.path); submit(); }}
                            title={d.path}
                            className={`w-full text-left px-3 py-2 flex items-center gap-2 border-b border-border/40 ${
                              active ? 'bg-accent/20' : 'hover:bg-accent-lo/30'
                            }`}
                          >
                            <span className="text-accent shrink-0">▣</span>
                            {d.mtime > 0 && (
                              <span className="text-[10px] font-mono text-muted/70 shrink-0" style={{ fontVariantNumeric: 'tabular-nums' }}>
                                {formatTimestamp(d.mtime)}
                              </span>
                            )}
                            <span className="text-xs font-mono text-text truncate">{d.name}</span>
                          </button>
                        );
                      })}
                      {datasetMatches.length === 0 && (
                        <div className="px-3 py-6 text-center text-xs text-muted/60">
                          {datasetsLoading
                            ? 'Loading checkpoints…'
                            : datasets.length
                            ? 'No matching checkpoints'
                            : 'No saved checkpoints found'}
                        </div>
                      )}
                    </>
                  )}

                  {mode === 'import' && (
                    <>
                      {browseMatches.map((entry) => {
                        const active = entry.path === selectedPath;
                        return (
                          <button
                            key={entry.path}
                            type="button"
                            onClick={() => chooseEntry(entry)}
                            onDoubleClick={() => { if (entry.kind !== 'dir') { selectPath(entry.path); submit(); } }}
                            title={entry.path}
                            className={`w-full text-left px-3 py-2 flex items-center gap-2 border-b border-border/40 ${
                              active ? 'bg-accent/20' : 'hover:bg-accent-lo/30'
                            }`}
                          >
                            <span className={entry.kind === 'dataset' ? 'text-accent shrink-0' : 'text-muted shrink-0'}>
                              {entry.kind === 'dataset' ? '▣' : entry.kind === 'dir' ? '📁' : '📄'}
                            </span>
                            <span className="text-xs font-mono text-text truncate">{entry.name}</span>
                            <span className="ml-auto shrink-0 text-[10px] text-muted/60">
                              {entry.kind === 'dataset' ? 'dataset' : entry.kind === 'dir' ? '›' : 'file'}
                            </span>
                          </button>
                        );
                      })}
                      {browseMatches.length === 0 && (
                        <div className="px-3 py-6 text-center text-xs text-muted/60">
                          {listing ? 'Empty folder' : 'Nothing to show'}
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="shrink-0 border-t border-border px-3 py-2 text-[11px] font-mono truncate">
                  {selectedPath
                    ? <><span className="text-muted">Selected: </span><span className="text-text" title={selectedPath}>{selectedPath}</span></>
                    : <span className="text-muted/60">
                        {mode === 'import' && inputKind === 'folder' ? 'Open a folder to select it' : 'Nothing selected'}
                      </span>}
                </div>
              </section>
            </div>

            <div className="shrink-0 border-t border-border px-4 py-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-muted hover:text-text border border-border rounded hover:bg-bg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !selectedPath}
                className="px-4 py-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white rounded text-sm transition-colors"
              >
                {loading ? 'Loading...' : 'Load'}
              </button>
            </div>
          </form>

          {loading && (() => {
            // Live load progress arrives on the SSE bus keyed by this load's nonce; a
            // stale entry from another load (or an import, which emits none) is ignored.
            const live = mode === 'load' && loadProgress?.load_id === loadId ? loadProgress : null;
            const message = live?.message ?? (mode === 'import' ? 'Importing data…' : 'Loading checkpoint…');
            const pct = live?.pct;
            return (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface/80 backdrop-blur-[1px] px-6">
                <div className="w-8 h-8 rounded-full border-2 border-border border-t-accent animate-spin" />
                <span className="text-sm text-text">{message}</span>
                {pct != null && (
                  <div className="w-48 h-1.5 rounded-full bg-border overflow-hidden">
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(pct * 100)}%` }} />
                  </div>
                )}
                {loadLog && (
                  <AnsiLog
                    text={loadLog}
                    className="w-full max-w-lg mt-1 bg-bg border border-border rounded p-3 text-xs font-mono text-muted overflow-auto max-h-48 whitespace-pre-wrap"
                  />
                )}
              </div>
            );
          })()}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
