import { test, expect, type Page } from '@playwright/test';

// Golden path: open an existing dataset, run a compute function on it, and
// browse the result through the data inspector. Runs against the real
// squidpy backend + visium_hne.zarr fixture (see playwright.config.ts).

let sessionId: string | null = null;

// The page holds the session's edit lock (opening a session takes it), so an API
// call that changes the session — closing it here — has to identify itself as that
// same client or the backend refuses it with 423.
async function clientHeaders(page: Page): Promise<Record<string, string>> {
  const id = await page.evaluate(() => localStorage.getItem('sds-client-id')).catch(() => null);
  return id ? { 'X-SDS-Client-Id': id } : {};
}

test.afterEach(async ({ page, request }) => {
  if (sessionId) {
    const headers = await clientHeaders(page);
    await request.delete(`/api/sessions/${sessionId}`, { headers }).catch(() => {});
    sessionId = null;
  }
});

test('loads a dataset, runs a compute function, and browses the result', async ({ page, request }) => {
  await page.goto('/');

  // -- open an existing .zarr dataset --------------------------------------
  // A raw .zarr store is not an app checkpoint, so it comes in through Import
  // Data's SpatialData reader (Open Checkpoint only lists .sdata.zarr.zip).
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  const newSessionDialog = page.getByRole('dialog');
  await newSessionDialog.getByRole('button', { name: 'Import Data' }).click();
  await newSessionDialog
    .locator('select')
    .first()
    .selectOption({ label: 'SpatialData zarr (.zarr / .zip / .tar.gz)' });
  // Filesystem picker: the data root (SDS_DATA_DIR=../test-data), then the store.
  await newSessionDialog.getByRole('button', { name: /test-data/ }).first().click();
  await newSessionDialog.getByRole('button', { name: /visium_hne\.zarr/ }).click();
  await newSessionDialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(newSessionDialog).not.toBeVisible({ timeout: 30_000 });

  await expect(page.getByText('No session open')).not.toBeVisible();
  const sessions = (await (await request.get('/api/sessions')).json()) as { sessions: { id: string }[] };
  sessionId = sessions.sessions.at(-1)!.id;

  // -- the spatial canvas renders -------------------------------------------
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });

  // -- Cells: switch the point Geometry and confirm it persists -------------
  // visium_hne has no boundary polygons, so the Cells layer is Points-only: the
  // Render-mode selector is hidden and the Geometry picker is shown.
  const showControls = page.getByRole('button', { name: 'Show controls' });
  if (await showControls.isVisible().catch(() => false)) await showControls.click();
  await page.getByRole('tab', { name: 'Cells' }).click();
  await page.locator('select:has(option[value="hexagon"])').selectOption('square');
  await expect.poll(async () => {
    const st = (await (await request.get(`/api/sessions/${sessionId}`)).json()) as {
      app_state: { displays: { type: string; encoding: { point_marker?: string } }[] };
    };
    return st.app_state.displays.find((d) => d.type === 'spatial_canvas')?.encoding.point_marker;
  }, { timeout: 10_000 }).toBe('square');

  // -- run a compute function -----------------------------------------------
  await page.getByRole('button', { name: '+ Run function' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByPlaceholder('Search functions...').fill('spatial_neighbors');
  await picker.getByRole('button', { name: 'spatial_neighbors', exact: false }).first().click();

  await picker.locator('input[name="coord_type"]').fill('generic');
  await picker.locator('input[name="n_neighs"]').fill('6');
  await picker.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(picker).not.toBeVisible();

  const historyItem = page.locator('aside li', { hasText: 'spatial_neighbors' });
  await expect(historyItem).toBeVisible();
  await expect(historyItem.getByText('completed')).toBeVisible({ timeout: 60_000 });

  // -- browse the result via the data inspector -----------------------------
  await page.getByRole('button', { name: 'Tables' }).click();
  await expect(page.locator('table').first()).toBeVisible({ timeout: 15_000 });
});
