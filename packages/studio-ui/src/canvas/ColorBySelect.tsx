import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { colorByLabel, parseColorBy, reportError, useDataSource, type ObsField } from '@cirrobio/spatial-viewer';
import { keepEscapeInField } from '../keepEscapeInField';
import { useClickOutside } from '../useClickOutside';

interface Props {
  value: string;          // color_by path
  obsFields: ObsField[];
  layers: string[];
  hasX: boolean;          // false for a checkpoint saved without its expression matrix
  onChange: (path: string) => void;
}

interface Choice {
  path: string;
  label: string;
}

const GENE_SEARCH_DEBOUNCE_MS = 200;

const INPUT_CLASS =
  'w-full bg-bg border border-border rounded pl-2 pr-7 py-1 text-xs text-text placeholder:text-muted/40 focus:outline-none focus:border-accent';
const SELECT_CLASS =
  'flex-1 min-w-0 bg-bg border border-border rounded px-1 py-0.5 text-xs text-text focus:outline-none focus:border-accent';
const HEADING_CLASS = 'px-2 pt-1.5 pb-0.5 text-[10px] text-muted font-mono uppercase tracking-wide';
const NOTE_CLASS = 'px-2 py-1 text-xs text-muted';

// A gene's path for the matrix it is read from: '' is X, anything else names a layer.
function genePath(layer: string, gene: string): string {
  return layer ? `layers:${layer}/${gene}` : `X:${gene}`;
}

// Picks what colors the cells from one searchable list: the table's annotations (its obs
// columns), then the genes matching what is typed. var_names can number in the tens of
// thousands, so genes are matched by the data source (debounced) and only once something
// is typed — a backend query for a live session, a scan of `var/_index` for a checkpoint.
export default function ColorBySelect({ value, obsFields, layers, hasX, onChange }: Props) {
  const id = useId();
  const listId = `${id}-list`;
  const source = useDataSource();
  const [open, setOpen] = useState(false);
  // While focused the box holds only what is typed, with the current color as its
  // placeholder, so typing after a pick starts a new search instead of appending to it.
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  // The matches for one query; names is null when that search failed.
  const [geneHits, setGeneHits] = useState<{ query: string; names: string[] | null }>({ query: '', names: [] });
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const cur = parseColorBy(value);
  // The matrices a gene can be read from. A table saved without X still has genes when it
  // has layers; with no data source to search (a host drawing this outside one) there are
  // no genes to offer at all.
  const geneSources = !source ? [] : hasX ? ['', ...layers] : layers;
  const [pickedSource, setPickedSource] = useState(cur.slot === 'layers' ? cur.layer : '');
  // The current gene's own matrix, else the one last picked, else the first there is.
  const wanted = cur.slot === 'X' ? '' : cur.slot === 'layers' ? cur.layer : pickedSource;
  const geneSource = geneSources.includes(wanted) ? wanted : (geneSources[0] ?? '');

  const needle = query.trim();
  const searching = open && geneSources.length > 0 && needle !== '';

  useClickOutside(wrapRef, () => setOpen(false), open);

  useEffect(() => {
    if (!searching || !source) return;
    // A slower, older search must not overwrite the matches for what is typed now.
    let current = true;
    const t = setTimeout(() => {
      source.searchVarNames(needle)
        .then((names) => { if (current) setGeneHits({ query: needle, names }); })
        .catch((e) => {
          if (current) setGeneHits({ query: needle, names: null });
          reportError('Gene search failed', e);
        });
    }, GENE_SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [searching, needle, source]);

  // Categorical columns first: groups are what a section is usually colored by.
  const annotationChoices = useMemo<Choice[]>(() => {
    const q = needle.toLowerCase();
    const matching = obsFields.filter((f) => f.name.toLowerCase().includes(q));
    return [
      ...matching.filter((f) => f.kind === 'categorical'),
      ...matching.filter((f) => f.kind !== 'categorical'),
    ].map((f) => ({ path: `obs:${f.name}`, label: f.name }));
  }, [obsFields, needle]);

  const genesReady = searching && geneHits.query === needle;
  const geneChoices: Choice[] = genesReady && geneHits.names
    ? geneHits.names.map((g) => ({ path: genePath(geneSource, g), label: g }))
    : [];
  const choices = [...annotationChoices, ...geneChoices];
  const geneNote = !needle ? 'Type a gene name to search'
    : !genesReady ? 'Searching…'
    : geneHits.names === null ? 'Gene search failed'
    : geneHits.names.length === 0 ? 'No matching genes'
    : null;

  const optionId = (i: number) => `${id}-option-${i}`;
  const activeId = choices[active] ? optionId(active) : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  function openList() {
    setOpen(true);
    setQuery('');
    setActive(-1);
  }

  function choose(choice: Choice) {
    onChange(choice.path);
    // Keep the gene matrix as it is when the color moves from a gene to an annotation.
    setPickedSource(geneSource);
    setOpen(false);
    setQuery('');
  }

  function changeSource(next: string) {
    setPickedSource(next);
    // Colored by a gene: show the same gene from the newly picked matrix.
    if (cur.slot !== 'obs' && cur.gene) onChange(genePath(next, cur.gene));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const n = choices.length;
      if (n === 0) return;
      const down = e.key === 'ArrowDown';
      setActive(choices[active] ? (active + (down ? 1 : -1) + n) % n : down ? 0 : n - 1);
    } else if (e.key === 'Enter') {
      if (open && choices[active]) {
        e.preventDefault();
        choose(choices[active]);
      }
    } else if (e.key === 'Escape') {
      // The wrapper's keepEscapeInField keeps this Escape from reaching the page.
      setOpen(false);
      setQuery('');
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  const option = (c: Choice, i: number) => (
    <li
      key={optionId(i)}
      id={optionId(i)}
      role="option"
      aria-selected={i === active}
      onMouseDown={() => choose(c)}
      className={`px-2 py-1 text-xs cursor-pointer hover:bg-bg ${i === active ? 'bg-bg' : ''} ${
        c.path === value ? 'text-accent' : 'text-text'
      }`}
    >
      {c.label}
    </li>
  );

  const label = colorByLabel(value);
  const prompt = geneSources.length > 0 ? 'Search annotations and genes…' : 'Search annotations…';

  return (
    <div className="flex flex-col gap-1.5" onKeyDown={keepEscapeInField}>
      <div ref={wrapRef} className="relative">
        <input
          type="text"
          role="combobox"
          aria-label="Color by"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          autoComplete="off"
          value={open || focused ? query : label}
          placeholder={label || prompt}
          onFocus={() => { setFocused(true); openList(); }}
          onBlur={() => setFocused(false)}
          onClick={() => { if (!open) openList(); }}
          onChange={(e) => {
            setOpen(true);
            setQuery(e.target.value);
            setActive(e.target.value.trim() ? 0 : -1);
          }}
          onKeyDown={onKeyDown}
          className={INPUT_CLASS}
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
        {open && (
          <div
            id={listId}
            role="listbox"
            aria-label="Color by"
            // Focus stays in the box through a click anywhere in the list, its scrollbar
            // included, so the keys keep working there.
            onMouseDown={(e) => e.preventDefault()}
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto bg-surface border border-border rounded shadow-lg"
          >
            <ul role="group" aria-labelledby={`${id}-annotations`}>
              <li role="presentation" id={`${id}-annotations`} className={HEADING_CLASS}>Annotations</li>
              {annotationChoices.map((c, i) => option(c, i))}
              {annotationChoices.length === 0 && (
                <li role="presentation" className={NOTE_CLASS}>{needle ? 'No matching annotations' : 'None in this table'}</li>
              )}
            </ul>
            {geneSources.length > 0 && (
              <ul role="group" aria-labelledby={`${id}-genes`}>
                <li role="presentation" id={`${id}-genes`} className={HEADING_CLASS}>Genes</li>
                {geneChoices.map((c, i) => option(c, annotationChoices.length + i))}
                {geneNote && <li role="presentation" className={NOTE_CLASS}>{geneNote}</li>}
              </ul>
            )}
          </div>
        )}
      </div>

      {layers.length > 0 && geneSources.length > 0 && (
        <div className="flex items-center gap-1.5">
          <label htmlFor={`${id}-values`} className="shrink-0 text-[10px] text-muted">Gene values</label>
          <select
            id={`${id}-values`}
            value={geneSource}
            onChange={(e) => changeSource(e.target.value)}
            className={SELECT_CLASS}
            title="Which of the table's matrices a gene's values are read from"
          >
            {hasX && <option value="">Expression matrix</option>}
            {layers.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
