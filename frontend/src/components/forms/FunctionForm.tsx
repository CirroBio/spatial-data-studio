import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { FunctionEntry, SessionFields } from '../../types';
import { getObsValues } from '../../api';
import FunctionFields, { coerceParams } from './FunctionFields';

interface SubmitAction {
  key: string;
  label: string;
  variant?: 'primary' | 'secondary';
}

interface Props {
  fn: FunctionEntry;
  fields: SessionFields;
  sessionId: string;
  // The clicked action's key is passed when `submitActions` is used.
  onSubmit: (params: Record<string, unknown>, actionKey?: string) => void;
  submitting?: boolean;
  // Pre-fill the form (e.g. editing a prior call's params before re-running).
  initialValues?: Record<string, unknown>;
  submitLabel?: string;
  // Render one button per action instead of the single submit button.
  submitActions?: SubmitAction[];
  // Why submitting is unavailable, when it is (the session's edit lock is held by
  // someone else, or it's a read-only snapshot). Disables the button(s) and explains
  // it on hover; the fields stay usable so the form can still be read.
  blockedReason?: string | null;
}

// Inverse of processSubmit: turn stored params back into the form's field shapes
// (array params render as comma-joined text; json params as a JSON string).
function paramsToFormValues(fn: FunctionEntry, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    const widget = fn.ui_schema[k]?.widget;
    if ((widget === 'var_names' || widget === 'multitext') && Array.isArray(v)) {
      out[k] = (v as unknown[]).join(', ');
    } else if (widget === 'json' && typeof v !== 'string') {
      out[k] = JSON.stringify(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export default function FunctionForm({ fn, fields, sessionId, onSubmit, submitting, initialValues, submitLabel, submitActions, blockedReason }: Props) {
  // Which action button was clicked; read at submit time to route the params.
  const [pendingAction, setPendingAction] = useState<string | undefined>(undefined);
  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<Record<string, unknown>>({
    defaultValues: initialValues ? paramsToFormValues(fn, initialValues) : undefined,
  });

  const schema = fn.json_schema as { properties?: Record<string, unknown> };
  const properties = schema.properties ?? {};
  const uiSchema = fn.ui_schema;

  // obs_value_map widget: a {old -> new} editor whose source column is another
  // field (named by the param's bound_to). Watch that field and fetch its uniques.
  const mapParam = Object.keys(properties).find((k) => uiSchema[k]?.widget === 'obs_value_map');
  const mapColumnField = mapParam ? uiSchema[mapParam]?.bound_to ?? undefined : undefined;
  const mapColumn = mapColumnField ? (watch(mapColumnField) as string | undefined) : undefined;
  const [uniques, setUniques] = useState<{ value: string; count: number }[]>([]);
  const [loadingUniques, setLoadingUniques] = useState(false);
  const [valueMap, setValueMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!mapParam || !mapColumn) {
      setUniques([]);
      setValueMap({});
      return;
    }
    let cancelled = false;
    setLoadingUniques(true);
    setValueMap({});
    getObsValues(sessionId, mapColumn)
      .then((r) => { if (!cancelled) setUniques(r.values); })
      .catch(() => { if (!cancelled) setUniques([]); })
      .finally(() => { if (!cancelled) setLoadingUniques(false); });
    return () => { cancelled = true; };
  }, [mapParam, mapColumn, sessionId]);

  function processSubmit(raw: Record<string, unknown>) {
    const params = coerceParams(raw, fn);
    if (mapParam) {
      const cleaned: Record<string, string> = {};
      for (const [old, next] of Object.entries(valueMap)) {
        if (next && next.trim() && next.trim() !== old) cleaned[old] = next.trim();
      }
      params[mapParam] = cleaned;
    }
    onSubmit(params, pendingAction);
  }

  const paramKeys = Object.keys(properties);

  const runButton = (
    <div className="shrink-0 border-t border-border px-4 py-3">
      {submitActions ? (
        <div className="flex gap-1.5">
          {submitActions.map((a) => (
            <button
              key={a.key}
              type="submit"
              onClick={() => setPendingAction(a.key)}
              disabled={submitting || !!blockedReason}
              title={blockedReason ?? undefined}
              className={
                a.variant === 'secondary'
                  ? 'flex-1 px-4 py-2 bg-bg border border-border hover:border-accent disabled:opacity-50 text-text rounded text-sm transition-colors'
                  : 'flex-1 px-4 py-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-on-accent rounded text-sm transition-colors'
              }
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : (
        <button
          type="submit"
          disabled={submitting || !!blockedReason}
          title={blockedReason ?? undefined}
          className="w-full px-4 py-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-on-accent rounded text-sm transition-colors"
        >
          {submitting ? 'Running...' : submitLabel ?? 'Run'}
        </button>
      )}
    </div>
  );

  if (paramKeys.length === 0) {
    return (
      <form onSubmit={handleSubmit(processSubmit)} className="flex flex-col flex-1 min-h-0">
        <p className="flex-1 overflow-y-auto px-4 pb-4 text-sm text-muted">No parameters required.</p>
        {runButton}
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit(processSubmit)} className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto px-4 pb-4 flex flex-col gap-3">
        <FunctionFields
          fn={fn}
          fields={fields}
          register={register}
          errors={errors}
          watch={watch}
          setValue={setValue}
          obsValueMap={mapParam ? {
            param: mapParam,
            column: mapColumn,
            uniques,
            loading: loadingUniques,
            values: valueMap,
            setValues: setValueMap,
          } : undefined}
        />
      </div>
      {runButton}
    </form>
  );
}
