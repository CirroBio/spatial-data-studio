import { useEffect, useState } from 'react';
import SnapshotViewer from './SnapshotViewer';
import { formatCreated } from '../lib/snapshots';

// One entry of the bundle's snapshots/index.json manifest (written by the backend
// at Cirro-upload time). `name` is the JSON config filename under snapshots/.
interface ManifestEntry {
  name: string;
  label: string;
  created: string;
  kind: 'spatial' | 'embedding';
}

const CKPT_PREFIX = '/api/checkpoints/';

// The snapshot configs and the app were written for the live server, where a
// checkpoint lives at /api/checkpoints/<name>. In the uploaded bundle every path is
// relative to this page: configs under snapshots/, checkpoints under sessions/.
function resolveUrl(url: string): string {
  if (url.startsWith(CKPT_PREFIX)) return `sessions/${url.slice(CKPT_PREFIX.length)}`;
  return url;
}

const THEME_KEY = 'sds-viewer-theme';

function readTheme(): 'dark' | 'light' {
  return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
}

function selectedFromQuery(entries: ManifestEntry[]): string | null {
  const q = new URLSearchParams(window.location.search).get('snapshot');
  if (q && entries.some((e) => e.name === q)) return q;
  return entries.length ? entries[0].name : null;
}

// Static, read-only snapshot viewer for the self-contained bundle uploaded to
// Cirro. Lists the bundled snapshots in a picker, keeps the selection in the
// `?snapshot=` query param (so a link opens a specific view), and renders the
// selected one with SnapshotViewer reading directly from the bundle's zarr.
export default function StandaloneViewer() {
  const [entries, setEntries] = useState<ManifestEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    fetch('snapshots/index.json')
      .then((res) => {
        if (!res.ok) throw new Error(`manifest: ${res.status}`);
        return res.json() as Promise<ManifestEntry[]>;
      })
      .then((list) => {
        setEntries(list);
        setSelected(selectedFromQuery(list));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Back/forward navigation re-reads the query param.
  useEffect(() => {
    const onPop = () => entries && setSelected(selectedFromQuery(entries));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [entries]);

  function select(name: string) {
    setSelected(name);
    const params = new URLSearchParams(window.location.search);
    params.set('snapshot', name);
    window.history.replaceState(null, '', `?${params.toString()}`);
  }

  const url = selected ? `snapshots/${selected}` : null;

  return (
    <div className="w-full h-full flex flex-col bg-bg text-text">
      <header className="flex items-center justify-between gap-3 px-4 h-12 bg-surface border-b border-border shrink-0">
        <span className="text-accent font-semibold tracking-wide text-sm">Spatial Data Studio — Snapshots</span>
        <div className="flex items-center gap-2">
          {entries && entries.length > 0 && (
            <select
              value={selected ?? ''}
              onChange={(e) => select(e.target.value)}
              className="bg-bg border border-border rounded px-2 py-1 text-sm text-text max-w-[60vw]"
            >
              {entries.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.label} · {e.kind}{formatCreated(e.created) && ` · ${formatCreated(e.created)}`}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="p-1.5 rounded border border-border bg-bg text-text hover:border-accent hover:text-accent transition-colors"
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0">
        {error && (
          <div className="w-full h-full flex items-center justify-center text-danger text-sm px-6 text-center">
            Failed to load snapshots: {error}
          </div>
        )}
        {!error && entries && entries.length === 0 && (
          <div className="w-full h-full flex items-center justify-center text-muted text-sm">
            This bundle contains no snapshots.
          </div>
        )}
        {!error && url && <SnapshotViewer key={url} url={url} resolveUrl={resolveUrl} />}
      </div>
    </div>
  );
}
