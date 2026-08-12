import CirroMark from './CirroMark';
import { openCheckpointPath, type CheckpointIndex } from '../data/checkpointIndex';

// Landing page for a serverless deployment: the collection listed by `index.json`,
// shown when the page is opened without `?checkpoint=`. Picking one navigates to it
// (see openCheckpointPath).
export default function CheckpointIndexPage({ index }: { index: CheckpointIndex }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-12 flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-2">
            <CirroMark className="h-5 w-auto shrink-0" />
            <span className="text-accent tracking-wide text-sm">Spatial Data Studio</span>
          </span>
          <h1 className="text-lg text-text">{index.title ?? 'Saved checkpoints'}</h1>
          <p className="text-xs text-muted leading-relaxed">
            {index.entries.length} dataset{index.entries.length === 1 ? '' : 's'} you can open and
            explore in the browser. Nothing is downloaded up front — each view fetches only the
            part of the file it needs.
          </p>
        </div>

        <ul className="flex flex-col gap-2">
          {index.entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => openCheckpointPath(entry.path)}
                className="w-full text-left px-4 py-3 rounded-md border border-border bg-surface hover:border-accent hover:bg-accent-lo/20 transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm text-text truncate">{entry.label}</span>
                    {entry.description && (
                      <span className="text-xs text-muted mt-0.5">{entry.description}</span>
                    )}
                    <span className="text-[10px] text-muted/60 font-mono truncate mt-1">{entry.path}</span>
                  </div>
                  <svg
                    width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    className="text-muted group-hover:text-accent shrink-0"
                  >
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
