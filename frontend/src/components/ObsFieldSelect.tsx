import { useState, useEffect, useMemo, useRef } from 'react';
import type { ObsField } from '../types';

interface Props {
  fields: ObsField[];
  value: string;
  onChange: (name: string) => void;
  // When true, render a creatable combobox (type a new name or pick an existing
  // field) instead of a select-only one — used where a new obs column is allowed.
  creatable?: boolean;
  placeholder?: string;
  className?: string;
}

const INPUT_CLASS =
  'w-full bg-bg border border-border rounded pl-2 pr-7 py-1 text-xs text-text placeholder:text-muted/40 focus:outline-none focus:border-accent';

// Themed combobox for obs columns, matching VarNameSelect so the two pickers that
// sit side by side under "Color by" share one visual language (native <select>
// hands the open menu to the OS, which ignores the app theme).
export default function ObsFieldSelect({
  fields,
  value,
  onChange,
  creatable = false,
  placeholder = 'Select column…',
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fields;
    return fields.filter((f) => f.name.toLowerCase().includes(q));
  }, [fields, query]);

  function choose(name: string) {
    onChange(name);
    setOpen(false);
    setQuery('');
  }

  // creatable: the typed text IS the value (a new obs column name), committed on
  // each keystroke. select-only: typing filters; the value changes on selection.
  function onInput(text: string) {
    setQuery(text);
    setOpen(true);
    if (creatable) onChange(text);
  }

  const trimmed = query.trim();
  const showCreate = creatable && trimmed !== '' && !fields.some((f) => f.name === trimmed);
  const cls = className ?? INPUT_CLASS;

  return (
    <div ref={wrapRef} className="relative">
      <input
        type="text"
        value={open ? query : value}
        placeholder={value || placeholder}
        onFocus={() => { setOpen(true); setQuery(creatable ? value : ''); }}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          else if (e.key === 'Enter' && !creatable && filtered[0]) {
            e.preventDefault();
            choose(filtered[0].name);
          }
        }}
        className={cls}
      />
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
      {open && (filtered.length > 0 || showCreate) && (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto bg-surface border border-border rounded shadow-lg">
          {filtered.map((f) => (
            <li key={f.name}>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); choose(f.name); }}
                className={`w-full text-left px-2 py-1 text-xs hover:bg-bg ${
                  f.name === value ? 'text-accent' : 'text-text'
                }`}
              >
                {f.name}
              </button>
            </li>
          ))}
          {showCreate && (
            <li>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); choose(trimmed); }}
                className="w-full text-left px-2 py-1 text-xs italic text-muted hover:bg-bg"
              >
                Create “{trimmed}”
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
