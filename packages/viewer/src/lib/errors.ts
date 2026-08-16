import { formatError } from './format';

/**
 * Where `reportError` sends messages. The Studio app installs a sink that pushes
 * a notification into its store (see `main.tsx`); a host that renders the canvas
 * without that store — a Cirro dashboard tile — gets the console fallback instead
 * of the canvas depending on app state it has no way to provide.
 */
type ErrorSink = (message: string) => void;

const consoleSink: ErrorSink = (message) => console.error(message);

let sink: ErrorSink = consoleSink;

/** Install the process-wide error sink. Passing null restores the console fallback. */
export function setErrorSink(next: ErrorSink | null): void {
  sink = next ?? consoleSink;
}

export function reportError(prefix: string, err: unknown): void {
  sink(`${prefix}: ${formatError(err)}`);
}
