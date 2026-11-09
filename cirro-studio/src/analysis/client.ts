// Main-thread side of the analysis worker. Only types come from the op table, so the
// analysis code itself is bundled into the worker chunk alone.
import type { ExpressionMatrix } from '@cirrobio/spatial-viewer';
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

// An expression matrix goes to the worker as a copy made here and transferred, which the
// worker owns (and normalizes in place, ops.ts). Cloned instead, it would sit three times
// in the tab at once (the page's, the serialized message, the worker's), on top of the
// normalized values: about a gigabyte for a 5K Xenium panel, which runs the tab out of
// memory.
const ownedCopy = (m: ExpressionMatrix): ExpressionMatrix => ({
  ...m, indptr: m.indptr.slice(), indices: m.indices.slice(), data: m.data.slice(),
});

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
    const matrix = (args as { matrix?: ExpressionMatrix }).matrix;
    const sent = matrix ? { ...args, matrix: ownedCopy(matrix) } : args;
    const request: AnalysisRequest<O> = { op, args: sent };
    worker.postMessage(request, transferables(transferInputs ? sent : (sent as { matrix?: ExpressionMatrix }).matrix));
  });
}

function abortError(): DOMException {
  return new DOMException('The analysis was cancelled.', 'AbortError');
}
