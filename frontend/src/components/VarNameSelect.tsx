import { useState, useEffect, useRef } from 'react';
import { useDataSource } from '../data/context';
import { reportError } from '../lib/errors';

interface Props {
  value: string;
  onChange: (gene: string) => void;
  placeholder?: string;
}

const INPUT_CLASS =
  'w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text placeholder:text-muted/40 focus:outline-none focus:border-accent';

// Searchable gene picker. var_names can number in the tens of thousands, so matches
// are resolved by the data source (debounced) rather than rendered up front — a
// backend query for a live session, an in-memory scan of `var/_index` for a checkpoint.
export default function VarNameSelect({ value, onChange, placeholder = 'Search genes…' }: Props) {
  const source = useDataSource();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || !source) return;
    const t = setTimeout(() => {
      source.searchVarNames(query)
        .then(setResults)
        .catch((e) => reportError('Gene search failed', e));
    }, 200);
    return () => clearTimeout(t);
  }, [open, query, source]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function choose(gene: string) {
    onChange(gene);
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        type="text"
        value={open ? query : value}
        placeholder={value || placeholder}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onChange={(e) => { setOpen(true); setQuery(e.target.value); }}
        className={INPUT_CLASS}
      />
      {open && results.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto bg-surface border border-border rounded shadow-lg">
          {results.map((g) => (
            <li key={g}>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); choose(g); }}
                className={`w-full text-left px-2 py-1 text-xs hover:bg-bg ${
                  g === value ? 'text-accent' : 'text-text'
                }`}
              >
                {g}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
