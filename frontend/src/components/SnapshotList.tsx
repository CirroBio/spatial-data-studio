import { formatCreated, type Snapshot } from '../lib/snapshots';

interface Props {
  snapshots: Snapshot[];
  isSelected: (s: Snapshot) => boolean;
  onSelect: (s: Snapshot) => void;
  // Multi-select mode shows a checkbox per row (Cirro upload picker); single-select
  // mode just highlights the active row (Snapshot browser preview).
  multi?: boolean;
}

// The scrollable list of saved snapshots (row = label + kind + saved time), shared by
// the Snapshot browser and the Cirro upload picker so both read the same way.
export default function SnapshotList({ snapshots, isSelected, onSelect, multi }: Props) {
  return (
    <>
      {snapshots.map((s) => {
        const when = formatCreated(s.created);
        const label = s.label || s.name;
        const active = isSelected(s);
        return (
          <button
            key={s.url}
            onClick={() => onSelect(s)}
            title={s.name}
            className={`w-full text-left px-3 py-2 border-b border-border/50 transition-colors flex items-center gap-2 ${
              active ? 'bg-accent/20 text-accent' : 'text-text hover:bg-accent-lo/30'
            }`}
          >
            {multi && (
              <input type="checkbox" checked={active} readOnly tabIndex={-1} className="shrink-0 pointer-events-none" />
            )}
            <span className="flex flex-col min-w-0 flex-1">
              <span className="text-xs font-medium truncate">{label}</span>
              <span className="text-[10px] text-muted/70 mt-0.5">
                {s.kind}{when && ` · ${when}`}
              </span>
            </span>
          </button>
        );
      })}
    </>
  );
}
