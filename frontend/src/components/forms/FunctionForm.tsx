import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { FunctionEntry, SessionFields } from '../../types';
import { getObsValues } from '../../api';

interface Props {
  fn: FunctionEntry;
  fields: SessionFields;
  sessionId: string;
  onSubmit: (params: Record<string, unknown>) => void;
  submitting?: boolean;
  // Pre-fill the form (e.g. editing a prior call's params before re-running).
  initialValues?: Record<string, unknown>;
  submitLabel?: string;
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

function getFieldOptions(widget: string, fields: SessionFields): string[] {
  switch (widget) {
    case 'obs_categorical':
      return fields.obs.filter((f) => f.kind === 'categorical').map((f) => f.name);
    case 'obs_key':
      return fields.obs.map((f) => f.name);
    case 'layer_key':
      return fields.layers;
    case 'obsm_key':
      return fields.obsm;
    case 'obsp_key':
      return fields.obsp;
    default:
      return [];
  }
}

interface JsonSchemaProperty {
  type?: string;
  enum?: string[];
  default?: unknown;
  description?: string;
  items?: { type?: string };
}

export default function FunctionForm({ fn, fields, sessionId, onSubmit, submitting, initialValues, submitLabel }: Props) {
  const { register, handleSubmit, watch, formState: { errors } } = useForm<Record<string, unknown>>({
    defaultValues: initialValues ? paramsToFormValues(fn, initialValues) : undefined,
  });

  const schema = fn.json_schema as {
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  const properties = schema.properties ?? {};
  const requiredKeys = new Set(schema.required ?? []);
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
    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === '' || value === null || value === undefined) continue;
      const widget = uiSchema[key]?.widget;
      if (widget === 'json' && typeof value === 'string') {
        try {
          params[key] = JSON.parse(value);
        } catch {
          params[key] = value;
        }
      } else if (widget === 'var_names' && typeof value === 'string') {
        const arr = value.split(',').map((s) => s.trim()).filter(Boolean);
        if (arr.length > 0) params[key] = arr;
      } else if (widget === 'multitext' && typeof value === 'string') {
        const arr = value.split(',').map((s) => s.trim()).filter(Boolean);
        if (arr.length > 0) params[key] = arr;
      } else if (widget === 'number' || properties[key]?.type === 'integer' || properties[key]?.type === 'number') {
        const n = Number(value);
        if (!isNaN(n)) params[key] = n;
      } else if (widget === 'checkbox' || properties[key]?.type === 'boolean') {
        params[key] = value === true || value === 'true' || value === '1';
      } else {
        params[key] = value;
      }
    }
    if (mapParam) {
      const cleaned: Record<string, string> = {};
      for (const [old, next] of Object.entries(valueMap)) {
        if (next && next.trim() && next.trim() !== old) cleaned[old] = next.trim();
      }
      params[mapParam] = cleaned;
    }
    onSubmit(params);
  }

  const paramKeys = Object.keys(properties);

  const runButton = (
    <div className="shrink-0 border-t border-border px-4 py-3">
      <button
        type="submit"
        disabled={submitting}
        className="w-full px-4 py-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white rounded text-sm transition-colors"
      >
        {submitting ? 'Running...' : submitLabel ?? 'Run'}
      </button>
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
      {paramKeys.map((key) => {
        const prop = properties[key];
        const widget = uiSchema[key]?.widget;
        const tooltip = uiSchema[key]?.tooltip || prop.description;
        const isRequired = requiredKeys.has(key);
        // Booleans always carry a value (checked/unchecked), so a "required" rule is
        // meaningless for them; only validate fields the user can leave blank.
        const isBool = widget === 'checkbox' || prop.type === 'boolean';
        const reg = (k: string) =>
          register(k, isRequired && !isBool ? { required: 'This parameter is required' } : {});
        const label = (
          <label key={`label-${key}`} className="text-xs font-mono text-muted">
            {key}
            {isRequired && <span className="ml-0.5 text-danger">*</span>}
            {tooltip && (
              <span className="ml-1 text-muted/60 font-sans normal-case">{tooltip}</span>
            )}
          </label>
        );
        const errLine = errors[key] && (
          <span className="text-[10px] text-danger">{String(errors[key]?.message ?? 'Required')}</span>
        );

        const inputClass = 'bg-bg border border-border rounded px-2 py-1.5 text-xs text-text focus:outline-none focus:border-accent w-full';

        if (widget === 'checkbox' || prop.type === 'boolean') {
          const defaultVal = typeof prop.default === 'boolean' ? prop.default : false;
          return (
            <div key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                defaultChecked={defaultVal}
                {...register(key)}
                className="accent-accent"
              />
              {label}
            </div>
          );
        }

        if (
          widget === 'obs_categorical' ||
          widget === 'obs_key' ||
          widget === 'layer_key' ||
          widget === 'obsm_key' ||
          widget === 'obsp_key'
        ) {
          const options = getFieldOptions(widget, fields);
          return (
            <div key={key} className="flex flex-col gap-1">
              {label}
              {widget === 'obs_key' ? (
                // Allow free text for gene names (X:<gene>)
                <input
                  type="text"
                  list={`${key}-options`}
                  placeholder={options[0] ?? 'obs field or X:gene'}
                  {...reg(key)}
                  className={inputClass}
                />
              ) : (
                <select
                  {...reg(key)}
                  defaultValue={typeof prop.default === 'string' && options.includes(prop.default) ? prop.default : ''}
                  className={inputClass}
                >
                  <option value="">-- select --</option>
                  {options.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              )}
              {widget === 'obs_key' && (
                <datalist id={`${key}-options`}>
                  {options.map((opt) => <option key={opt} value={opt} />)}
                </datalist>
              )}
              {errLine}
            </div>
          );
        }

        if (widget === 'select' || prop.enum) {
          return (
            <div key={key} className="flex flex-col gap-1">
              {label}
              <select {...reg(key)} className={inputClass}>
                <option value="">-- select --</option>
                {(prop.enum ?? []).map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
              {errLine}
            </div>
          );
        }

        if (widget === 'number' || prop.type === 'integer' || prop.type === 'number') {
          return (
            <div key={key} className="flex flex-col gap-1">
              {label}
              <input
                type="number"
                defaultValue={prop.default as number | undefined}
                {...reg(key)}
                className={inputClass}
              />
              {errLine}
            </div>
          );
        }

        if (widget === 'var_names' || widget === 'multitext') {
          return (
            <div key={key} className="flex flex-col gap-1">
              {label}
              <input
                type="text"
                placeholder="comma-separated values"
                {...reg(key)}
                className={inputClass}
              />
              {errLine}
            </div>
          );
        }

        if (widget === 'obs_value_map') {
          return (
            <div key={key} className="flex flex-col gap-1">
              {label}
              {!mapColumn ? (
                <p className="text-[11px] text-muted/60">Select a column first.</p>
              ) : loadingUniques ? (
                <p className="text-[11px] text-muted/60">Loading values…</p>
              ) : uniques.length === 0 ? (
                <p className="text-[11px] text-muted/60">No values in this column.</p>
              ) : (
                <div className="flex flex-col gap-1 max-h-72 overflow-y-auto border border-border/50 rounded p-2">
                  {uniques.map((u) => (
                    <div key={u.value} className="flex items-center gap-2">
                      <span className="text-[11px] font-mono text-muted truncate w-1/2" title={u.value}>
                        {u.value} <span className="text-muted/40">({u.count})</span>
                      </span>
                      <input
                        type="text"
                        placeholder={u.value}
                        value={valueMap[u.value] ?? ''}
                        onChange={(e) => setValueMap((m) => ({ ...m, [u.value]: e.target.value }))}
                        className={`${inputClass} w-1/2`}
                      />
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[10px] text-muted/50">Leave blank to keep a value unchanged.</p>
            </div>
          );
        }

        if (widget === 'json') {
          return (
            <div key={key} className="flex flex-col gap-1">
              {label}
              <textarea
                rows={3}
                placeholder="{}"
                {...reg(key)}
                className={`${inputClass} font-mono resize-y`}
              />
              {errLine}
            </div>
          );
        }

        // Default: text
        return (
          <div key={key} className="flex flex-col gap-1">
            {label}
            <input
              type="text"
              defaultValue={prop.default as string | undefined}
              {...reg(key)}
              className={inputClass}
            />
            {errLine}
          </div>
        );
      })}
      </div>
      {runButton}
    </form>
  );
}
