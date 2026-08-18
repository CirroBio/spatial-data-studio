import { test, expect, type Page } from '@playwright/test';
import { loadVisium } from './fixtures';

// Runtime guard for the intro tour: every step's target must resolve in the live app.
// Catches conditional-rendering regressions the static anchor check (npm run
// check:tours) can't see. Two passes, because half the tour's targets are
// session-dependent: with no session open (which is when the first-visit tour fires)
// and with one loaded.

/** Start the tour from the app menu and step through it, returning the title and the
 *  progress text ("2 of 7") of each step shown. */
async function walkTour(page: Page): Promise<{ title: string; progress: string }[]> {
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Take the tour' }).click();

  const popover = page.locator('.driver-popover');
  await expect(popover).toBeVisible();
  const title = popover.locator('.driver-popover-title');

  const seen: { title: string; progress: string }[] = [];
  // Steps whose target is absent are dropped before the tour opens, so the walk is
  // shorter than the tour — and the progress counter covers only what is left.
  for (let i = 0; i < 15; i++) {
    const current = (await title.textContent()) ?? '';
    seen.push({
      title: current,
      progress: (await popover.locator('.driver-popover-progress-text').textContent()) ?? '',
    });
    const done = page.locator('.driver-popover-next-btn', { hasText: 'Done' });
    if (await done.count()) {
      await done.click();
      break;
    }
    await page.locator('.driver-popover-next-btn').click();
    // Driver.js repaints the popover asynchronously; wait for the title to move on
    // rather than sampling a stale one.
    await expect.poll(async () => (await title.textContent()) ?? '', { timeout: 10_000 })
      .not.toBe(current);
  }
  await expect(popover).not.toBeVisible();
  return seen;
}

/** The counter must run 1..n over exactly the steps shown, with no gaps from a step
 *  that was skipped — the drift this guards is a plausible-looking "1 of 10, 4 of 10". */
function expectContiguousProgress(seen: { progress: string }[]) {
  expect(seen.map((s) => s.progress)).toEqual(
    seen.map((_, i) => `${i + 1} of ${seen.length}`),
  );
}

test('intro tour walks its always-present steps', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('No session open')).toBeVisible();

  const seen = await walkTour(page);
  const titles = seen.map((s) => s.title);

  // The empty-state step is the one session-dependent step that must appear here; the
  // canvas and sidebar-control steps need a loaded dataset and are skipped.
  expect(titles).toContain('Welcome to Spatial Data Studio');
  expect(titles).toContain('Load a dataset');
  expect(titles).toContain('Sessions');
  expect(titles).toContain('App menu');
  expectContiguousProgress(seen);
});

test('intro tour walks its session-dependent steps', async ({ page, request }) => {
  // Loading the dataset and mounting the canvas costs most of the default budget
  // before the walk itself starts.
  test.slow();
  const sessionId = await loadVisium(request);
  try {
    await page.goto('/');
    // Wait for the canvas, not just the session: the display-settings panel renders in
    // the canvas' controls slot, so the tour would skip that step until it mounts.
    await page.locator('[data-tour="display-settings"]').waitFor({ timeout: 30_000 });

    const seen = await walkTour(page);
    const titles = seen.map((s) => s.title);

    for (const title of [
      'Welcome to Spatial Data Studio',
      'Sessions',
      'Who can edit',
      'Switch views',
      'Display settings',
      'Compute, Plots, Regions, Annotations, Subset',
      'Run an analysis',
      'Recipes',
      'App menu',
    ]) expect(titles).toContain(title);
    // The empty-state step is the mirror image: skipped now that a session is open.
    expect(titles).not.toContain('Load a dataset');
    expectContiguousProgress(seen);
  } finally {
    const clientId = await page.evaluate(() => localStorage.getItem('sds-client-id')).catch(() => null);
    await request.delete(`/api/sessions/${sessionId}`, {
      headers: clientId ? { 'X-SDS-Client-Id': clientId } : {},
    }).catch(() => {});
  }
});
