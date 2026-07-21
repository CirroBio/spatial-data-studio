import { useAppStore } from '../store/sessionStore';
import { formatError } from './format';

export function reportError(prefix: string, err: unknown): void {
  useAppStore.getState().pushNotification({
    kind: 'error',
    message: `${prefix}: ${formatError(err)}`,
  });
}
