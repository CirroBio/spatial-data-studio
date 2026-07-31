import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// Two browsers on one session: the viewer who opens it holds the edit lock, the second
// can look but not change anything, and the lock hands over on unlock → take. Each
// Playwright context has its own localStorage, so the two pages are genuinely two
// viewers with two client ids (see frontend/src/lib/presence.ts).
//
// The session is created over the API rather than through the New Session dialog —
// session-flow.spec.ts covers that flow, and here it would only add a way to fail.

let sessionId: string | null = null;

async function loadVisium(request: APIRequestContext): Promise<string> {
  const roots = (await (await request.get('/api/fs/browse')).json()) as { entries: { path: string }[] };
  const created = (await (await request.post('/api/sessions', {
    data: { source: { kind: 'load', path: `${roots.entries[0].path}/visium_hne.zarr` } },
  })).json()) as { id: string };
  await expect.poll(async () => {
    const st = (await (await request.get(`/api/sessions/${created.id}`)).json()) as
      { summary: { status: string } };
    return st.summary.status;
  }, { timeout: 60_000 }).toBe('ready');
  return created.id;
}

function lockBadge(page: Page) {
  return page.getByRole('button', { name: /^Session lock:/ });
}

test('a second viewer can look but not edit until the lock is handed over', async ({ browser, request }) => {
  const owner = await browser.newContext();
  const guest = await browser.newContext();
  const ownerPage = await owner.newPage();
  const guestPage = await guest.newPage();

  try {
    sessionId = await loadVisium(request);

    // Opening the session locks it to the viewer who opened it, with no clicking.
    await ownerPage.goto('/');
    await expect(lockBadge(ownerPage)).toHaveText(/Locked to you/, { timeout: 30_000 });

    // The second viewer sees the holder's name and a viewer count of 2, and every
    // mutating control is gone — including the cell-labelling tabs.
    await guestPage.goto('/');
    await expect(lockBadge(guestPage)).toContainText('2', { timeout: 30_000 });
    await expect(guestPage.getByRole('tab', { name: /^Regions \(unavailable/ })).toBeDisabled();
    await expect(guestPage.getByRole('button', { name: '+ Run function' })).toHaveCount(0);

    // A mutation attempted anyway (the race where the guest's UI is a beat stale) is
    // refused by the backend, not merely hidden by the UI.
    const guestId = await guestPage.evaluate(() => localStorage.getItem('sds-client-id'));
    const refused = await request.post(`/api/sessions/${sessionId}/displays`, {
      headers: { 'X-SDS-Client-Id': guestId! },
      data: { type: 'embedding_canvas', encoding: {}, viewport: null },
    });
    expect(refused.status()).toBe(423);

    // Handover: the holder unlocks, the guest takes it, and the roles swap live.
    await lockBadge(ownerPage).click();
    await ownerPage.getByRole('button', { name: 'Unlock session' }).click();
    await expect(lockBadge(guestPage)).toHaveText(/Unlocked/, { timeout: 30_000 });

    await lockBadge(guestPage).click();
    await guestPage.getByRole('button', { name: 'Take the lock' }).click();
    await expect(lockBadge(guestPage)).toHaveText(/Locked to you/, { timeout: 30_000 });
    await expect(lockBadge(ownerPage)).not.toHaveText(/Locked to you/, { timeout: 30_000 });
    await expect(ownerPage.getByRole('button', { name: '+ Run function' })).toHaveCount(0);
  } finally {
    if (sessionId) {
      const id = await guestPage.evaluate(() => localStorage.getItem('sds-client-id')).catch(() => null);
      await request.delete(`/api/sessions/${sessionId}`, {
        headers: id ? { 'X-SDS-Client-Id': id } : {},
      }).catch(() => {});
      sessionId = null;
    }
    await owner.close();
    await guest.close();
  }
});
