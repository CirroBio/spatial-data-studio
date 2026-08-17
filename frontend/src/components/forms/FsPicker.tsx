import { useEffect, useState } from 'react';
import { browsePath, type FsEntry, type FsListing } from '../../api';

interface Props {
  mode: 'folder' | 'file' | 'either';
  value: string;                 // current selection (absolute, or relative to rootDir)
  onSelect: (val: string) => void;
  // When set, browsing is confined to this folder and the selection is returned
  // relative to it (for reader filename params joined onto a primary path).
  rootDir?: string;
}

// Strip a trailing slash so path comparisons and prefix math are consistent.
function trim(p: string): string {
  return p.replace(/\/+$/, '');
}

// A selection under `root` expressed relative to it (the reader joins it back on).
function toRelative(abs: string, root: string): string {
  const a = trim(abs);
  const r = trim(root);
  if (a === r) return '';
  return a.startsWith(r + '/') ? a.slice(r.length + 1) : a;
}

// Inline filesystem picker: the same browse list the checkpoint picker uses, but
// reusable per form field. Folder mode selects a directory (entering one selects
// it); file/either mode selects a file (or a .zarr "dataset" dir). With `rootDir`
// it stays within that folder and yields a relative path.
export default function FsPicker({ mode, value, onSelect, rootDir }: Props) {
  const includeFiles = mode !== 'folder';
  const [dir, setDir] = useState(rootDir ?? '');
  const [listing, setListing] = useState<FsListing | null>(null);
  const [filter, setFilter] = useState('');

  // Reset to the root when the confining folder changes (e.g. the primary path was
  // re-picked), so a relative-file picker never lists a stale base folder.
  useEffect(() => {
    setDir(rootDir ?? '');
    setFilter('');
  }, [rootDir]);

  useEffect(() => {
    browsePath(dir || rootDir || undefined, includeFiles).then(setListing).catch(() => setListing(null));
  }, [dir, rootDir, includeFiles]);

  const atRoot = rootDir ? trim(listing?.path ?? '') === trim(rootDir) : !listing?.path;
  const activePath = value ? (rootDir ? `${trim(rootDir)}/${value}` : value) : '';

  const q = filter.trim().toLowerCase();
  // Folder mode lists plain directories only: a `.zarr`/`.zarr.zip` "dataset" entry is
  // a store to open, never a folder to acquire a reader's raw bundle from or to write a
  // checkpoint into, and selecting one would just be rejected downstream.
  const entries = (listing?.entries ?? []).filter(
    (e) => e.name.toLowerCase().includes(q) && (mode !== 'folder' || e.kind === 'dir'),
  );

  function select(absPath: string) {
    onSelect(rootDir ? toRelative(absPath, rootDir) : absPath);
  }

  function choose(entry: FsEntry) {
    if (entry.kind === 'dir') {
      setDir(entry.path);
      setFilter('');
      if (mode === 'folder') select(entry.path);  // entering a folder selects it
    } else {
      // 'dataset' (a .zarr dir) or 'file' — both are selectable targets
      select(entry.path);
    }
  }

  function goUp() {
    if (atRoot) return;
    setDir(listing?.parent ?? '');
    setFilter('');
  }

  return (
    <div className="border border-border rounded bg-bg/40 flex flex-col">
      <div className="shrink-0 border-b border-border px-2 py-1.5 flex flex-col gap-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={goUp}
            disabled={atRoot}
            className="shrink-0 px-1.5 py-0.5 text-[11px] font-mono rounded border border-border text-muted hover:text-text hover:bg-bg disabled:opacity-40 disabled:hover:text-muted disabled:hover:bg-transparent transition-colors"
            title="Up one level"
          >
            ⬆ Up
          </button>
          <span className="text-[11px] font-mono text-muted truncate" title={listing?.path || '/'}>
            {listing?.path || 'roots'}
          </span>
        </div>
        <input
          type="text"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoComplete="off"
          role="presentation"
          spellCheck={false}
          className="w-full bg-bg border border-border rounded px-2 py-1 text-[11px] text-text placeholder-muted/50 focus:outline-none focus:border-accent font-mono"
        />
      </div>
      <div className="max-h-44 overflow-y-auto">
        {entries.map((entry) => {
          const active = trim(entry.path) === trim(activePath);
          return (
            <button
              key={entry.path}
              type="button"
              onClick={() => choose(entry)}
              title={entry.path}
              className={`w-full text-left px-2 py-1.5 flex items-center gap-2 border-b border-border/40 ${
                active ? 'bg-accent/20' : 'hover:bg-accent-lo/30'
              }`}
            >
              <span className={entry.kind === 'dataset' ? 'text-accent shrink-0' : 'text-muted shrink-0'}>
                {entry.kind === 'dataset' ? '▣' : entry.kind === 'dir' ? '📁' : '📄'}
              </span>
              <span className="text-[11px] font-mono text-text truncate">{entry.name}</span>
              <span className="ml-auto shrink-0 text-[9px] text-muted/60">
                {entry.kind === 'dataset' ? 'dataset' : entry.kind === 'dir' ? '›' : 'file'}
              </span>
            </button>
          );
        })}
        {entries.length === 0 && (
          <div className="px-2 py-4 text-center text-[11px] text-muted/60">
            {listing ? 'Nothing here' : 'Nothing to show'}
          </div>
        )}
      </div>
    </div>
  );
}
