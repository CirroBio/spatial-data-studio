import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { openCheckpointPath, type CheckpointIndex } from '../data/checkpointIndex';

// Header switcher for a serverless deployment — the checkpoint counterpart of
// SessionPicker. Deliberately separate: there is no lock, no memory footprint, no
// delete, and selecting one navigates rather than swapping in-place state.
export default function CheckpointPicker(
  { index, currentUrl }: { index: CheckpointIndex; currentUrl: string | null },
) {
  const active = index.entries.find((e) => e.url === currentUrl);
  const label = active?.label ?? (currentUrl ? decodeURIComponent(currentUrl.split('/').pop() ?? '') : 'Checkpoints');

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="flex items-center gap-1 max-w-[240px] px-2 py-1 rounded text-xs text-text/80 hover:bg-accent-lo/30 hover:text-text transition-colors"
          title="Switch checkpoint"
        >
          <span className="truncate">{label}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-50 min-w-[240px] max-w-[360px] max-h-[70vh] overflow-y-auto rounded-md border border-border bg-surface shadow-2xl py-1"
        >
          <div className="px-3 py-1 text-[10px] text-muted font-mono uppercase tracking-wide">
            {index.title ?? 'Checkpoints'} ({index.entries.length})
          </div>
          {index.entries.map((entry) => {
            const isActive = entry.url === currentUrl;
            return (
              <DropdownMenu.Item
                key={entry.path}
                onSelect={() => { if (!isActive) openCheckpointPath(entry.path); }}
                className={[
                  'flex items-center gap-2 px-3 py-1.5 text-xs outline-none cursor-pointer data-[highlighted]:bg-accent-lo/40',
                  isActive ? 'bg-accent-lo text-text' : 'text-text/80',
                ].join(' ')}
              >
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="truncate leading-tight">{entry.label}</span>
                  {entry.description && (
                    <span className="text-[9px] text-muted/60 truncate mt-0.5">{entry.description}</span>
                  )}
                </div>
                {isActive && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-accent shrink-0">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
