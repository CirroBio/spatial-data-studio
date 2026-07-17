import { useId } from 'react';
import type { ObsField } from '../types';

interface Props {
  fields: ObsField[];
  value: string;
  onChange: (name: string) => void;
  // When true, render a creatable combobox (type a new name or pick an existing
  // field) instead of a plain dropdown — used where a new obs column is allowed.
  creatable?: boolean;
  placeholder?: string;
  className?: string;
}

const INPUT_CLASS =
  'w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:border-accent';

export default function ObsFieldSelect({
  fields,
  value,
  onChange,
  creatable = false,
  placeholder = 'Select column...',
  className,
}: Props) {
  const listId = useId();
  const cls = className ?? INPUT_CLASS;

  if (creatable) {
    return (
      <>
        <input
          type="text"
          list={listId}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${cls} placeholder:text-muted/40`}
        />
        <datalist id={listId}>
          {fields.map((f) => (
            <option key={f.name} value={f.name} />
          ))}
        </datalist>
      </>
    );
  }

  const known = fields.some((f) => f.name === value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={cls}>
      {!known && <option value="">{placeholder}</option>}
      {fields.map((f) => (
        <option key={f.name} value={f.name}>{f.name}</option>
      ))}
    </select>
  );
}
