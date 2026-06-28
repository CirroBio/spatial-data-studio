import { useForm } from 'react-hook-form';
import type { FunctionEntry } from '../../types';
import type { SessionFields } from '../../types';

interface Props {
  fn: FunctionEntry;
  fields: SessionFields;
  onSubmit: (params: Record<string, unknown>) => void;
  submitting?: boolean;
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

export default function FunctionForm({ fn, fields, onSubmit, submitting }: Props) {
  const { register, handleSubmit } = useForm<Record<string, unknown>>();

  const properties = (fn.json_schema as { properties?: Record<string, JsonSchemaProperty> }).properties ?? {};
  const uiSchema = fn.ui_schema;

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
    onSubmit(params);
  }

  const paramKeys = Object.keys(properties);

  if (paramKeys.length === 0) {
    return (
      <form onSubmit={handleSubmit(processSubmit)} className="flex flex-col gap-3">
        <p className="text-sm text-muted">No parameters required.</p>
        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white rounded text-sm transition-colors"
        >
          {submitting ? 'Running...' : 'Run'}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit(processSubmit)} className="flex flex-col gap-3">
      {paramKeys.map((key) => {
        const prop = properties[key];
        const widget = uiSchema[key]?.widget;
        const tooltip = uiSchema[key]?.tooltip || prop.description;
        const label = (
          <label key={`label-${key}`} className="text-xs font-mono text-muted">
            {key}
            {tooltip && (
              <span className="ml-1 text-muted/60 font-sans normal-case">{tooltip}</span>
            )}
          </label>
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
                  {...register(key)}
                  className={inputClass}
                />
              ) : (
                <select {...register(key)} className={inputClass}>
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
            </div>
          );
        }

        if (widget === 'select' || prop.enum) {
          return (
            <div key={key} className="flex flex-col gap-1">
              {label}
              <select {...register(key)} className={inputClass}>
                <option value="">-- select --</option>
                {(prop.enum ?? []).map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
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
                {...register(key)}
                className={inputClass}
              />
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
                {...register(key)}
                className={inputClass}
              />
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
                {...register(key)}
                className={`${inputClass} font-mono resize-y`}
              />
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
              {...register(key)}
              className={inputClass}
            />
          </div>
        );
      })}

      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white rounded text-sm transition-colors mt-1"
      >
        {submitting ? 'Running...' : 'Run'}
      </button>
    </form>
  );
}
