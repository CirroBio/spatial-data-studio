// A tuned view survives being handed to someone else as a URL.
//
// The encoder itself is unit-tested (src/lib/urlViewState.test.ts); this covers the
// wiring the unit tests can't see — that edits reach the URL, and that a fresh page
// load rebuilds the same view from it.
//
// The deck.gl canvas is not drivable by automation (synthetic drag and wheel events
// never reach deck's controller), so everything here goes through real DOM controls.
// The zoom buttons are the lever for the camera: `onZoom` sets React view state and
// writes the viewport directly, bypassing the controller entirely.
import path from 'node:path';
import { expect, test } from '@playwright/test';

// The docs site's demo checkpoint, served through the dev server's /@fs/ route rather
// than copied into public/ — one committed copy, and Vite answers range requests on it.
const CHECKPOINT = `/@fs${path.resolve(process.cwd(), '..', 'docs-site/viewer-data/fluorescence-section.sdata.zarr.zip')}`;
const OPEN = `/?checkpoint=${encodeURIComponent(CHECKPOINT)}`;

function viewParam(url: string): string | null {
  return new URL(url).searchParams.get('view');
}

test('display settings and camera round-trip through the URL', async ({ page }) => {
  await page.goto(OPEN);

  const minimap = page.getByLabel('Minimap', { exact: true });
  await expect(minimap).toBeChecked({ timeout: 30_000 });
  // Nothing changed yet, so the link is just the checkpoint.
  expect(viewParam(page.url())).toBeNull();

  const zoomReadout = page.locator('span[title^="Zoom level"]');
  await expect(zoomReadout).toBeVisible();
  const fittedZoom = (await zoomReadout.textContent())?.trim();

  await minimap.uncheck();
  await page.getByTitle('Zoom in').click();
  await page.getByTitle('Zoom in').click();
  await expect(zoomReadout).not.toHaveText(fittedZoom!);
  const sharedZoom = (await zoomReadout.textContent())!.trim();

  // The writer debounces, so wait for the URL rather than asserting immediately.
  await expect.poll(() => viewParam(page.url()), { timeout: 10_000 }).not.toBeNull();
  const shared = page.url();

  // What a collaborator gets: a cold load of the link, no shared state with the tab
  // that produced it.
  const fresh = await page.context().browser()!.newContext();
  const collaborator = await fresh.newPage();
  await collaborator.goto(shared);

  const theirMinimap = collaborator.getByLabel('Minimap', { exact: true });
  await expect(theirMinimap).not.toBeChecked({ timeout: 30_000 });
  // Same cold-load allowance as above: with an image layer the canvas defers its first
  // fit until the image bounds arrive, and the viewport restore runs after that fit.
  await expect(collaborator.locator('span[title^="Zoom level"]'))
    .toHaveText(sharedZoom, { timeout: 30_000 });
  await fresh.close();
});

test('an unreadable view parameter falls back to the saved view', async ({ page }) => {
  await page.goto(`${OPEN}&view=not-a-real-payload`);

  // The checkpoint's own settings render, and the viewer says why rather than showing
  // a silently wrong view.
  await expect(page.getByLabel('Minimap', { exact: true })).toBeChecked({ timeout: 30_000 });
  await expect(page.getByText(/couldn't be read/i)).toBeVisible();
});
