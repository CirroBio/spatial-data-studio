import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { getBundledRecipes, importRecipe, getSession, preflightRecipe, type BundledRecipe } from '../api';
import type { FunctionEntry } from '../types';
import { formatError, reportError } from '../lib/errors';
import { ModalOverlay, ModalHeader } from './DetailModal';
import FunctionForm from './forms/FunctionForm';
import { EMPTY_FIELDS } from '../hooks/useRerunEditor';

interface Props {
  sessionId: string;
  onClose: () => void;
}

// A recipe's declared params render through the same FunctionForm the picker
// uses; it only reads json_schema/ui_schema, so a minimal FunctionEntry suffices.
function recipeAsFn(recipe: BundledRecipe): FunctionEntry {
  return {
    key: `recipe.${recipe.name}`,
    namespace: 'recipe',
    function: recipe.name,
    effect_class: 'compute',
    summary: recipe.description,
    doc: '',
    label: recipe.name,
    source: 'recipe',
    citation: '',
    documentation: '',
    json_schema: recipe.json_schema,
    ui_schema: recipe.ui_schema,
    partially_supported: false,
  };
}

export default function RecipeGallery({ sessionId, onClose }: Props) {
  const { setSessionState, pushNotification, sessionState } = useAppStore();
  const [recipes, setRecipes] = useState<BundledRecipe[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // When set, this recipe's parameter form is open, awaiting a Run/Stage choice.
  const [configuring, setConfiguring] = useState<BundledRecipe | null>(null);

  useEffect(() => {
    getBundledRecipes()
      .then(({ recipes: r }) => setRecipes(r))
      .catch((err) => setError(formatError(err)));
  }, []);

  async function apply(recipe: BundledRecipe, mode: 'run' | 'stage', paramValues: Record<string, unknown>) {
    setRunning(recipe.name);
    try {
      const pf = await preflightRecipe(sessionId, {
        steps: recipe.steps, params: recipe.params, param_values: paramValues,
      });
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
      await importRecipe(
        sessionId,
        { steps: recipe.steps, params: recipe.params, param_values: paramValues },
        mode,
      );
      // Staging emits no SSE event, so refetch to show the new pending rows. Run
      // mode enqueues jobs whose job.queued events insert the rows live, and a
      // refetch here would block on the session read lock until the first step
      // finishes.
      if (mode === 'stage') setSessionState(await getSession(sessionId));
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

  if (configuring) {
    const recipe = configuring;
    return (
      <ModalOverlay onClose={onClose} widthClassName="w-[460px] max-h-[80vh]">
        <ModalHeader
          title={recipe.name}
          subtitle="Set parameters, then run the recipe now or stage it as editable pending steps."
          onClose={onClose}
        />
        <button
          onClick={() => setConfiguring(null)}
          className="text-xs text-muted hover:text-text px-4 pt-3 pb-2 self-start"
        >
          ← Back to recipes
        </button>
        <FunctionForm
          fn={recipeAsFn(recipe)}
          fields={sessionState?.fields ?? EMPTY_FIELDS}
          sessionId={sessionId}
          onSubmit={(params, action) => apply(recipe, action === 'stage' ? 'stage' : 'run', params)}
          submitting={running !== null}
          submitActions={[
            { key: 'run', label: 'Run', variant: 'primary' },
            { key: 'stage', label: 'Stage', variant: 'secondary' },
          ]}
        />
      </ModalOverlay>
    );
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
      <ModalHeader title="Analysis recipes" subtitle="Curated analysis workflows — select one to set its parameters, then run or stage it." onClose={onClose} />

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
                  onClick={() => setConfiguring(r)}
                  disabled={running !== null}
                  className="px-3 py-1.5 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white rounded text-xs transition-colors"
                >
                  Select
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
