import { useEffect, useState } from 'react';
import ObsFieldSelect from '../ObsFieldSelect';
import VarNameSelect from '../VarNameSelect';
import type { ObsField } from '../../types';
import { parseColorBy, type ColorBySlot } from './colorBy';

interface Props {
  sessionId: string;
  value: string;          // color_by path
  obsFields: ObsField[];
  layers: string[];
  onChange: (path: string) => void;
}

const SELECT_CLASS =
  'w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:border-accent';

// Picks the cell value that colors the points: first a slot (obs / X / layer),
// then the column within it. The slot is tracked locally so a user can switch to
// X or a layer and search for a gene before the color_by path is committed.
export default function ColorBySelect({ sessionId, value, obsFields, layers, onChange }: Props) {
  const cur = parseColorBy(value);
  const [slot, setSlot] = useState<ColorBySlot>(cur.slot);
  const [layer, setLayer] = useState(cur.layer || layers[0] || '');

  useEffect(() => {
    setSlot(cur.slot);
    if (cur.slot === 'layers' && cur.layer) setLayer(cur.layer);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  function changeSlot(next: ColorBySlot) {
    setSlot(next);
    // obs has a ready set of columns, so commit immediately; X / layers wait for
    // a gene to be searched and picked before a valid path exists.
    if (next === 'obs' && obsFields[0]) onChange(`obs:${obsFields[0].name}`);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <select
        value={slot}
        onChange={(e) => changeSlot(e.target.value as ColorBySlot)}
        className={SELECT_CLASS}
        title="Value source"
      >
        <option value="obs">obs</option>
        <option value="X">X (gene expression)</option>
        {layers.length > 0 && <option value="layers">layer</option>}
      </select>

      {slot === 'obs' && (
        <ObsFieldSelect
          fields={obsFields}
          value={cur.slot === 'obs' ? cur.column : ''}
          onChange={(name) => onChange(`obs:${name}`)}
        />
      )}

      {slot === 'X' && (
        <VarNameSelect
          sessionId={sessionId}
          value={cur.slot === 'X' ? cur.gene : ''}
          onChange={(gene) => onChange(`X:${gene}`)}
        />
      )}

      {slot === 'layers' && (
        <>
          <select
            value={layer}
            onChange={(e) => {
              const next = e.target.value;
              setLayer(next);
              if (cur.slot === 'layers' && cur.gene) onChange(`layers:${next}/${cur.gene}`);
            }}
            className={SELECT_CLASS}
            title="Layer"
          >
            {layers.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          <VarNameSelect
            sessionId={sessionId}
            value={cur.slot === 'layers' ? cur.gene : ''}
            onChange={(gene) => onChange(`layers:${layer}/${gene}`)}
          />
        </>
      )}
    </div>
  );
}
