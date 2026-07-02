export type Status = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'drawn' | 'invalidated' | 'loading' | 'ready' | 'errored';

interface Props {
  status: Status;
  size?: 'sm' | 'xs';
}

const STATUS_STYLES: Record<Status, string> = {
  queued: 'bg-muted/30 text-muted',
  running: 'bg-accent/20 text-accent animate-pulse',
  completed: 'bg-success/20 text-success',
  failed: 'bg-danger/20 text-danger',
  cancelled: 'bg-muted/20 text-muted',
  drawn: 'bg-success/20 text-success',
  invalidated: 'bg-warn/20 text-warn',
  loading: 'bg-accent/20 text-accent animate-pulse',
  ready: 'bg-success/20 text-success',
  errored: 'bg-danger/20 text-danger',
};

export default function StatusBadge({ status, size = 'sm' }: Props) {
  const sizeClass = size === 'xs' ? 'text-[10px] px-1 py-0.5' : 'text-xs px-1.5 py-0.5';
  return (
    <span className={`inline-flex items-center rounded font-mono font-medium ${sizeClass} ${STATUS_STYLES[status]}`}>
      {status}
    </span>
  );
}
