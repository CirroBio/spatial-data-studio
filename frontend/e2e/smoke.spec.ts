import { test, expect } from '@playwright/test';

test('loads the app shell and opens the New Session dialog', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Spatial Data Studio')).toBeVisible();
  await expect(page.getByText('No session open')).toBeVisible();

  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('New Session', { exact: true })).toBeVisible();
  await expect(dialog.getByPlaceholder(/saved checkpoints/)).toBeVisible();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible();
});
