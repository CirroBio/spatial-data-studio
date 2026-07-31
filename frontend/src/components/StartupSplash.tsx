import CirroMark from './CirroMark';

// Shown until the backend finishes building its squidpy function registry
// (a multi-second cold import), so the initial "nothing to load yet" window
// doesn't look identical to a genuinely empty app.
export default function StartupSplash() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 bg-bg text-muted">
      <CirroMark spinning className="h-32 w-32" />
      <span className="text-sm">Starting backend…</span>
    </div>
  );
}
