import { expect, type APIRequestContext } from '@playwright/test';

/** Create a session from `test-data/visium_hne.zarr` over the API and wait for it to
 *  be ready. Sessions are created this way rather than through the New Session dialog
 *  wherever the reader form isn't what's under test — session-flow.spec.ts covers that
 *  flow, and elsewhere it would only add a way to fail. */
export async function loadVisium(request: APIRequestContext): Promise<string> {
  const roots = (await (await request.get('/api/fs/browse')).json()) as { entries: { path: string }[] };
  const res = await request.post('/api/sessions', {
    data: { source: { kind: 'load', path: `${roots.entries[0].path}/visium_hne.zarr` } },
  });
  const created = (await res.json()) as { id?: string };
  // A refused create (the session cap, a bad path) answers with a detail body and no
  // id; say so here rather than polling a `/api/sessions/undefined` that 404s.
  if (!created.id) throw new Error(`session create failed: ${res.status()} ${JSON.stringify(created)}`);
  await expect.poll(async () => {
    const st = (await (await request.get(`/api/sessions/${created.id}`)).json()) as
      { summary: { status: string } };
    return st.summary.status;
  }, { timeout: 60_000 }).toBe('ready');
  return created.id;
}
