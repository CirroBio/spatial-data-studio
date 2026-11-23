// @vitest-environment happy-dom  (lib/presence reads localStorage at import)
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api', () => ({
  ApiError: class ApiError extends Error { status = 500; },
  getCirroUploads: vi.fn(),
}));

import { useAppStore } from './sessionStore';
import * as api from '../api';
import type { CirroUpload } from '../api';

const upload = (id: number, state: CirroUpload['state'], error: string | null = null): CirroUpload =>
  ({ id, dataset_name: `dataset ${id}`, state, error });

const refreshWith = async (uploads: CirroUpload[]) => {
  (api.getCirroUploads as ReturnType<typeof vi.fn>).mockResolvedValue({ uploads });
  await useAppStore.getState().refreshCirroUploads();
};
const messages = () => useAppStore.getState().notifications.map((n) => n.message);

// The backend keeps settled uploads listed, so the rows a freshly loaded page reads are
// history. One sequence rather than separate cases: "has loaded once" is module state.
describe('refreshCirroUploads', () => {
  it('announces only the changes this page watched happen', async () => {
    await refreshWith([upload(1, 'completed'), upload(2, 'failed', 'boom'), upload(3, 'uploading')]);
    expect(messages()).toEqual([]);
    expect(useAppStore.getState().cirroUploads).toHaveLength(3);

    // An upload that was mid-flight at load still reports when it lands.
    await refreshWith([upload(1, 'completed'), upload(2, 'failed', 'boom'), upload(3, 'completed')]);
    expect(messages()).toEqual(['Uploaded to Cirro as "dataset 3".']);

    // Unchanged rows stay quiet on every later refresh.
    await refreshWith([upload(1, 'completed'), upload(2, 'failed', 'boom'), upload(3, 'completed')]);
    expect(messages()).toHaveLength(1);

    // One started after load that had already failed by the time its first read
    // came back was still watched, and still reports.
    await refreshWith([upload(1, 'completed'), upload(2, 'failed', 'boom'), upload(3, 'completed'),
      upload(4, 'failed', 'no space')]);
    expect(messages()).toEqual(['Uploaded to Cirro as "dataset 3".', 'Cirro upload failed: no space']);
  });
});
