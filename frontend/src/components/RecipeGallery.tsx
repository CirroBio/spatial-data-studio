import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { getBundledRecipes, importRecipe, getSession, preflightRecipe, type BundledRecipe } from '../api';
import { formatError, reportError } from '../lib/errors';
import { ModalOverlay, ModalHeader } from './DetailModal';

interface Props {
  sessionId: string;
  onClose: () => void;
}

export default function RecipeGallery({ sessionId, onClose }: Props) {
  const { setSessionState, pushNotification } = useAppStore();
  const [recipes, setRecipes] = useState<BundledRecipe[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    getBundledRecipes()
      .then(({ recipes: r }) => setRecipes(r))
      .catch((err) => setError(formatError(err)));
  }, []);

  async function apply(recipe: BundledRecipe, mode: 'run' | 'stage') {
    setRunning(recipe.name);
    try {
      const pf = await preflightRecipe(sessionId, { steps: recipe.steps });
      if (pf.unknown_functions.length > 0) {
        // These steps can't run at all against the installed registry — block.
        pushNotification({
          kind: 'error',
          message: `Recipe needs functions not installed here: ${pf.unknown_functions.join(', ')}`,
        });
        setRunning(null);
        return;
      }
      if (pf.unresolved.length > 0) {
        // Referenced keys no earlier step produces; they may already exist in the
        // data, so warn rather than block.
        const refs = pf.unresolved.map((u) => `${u.step} → ${u.ref}`).join(', ');
        pushNotification({
          kind: 'info',
          message: `Heads up: some steps reference keys no earlier step produces (${refs}). They must already exist in the data.`,
        });
      }
      await importRecipe(sessionId, { steps: recipe.steps }, mode);
      setSessionState(await getSession(sessionId));
      pushNotification({
        kind: 'info',
        message: mode === 'stage'
          ? `Staged ${recipe.steps.length} steps from "${recipe.name}" — review and run.`
          : `Running recipe: ${recipe.name}`,
      });
      onClose();
    } catch (err) {
      reportError('Recipe failed', err);
      setRunning(null);
    }
  }

  const q = search.toLowerCase();
  const filtered = recipes?.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q) ||
      r.steps.some((s) => `${s.namespace}.${s.function}`.toLowerCase().includes(q)),
  );

  return (
    <ModalOverlay onClose={onClose} widthClassName="w-[560px] max-h-[80vh]">
      <ModalHeader title="Analysis recipes" subtitle="Curated squidpy workflows — Run queues every step; Stage loads them as editable pending steps." onClose={onClose} />

      {recipes && recipes.length > 0 && (
        <div className="p-3 border-b border-border shrink-0">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search recipes..."
            className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm text-text placeholder-muted focus:outline-none focus:border-accent"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
        {error && <div className="text-xs text-danger px-1">{error}</div>}
        {!recipes && !error && <div className="text-xs text-muted px-1">Loading…</div>}
        {filtered && filtered.length === 0 && (
          <div className="px-4 py-8 text-sm text-muted text-center">No recipes match</div>
        )}
        {filtered?.map((r) => (
          <div key={r.name} className="border border-border rounded-md p-3 bg-bg">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-text font-medium">{r.name}</div>
                <p className="text-xs text-muted mt-0.5">{r.description}</p>
              </div>
              <div className="shrink-0 flex gap-1.5">
                <button
                  onClick={() => apply(r, 'stage')}
                  disabled={running !== null}
                  className="px-3 py-1.5 bg-bg border border-border hover:border-accent disabled:opacity-50 text-text rounded text-xs transition-colors"
                >
                  {running === r.name ? '…' : 'Stage'}
                </button>
                <button
                  onClick={() => apply(r, 'run')}
                  disabled={running !== null}
                  className="px-3 py-1.5 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white rounded text-xs transition-colors"
                >
                  {running === r.name ? 'Running…' : 'Run'}
                </button>
              </div>
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
    </ModalOverlay>
  );
}
