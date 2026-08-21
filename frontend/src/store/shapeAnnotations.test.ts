// @vitest-environment happy-dom  (lib/presence reads localStorage at import)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api', () => ({
  ApiError: class ApiError extends Error { status = 500; },
  listShapeAnnotations: vi.fn(),
  updateShapeAnnotation: vi.fn(),
  createShapeAnnotation: vi.fn(),
  deleteShapeAnnotation: vi.fn(),
}));

import { useAppStore } from './sessionStore';
import * as api from '../api';
import type { ShapeAnnotation } from '@cirrobio/spatial-viewer';

const label = (text: string): ShapeAnnotation => ({
  id: 's1',
  geometry: { kind: 'text', position: [0, 0], text, fontSize: 10, rotation: 0 },
  stroke: { color: '#ffffff', width: 1, dash: 'solid', arrowStart: false, arrowEnd: false, arrowSize: 1, z: 0 },
});

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const shownText = () => {
  const geometry = useAppStore.getState().shapeAnnotations[0].geometry;
  return geometry.kind === 'text' ? geometry.text : null;
};
// The PUT's promise chain has several hops before the job id is mapped.
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
// Fire the debounced PUT and let it be accepted, returning its job id.
const flush = async () => {
  vi.advanceTimersByTime(500);
  await settle();
  const calls = mocked(api.updateShapeAnnotation).mock.calls;
  return `j${calls.length}`;
};
// What the SSE handler does for a `shape_annotate` job.completed frame.
const jobCompleted = async (jobId: string, serverText: string) => {
  mocked(api.listShapeAnnotations).mockResolvedValue({ shapes: [label(serverText)] });
  useAppStore.getState().resolveShapeJob(jobId);
  await useAppStore.getState().refreshShapeAnnotations('sess');
};

// A shape stays locally owned from its first edit until the job carrying that edit has
// landed *and* been reconciled, so none of the refreshes firing in between (this
// session's other shape jobs, another viewer's) can put the server's older copy back
// on screen — which, for the text field, also yanked the caret out of the word.
describe('editing a shape while refreshes land', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocked(api.updateShapeAnnotation).mockReset();
    mocked(api.updateShapeAnnotation).mockImplementation(
      () => Promise.resolve({ job_id: `j${mocked(api.updateShapeAnnotation).mock.calls.length}` }));
    useAppStore.setState({
      activeSessionId: 'sess',
      sessionState: { summary: { id: 'sess', name: 'view', read_only: false } } as never,
      shapeAnnotations: [label('')],
      selectedShapeId: 's1',
    });
  });
  // Leave no outstanding job behind: the locally-owned marks are module state.
  afterEach(async () => { await jobCompleted(await flush(), shownText()!); vi.useRealTimers(); });

  it('keeps what was typed before the debounced PUT went out', async () => {
    useAppStore.getState().editShapeAnnotation(label('Hel'));
    await jobCompleted('unrelated', '');  // another shape's job, server pre-edit
    expect(shownText()).toBe('Hel');
  });

  it('keeps what was typed while the PUT was in flight, and persists it after', async () => {
    useAppStore.getState().editShapeAnnotation(label('Hel'));
    const job = await flush();
    useAppStore.getState().editShapeAnnotation(label('Hello wor'));

    await jobCompleted(job, 'Hel');
    expect(shownText()).toBe('Hello wor');

    await flush();
    const [, , sent] = mocked(api.updateShapeAnnotation).mock.calls[1];
    expect((sent as ShapeAnnotation).geometry).toMatchObject({ text: 'Hello wor' });
  });

  it('adopts the server copy again once the edit has been reconciled', async () => {
    useAppStore.getState().editShapeAnnotation(label('Hel'));
    await jobCompleted(await flush(), 'Hel');

    mocked(api.listShapeAnnotations).mockResolvedValue({ shapes: [label('edited elsewhere')] });
    await useAppStore.getState().refreshShapeAnnotations('sess');
    expect(shownText()).toBe('edited elsewhere');
  });
});
