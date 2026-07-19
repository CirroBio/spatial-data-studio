// Shown until the backend finishes building its squidpy function registry
// (a multi-second cold import), so the initial "nothing to load yet" window
// doesn't look identical to a genuinely empty app.
export default function StartupSplash() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 bg-bg text-muted">
      <div className="w-8 h-8 rounded-full border-2 border-border border-t-accent animate-spin" />
      <span className="text-sm">Starting backend…</span>
    </div>
  );
}
