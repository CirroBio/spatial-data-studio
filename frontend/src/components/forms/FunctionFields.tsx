import type { UseFormRegister, FieldErrors, UseFormWatch, UseFormSetValue } from 'react-hook-form';
import type { SessionFields } from '@cirrobio/spatial-viewer';
import type { FunctionEntry } from '../../types';
import FsPicker from './FsPicker';

export interface JsonSchemaProperty {
  type?: string;
  enum?: string[];
  default?: unknown;
  description?: string;
  items?: { type?: string };
}

// obs_value_map state, owned by callers that render against a live session. The
// widget is an {old -> new} editor whose source column is another field; the
// caller watches that column, fetches its uniques, and threads them in here.
export interface ObsValueMapState {
  param: string;                       // the param key rendered as the map editor
  column: string | undefined;         // the source column, or undefined if unpicked
  uniques: { value: string; count: number }[];
  loading: boolean;
  values: Record<string, string>;
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
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
      return fields.obsm.map((f) => f.name);
    case 'obsp_key':
      return fields.obsp;
    default:
      return [];
  }
}

// Coerce raw form values back to typed params: parse json, split comma lists into
// arrays, Number() numerics, booleanize checkboxes, drop empties and excluded keys.
export function coerceParams(
  raw: Record<string, unknown>,
  fn: FunctionEntry,
  exclude?: Set<string>,
): Record<string, unknown> {
  const properties = (fn.json_schema as { properties?: Record<string, JsonSchemaProperty> }).properties ?? {};
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (exclude?.has(key)) continue;
    if (value === '' || value === null || value === undefined) continue;
    const widget = fn.ui_schema[key]?.widget;
    if (widget === 'json' && typeof value === 'string') {
      try {
        params[key] = JSON.parse(value);
      } catch {
        params[key] = value;
      }
    } else if ((widget === 'var_names' || widget === 'multitext') && typeof value === 'string') {
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
  return params;
}

interface Props {
  fn: FunctionEntry;
  fields: SessionFields;
  register: UseFormRegister<Record<string, unknown>>;
  errors: FieldErrors<Record<string, unknown>>;
  // Param keys to skip.
  exclude?: Set<string>;
  // Present only when the function has an obs_value_map param and a live session.
  obsValueMap?: ObsValueMapState;
  // Needed to render filesystem pickers for reader path params (path_kind): the
  // picker is a controlled widget, so it reads/writes its field via watch/setValue.
  watch?: UseFormWatch<Record<string, unknown>>;
  setValue?: UseFormSetValue<Record<string, unknown>>;
}

// The parameter fields for a function/recipe/reader, driven by its json_schema +
// ui_schema. Renders bare field elements (no <form>, no submit) so a caller can
// embed them in its own form — the picker/recipe gallery wrap them in FunctionForm,
// the New Session dialog embeds them alongside its file browser.
export default function FunctionFields({ fn, fields, register, errors, exclude, obsValueMap, watch, setValue }: Props) {
  const schema = fn.json_schema as {
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  const properties = schema.properties ?? {};
  const requiredKeys = new Set(schema.required ?? []);
  const uiSchema = fn.ui_schema;
  const paramKeys = Object.keys(properties).filter((k) => !exclude?.has(k));

  return (
    <>
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
          <label key={`label-${key}`} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5">
              <span className="text-xs font-mono text-text">{key}</span>
              {isRequired ? (
                <span className="text-[9px] font-sans uppercase tracking-wide text-danger border border-danger/40 rounded px-1 leading-tight">
                  required
                </span>
              ) : (
                <span className="text-[9px] font-sans uppercase tracking-wide text-muted/50 border border-border rounded px-1 leading-tight">
                  optional
                </span>
              )}
            </span>
            {tooltip && (
              <span className="text-[11px] text-muted/70 font-sans normal-case leading-snug">{tooltip}</span>
            )}
          </label>
        );
        const errLine = errors[key] && (
          <span className="text-[10px] text-danger">{String(errors[key]?.message ?? 'Required')}</span>
        );

        const inputClass = 'bg-bg border border-border rounded px-2 py-1.5 text-xs text-text focus:outline-none focus:border-accent w-full';

        // Reader path params render a filesystem picker (folder/file/either). A
        // relative-file param (bound_to set) roots its picker at the primary path's
        // current value and stores a relative name.
        const pathKind = uiSchema[key]?.path_kind;
        if (pathKind && watch && setValue) {
          const baseParam = uiSchema[key]?.bound_to || undefined;
          const rootDir = baseParam ? ((watch(baseParam) as string) || '') : undefined;
          const current = (watch(key) as string) || '';
          return (
            <div key={key} className="flex flex-col gap-1">
              {label}
              {/* Hidden input registers the field (the picker sets its value) so
                  required validation and getValues include it. */}
              <input type="hidden" {...reg(key)} />
              {baseParam && !rootDir ? (
                <p className="text-[11px] text-muted/60">
                  Choose <span className="font-mono">{baseParam}</span> first.
                </p>
              ) : (
                <FsPicker
                  mode={pathKind}
                  value={current}
                  rootDir={rootDir || undefined}
                  onSelect={(v) => setValue(key, v, { shouldValidate: true, shouldDirty: true })}
                />
              )}
              {current && (
                <span className="text-[11px] font-mono text-accent truncate" title={current}>{current}</span>
              )}
              {errLine}
            </div>
          );
        }

        if (widget === 'checkbox' || prop.type === 'boolean') {
          const defaultVal = typeof prop.default === 'boolean' ? prop.default : false;
          return (
            <div key={key} className="flex items-start gap-2">
              <input
                type="checkbox"
                defaultChecked={defaultVal}
                {...register(key)}
                className="accent-accent mt-0.5"
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
              <select
                defaultValue={typeof prop.default === 'string' ? prop.default : ''}
                {...reg(key)}
                className={inputClass}
              >
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
                step={prop.type === 'integer' ? 1 : 'any'}
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
          const column = obsValueMap?.column;
          const uniques = obsValueMap?.uniques ?? [];
          const values = obsValueMap?.values ?? {};
          return (
            <div key={key} className="flex flex-col gap-1">
              {label}
              {!column ? (
                <p className="text-[11px] text-muted/60">Select a column first.</p>
              ) : obsValueMap?.loading ? (
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
                        value={values[u.value] ?? ''}
                        onChange={(e) => obsValueMap?.setValues((m) => ({ ...m, [u.value]: e.target.value }))}
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
    </>
  );
}
