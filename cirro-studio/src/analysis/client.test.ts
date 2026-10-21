import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInWorker } from './client';
import { handleRequest, type AnalysisMessage, type AnalysisRequest } from './ops';

// Stands in for a module Worker: runs the request with the worker's own handler on a
// later tick, passing data through structuredClone as postMessage would.
class FakeWorker {
  static instances: FakeWorker[] = [];
  static respond = true;
  onmessage: ((event: MessageEvent<AnalysisMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;

  constructor(readonly url: URL, readonly options: WorkerOptions) {
    FakeWorker.instances.push(this);
  }

  postMessage(data: AnalysisRequest, transfer: Transferable[]) {
    const received = structuredClone(data, { transfer });
    if (!FakeWorker.respond) return;
    setTimeout(() => handleRequest(received, (message, back) => {
      if (!this.terminated) this.onmessage?.({ data: structuredClone(message, { transfer: back }) } as MessageEvent<AnalysisMessage>);
    }));
  }

  terminate() {
    this.terminated = true;
  }
}

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.respond = true;
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const grid = Float32Array.from({ length: 200 }, (_, i) => (i % 2 ? Math.floor(i / 20) : (i >> 1) % 10));

describe('runInWorker', () => {
  it('runs the op in a module worker, forwards progress and resolves with the result', async () => {
    const progress: number[] = [];
    const result = await runInWorker('spatialKnn', { xy: grid, k: 4 }, { onProgress: (fraction) => progress.push(fraction) });
    expect(result).toBeInstanceOf(Int32Array);
    expect(result).toHaveLength(400);
    expect(progress.at(-1)).toBe(1);
    const [worker] = FakeWorker.instances;
    expect(worker.url.pathname.endsWith('/worker.ts')).toBe(true);
    expect(worker.options).toEqual({ type: 'module' });
    expect(worker.terminated).toBe(true);
  });

  it('copies its inputs unless asked to transfer them', async () => {
    const xy = Float32Array.from(grid);
    await runInWorker('spatialKnn', { xy, k: 4 });
    expect(xy).toHaveLength(200);
    await runInWorker('spatialKnn', { xy, k: 4 }, { transferInputs: true });
    expect(xy).toHaveLength(0);
  });

  it('rejects with the worker’s error message', async () => {
    await expect(runInWorker('spatialKnn', { xy: grid, k: 500 })).rejects.toThrow('k must be between 1 and 99, got 500');
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it('terminates the worker and rejects with an AbortError when aborted', async () => {
    FakeWorker.respond = false;
    const controller = new AbortController();
    const running = runInWorker('spatialKnn', { xy: grid, k: 4 }, { signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it('does not start a worker for a signal that is already aborted', async () => {
    await expect(runInWorker('spatialKnn', { xy: grid, k: 4 }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances).toHaveLength(0);
  });
});
