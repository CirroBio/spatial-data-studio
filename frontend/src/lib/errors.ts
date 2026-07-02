import { useAppStore } from '../store/sessionStore';

export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function reportError(prefix: string, err: unknown): void {
  useAppStore.getState().pushNotification({
    kind: 'error',
    message: `${prefix}: ${formatError(err)}`,
  });
}
