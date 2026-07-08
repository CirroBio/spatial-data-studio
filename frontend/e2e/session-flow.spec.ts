import { test, expect } from '@playwright/test';

// Golden path: open an existing dataset, run a compute function on it, and
// browse the result through the data inspector. Runs against the real
// squidpy backend + visium_hne.zarr fixture (see playwright.config.ts).

let sessionId: string | null = null;

test.afterEach(async ({ request }) => {
  if (sessionId) {
    await request.delete(`/api/sessions/${sessionId}`).catch(() => {});
    sessionId = null;
  }
});

test('loads a dataset, runs a compute function, and browses the result', async ({ page, request }) => {
  await page.goto('/');

  // -- open an existing .zarr dataset --------------------------------------
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  const newSessionDialog = page.getByRole('dialog');
  await newSessionDialog.getByPlaceholder(/saved checkpoints/).click();
  await newSessionDialog.getByText('visium_hne', { exact: false }).first().click();
  await newSessionDialog.getByRole('button', { name: 'Create' }).click();
  await expect(newSessionDialog).not.toBeVisible({ timeout: 30_000 });

  await expect(page.getByText('No session open')).not.toBeVisible();
  const sessions = (await (await request.get('/api/sessions')).json()) as { sessions: { id: string }[] };
  sessionId = sessions.sessions.at(-1)!.id;

  // -- the spatial canvas renders -------------------------------------------
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });

  // -- run a compute function -----------------------------------------------
  await page.getByRole('button', { name: '+ Add compute function' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByPlaceholder('Search functions...').fill('spatial_neighbors');
  await picker.getByRole('button', { name: 'spatial_neighbors', exact: false }).first().click();

  await picker.locator('div.flex.flex-col.gap-1:has-text("coord_type") input').fill('generic');
  await picker.locator('div.flex.flex-col.gap-1:has-text("n_neighs") input').fill('6');
  await picker.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(picker).not.toBeVisible();

  const historyItem = page.locator('aside li', { hasText: 'spatial_neighbors' });
  await expect(historyItem).toBeVisible();
  await expect(historyItem.getByText('completed')).toBeVisible({ timeout: 60_000 });

  // -- browse the result via the data inspector -----------------------------
  await page.getByRole('button', { name: 'Tables' }).click();
  await expect(page.locator('table').first()).toBeVisible({ timeout: 15_000 });
});
