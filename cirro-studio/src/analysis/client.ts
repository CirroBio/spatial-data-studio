// Main-thread side of the analysis worker. Only types come from the op table, so the
// analysis code itself is bundled into the worker chunk alone.
import type { AnalysisMessage, AnalysisRequest, OpArgs, OpName, OpResult } from './ops';
import { transferables } from './transfer';

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => void;
  // Move the arguments' typed-array buffers to the worker instead of copying them. The
  // caller's arrays are left detached (length 0), so pass true only for data it no
  // longer needs. Results always come back by transfer.
  transferInputs?: boolean;
}

/** Runs one analysis in a fresh module worker. Aborting the signal terminates the worker
 * and rejects with an AbortError. */
export function runInWorker<O extends OpName>(op: O, args: OpArgs<O>, options: RunOptions = {}): Promise<OpResult<O>> {
  const { signal, onProgress, transferInputs = false } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const onAbort = () => {
      finish();
      reject(abortError());
    };
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort);
    worker.onmessage = (event: MessageEvent<AnalysisMessage>) => {
      const message = event.data;
      if ('progress' in message) {
        onProgress?.(message.progress, message.message);
        return;
      }
      finish();
      if ('error' in message) reject(new Error(message.error));
      else resolve(message.result as OpResult<O>);
    };
    worker.onerror = (event: ErrorEvent) => {
      finish();
      reject(new Error(event.message || `The ${op} analysis worker failed to start.`));
    };
    worker.onmessageerror = () => {
      finish();
      reject(new Error(`The ${op} analysis result could not be received.`));
    };
    const request: AnalysisRequest<O> = { op, args };
    worker.postMessage(request, transferInputs ? transferables(args) : []);
  });
}

function abortError(): DOMException {
  return new DOMException('The analysis was cancelled.', 'AbortError');
}
