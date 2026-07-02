import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { getBundledRecipes, importRecipe, getSession, type BundledRecipe } from '../api';
import { formatError, reportError } from '../lib/errors';

interface Props {
  sessionId: string;
  onClose: () => void;
}

export default function RecipeGallery({ sessionId, onClose }: Props) {
  const { setSessionState, pushNotification } = useAppStore();
  const [recipes, setRecipes] = useState<BundledRecipe[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    getBundledRecipes()
      .then(({ recipes: r }) => setRecipes(r))
      .catch((err) => setError(formatError(err)));
  }, []);

  async function run(recipe: BundledRecipe) {
    setRunning(recipe.name);
    try {
      await importRecipe(sessionId, { steps: recipe.steps }, 'run');
      setSessionState(await getSession(sessionId));
      pushNotification({ kind: 'info', message: `Running recipe: ${recipe.name}` });
      onClose();
    } catch (err) {
      reportError('Recipe failed', err);
      setRunning(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-lg shadow-xl w-[560px] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-text">Analysis recipes</h2>
            <p className="text-xs text-muted">Curated squidpy workflows — queues every step in order.</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text transition-colors" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          {error && <div className="text-xs text-danger px-1">{error}</div>}
          {!recipes && !error && <div className="text-xs text-muted px-1">Loading…</div>}
          {recipes?.map((r) => (
            <div key={r.name} className="border border-border rounded-md p-3 bg-bg">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-text font-medium">{r.name}</div>
                  <p className="text-xs text-muted mt-0.5">{r.description}</p>
                </div>
                <button
                  onClick={() => run(r)}
                  disabled={running !== null}
                  className="shrink-0 px-3 py-1.5 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white rounded text-xs transition-colors"
                >
                  {running === r.name ? 'Running…' : 'Run'}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {r.steps.map((s, i) => (
                  <span key={i} className="text-[10px] font-mono text-muted bg-surface border border-border rounded px-1.5 py-0.5">
                    {s.namespace}.{s.function}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
