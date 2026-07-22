import { useAppStore } from '../store/sessionStore';

export default function ResourceStrip() {
  const { resourceSample, activeSessionId } = useAppStore();

  const global = resourceSample?.global;
  const sessionRss = activeSessionId && resourceSample?.per_session
    ? (resourceSample.per_session[activeSessionId] ?? 0)
    : 0;

  return (
    <div className="h-9 flex items-center gap-5 px-4 bg-surface border-t border-border text-xs text-muted shrink-0 font-mono">
      {global ? (
        <>
          <div className="flex items-center gap-2">
            <span>RAM</span>
            <div className="w-20 h-1.5 bg-bg rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all duration-500"
                style={{ width: `${Math.min(global.rss_pct, 100)}%` }}
              />
            </div>
            <span>{global.rss_pct.toFixed(0)}%</span>
          </div>
          <span className="text-border">|</span>
          <span>{global.rss_mb.toFixed(0)} MB global</span>
          {sessionRss > 0 && (
            <>
              <span className="text-border">|</span>
              <span>{sessionRss.toFixed(0)} MB session</span>
            </>
          )}
          {global.work_dir_mb > 0 ? (
            <>
              <span className="text-border">|</span>
              <span>{global.work_dir_mb.toFixed(0)} MB working set (RAM)</span>
            </>
          ) : global.rasters_mb > 0 && (
            <>
              <span className="text-border">|</span>
              <span>{global.rasters_mb.toFixed(0)} MB rasters (disk)</span>
            </>
          )}
          <span className="text-border">|</span>
          <span>CPU {global.cpu_pct.toFixed(0)}%</span>
        </>
      ) : (
        <span className="text-muted/50">waiting for resource data...</span>
      )}
    </div>
  );
}
