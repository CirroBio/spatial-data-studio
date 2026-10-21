// One analysis at a time in a task panel: run it in the worker, show its progress, let
// the user cancel it, and keep the error if it fails.
import { useCallback, useEffect, useRef, useState } from 'react';
import { runInWorker } from '../analysis/client';
import type { OpArgs, OpName, OpResult } from '../analysis/ops';
import { describeError } from '../cirro/session';

export interface Job {
  running: boolean;
  progress: number;
  message: string;
  error: string | null;
  run: <O extends OpName>(op: O, args: OpArgs<O>) => Promise<OpResult<O> | null>;
  cancel: () => void;
}

export function useJob(): Job {
  const [state, setState] = useState({ running: false, progress: 0, message: '', error: null as string | null });
  const abort = useRef<AbortController | null>(null);
  // Leaving the task stops what it started.
  useEffect(() => () => abort.current?.abort(), []);
  const run = useCallback(async <O extends OpName>(op: O, args: OpArgs<O>): Promise<OpResult<O> | null> => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    // A later run aborts this one and owns the state from then on.
    const current = () => abort.current === controller;
    setState({ running: true, progress: 0, message: 'Starting', error: null });
    try {
      const result = await runInWorker(op, args, {
        signal: controller.signal,
        onProgress: (progress, message) => {
          if (current()) setState((s) => ({ ...s, progress, message }));
        },
      });
      if (current()) setState({ running: false, progress: 1, message: '', error: null });
      return result;
    } catch (e) {
      if (current()) setState({ running: false, progress: 0, message: '', error: controller.signal.aborted ? null : describeError(e) });
      return null;
    }
  }, []);
  const cancel = useCallback(() => abort.current?.abort(), []);
  return { ...state, run, cancel };
}
