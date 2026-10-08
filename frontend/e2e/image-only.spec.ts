// A checkpoint with an image and no table opens onto the image.
//
// The canvas used to frame its first camera only once it had cell positions, even when
// the frame it computes for an image display reads nothing but the image's extent. A
// store with no cells (multiplexed imaging not yet segmented) then sent `ready` and sat
// on "Initializing canvas..." for good. The fixture is the CLI's checkpoint of a
// two-channel, table-less SpatialData store (`cli.py --parser zarr`), 85 KB.
//
// Embed mode is what a Cirro dashboard or the website uses, and its protocol makes the
// camera observable: a wheel over a live canvas moves the viewport, which the viewer
// reports as `display-changed`.
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const CHECKPOINT = `/@fs${path.resolve(process.cwd(), 'e2e/fixtures/image-only.sdata.zarr.zip')}`;
const OPEN = `/?checkpoint=${encodeURIComponent(CHECKPOINT)}&embed=1`;

const READY_MS = 120_000;
// Comfortably past the viewer's 500ms `display-changed` debounce.
const SETTLE_MS = 3_000;

test.setTimeout(300_000);

interface ReadyMessage {
  type: 'ready';
  inventory: { images: { element: string; channelNames: string[] }[]; obsmKeys: unknown[] };
}

async function collectEmbedMessages(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __sds: unknown[] }).__sds = [];
    window.addEventListener('message', (e: MessageEvent) => {
      const msg = e.data as { source?: string } | null;
      if (msg && msg.source === 'sds-embed') (window as unknown as { __sds: unknown[] }).__sds.push(msg);
    });
  });
}

const messagesOfType = (page: Page, type: string) => page.evaluate(
  (t) => (window as unknown as { __sds: { type: string }[] }).__sds.filter((m) => m.type === t),
  type,
);

test('an image with no cells is framed and the camera is live', async ({ page }) => {
  await collectEmbedMessages(page);
  await page.goto(OPEN);
  await expect.poll(async () => (await messagesOfType(page, 'ready')).length, { timeout: READY_MS })
    .toBeGreaterThan(0);

  const [ready] = (await messagesOfType(page, 'ready')) as unknown as ReadyMessage[];
  expect(ready.inventory.images).toEqual([
    expect.objectContaining({ element: 'tissue', channelNames: ['DNA', 'PanCK'] }),
  ]);
  expect(ready.inventory.obsmKeys).toEqual([]);

  // The canvas element mounts only once a camera exists; before the fix it never did.
  // (Asserting the placeholder's absence first would pass vacuously in the moment
  // before it renders.)
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Initializing canvas...')).toHaveCount(0);

  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(SETTLE_MS);
  const moves = (await messagesOfType(page, 'display-changed')) as unknown as
    { display: { viewport: { zoom: number } | null } }[];
  expect(moves.length).toBeGreaterThan(0);
  expect(moves.at(-1)!.display.viewport).not.toBeNull();
});
