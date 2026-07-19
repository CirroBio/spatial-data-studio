import { test, expect } from '@playwright/test';

// Runtime guard for the intro tour: every non-optional step's target must
// resolve in the live app. Catches conditional-rendering regressions the static
// anchor check (npm run check:tours) can't see.
test('intro tour walks its always-present steps', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('No session open')).toBeVisible();

  await page.getByRole('button', { name: 'Take the tour' }).click();

  const popover = page.locator('.driver-popover');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Welcome to Spatial Data Studio');

  // Step through to the end via Next. Optional (session-dependent) steps are
  // skipped automatically when no session is open; the always-present header
  // steps must appear, ending on the Snapshots step's Done button.
  const nextBtn = page.locator('.driver-popover-next-btn');
  await expect(nextBtn).toBeVisible();

  const seen: string[] = [];
  for (let i = 0; i < 12; i++) {
    seen.push((await popover.locator('.driver-popover-title').textContent()) ?? '');
    const done = page.locator('.driver-popover-next-btn', { hasText: 'Done' });
    if (await done.count()) {
      await done.click();
      break;
    }
    await nextBtn.click();
    await page.waitForTimeout(150);
  }

  await expect(popover).not.toBeVisible();
  expect(seen).toContain('Sessions');
  expect(seen).toContain('Save your work');
  expect(seen).toContain('Snapshots');
});
