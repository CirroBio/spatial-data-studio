// One analysis at a time in a task panel: read its inputs, run it in the worker, show its
// progress from the first click, let the user cancel it, and keep the error if it fails.
import { useCallback, useEffect, useRef, useState } from 'react';
import { runInWorker } from '../analysis/client';
import type { OpArgs, OpName, OpResult } from '../analysis/ops';
import { describeError } from '../cirro/session';

export interface Job {
  running: boolean;
  progress: number;
  message: string;
  error: string | null;
  /** Shows the job as running, with `message`, while its inputs are read: reading a large
   * expression matrix takes a while. A failure there ends the job. */
  prepare: <T>(message: string, work: Promise<T>) => Promise<T>;
  /** Moves the progress bar while `prepare` waits, for a read that says how far it has got. */
  prepareProgress: (fraction: number) => void;
  run: <O extends OpName>(op: O, args: OpArgs<O>) => Promise<OpResult<O> | null>;
  cancel: () => void;
}

const IDLE = { running: false, progress: 0, message: '', error: null as string | null };

export function useJob(): Job {
  const [state, setState] = useState(IDLE);
  const abort = useRef<AbortController | null>(null);
  // Cancel pressed while the inputs were read: the run that follows doesn't start.
  const preparing = useRef(false);
  const cancelled = useRef(false);
  // Leaving the task stops what it started.
  useEffect(() => () => abort.current?.abort(), []);
  const prepare = useCallback(async <T,>(message: string, work: Promise<T>): Promise<T> => {
    preparing.current = true;
    cancelled.current = false;
    setState({ running: true, progress: 0, message, error: null });
    try {
      return await work;
    } catch (e) {
      preparing.current = false;
      setState(IDLE);
      throw e;
    }
  }, []);
  const prepareProgress = useCallback((progress: number) => {
    if (preparing.current && !cancelled.current) setState((s) => ({ ...s, progress }));
  }, []);
  const run = useCallback(async <O extends OpName>(op: O, args: OpArgs<O>): Promise<OpResult<O> | null> => {
    const stopped = preparing.current && cancelled.current;
    preparing.current = false;
    cancelled.current = false;
    if (stopped) {
      setState(IDLE);
      return null;
    }
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
  const cancel = useCallback(() => {
    if (preparing.current) {
      cancelled.current = true;
      setState(IDLE);
    }
    abort.current?.abort();
  }, []);
  return { ...state, prepare, prepareProgress, run, cancel };
}
