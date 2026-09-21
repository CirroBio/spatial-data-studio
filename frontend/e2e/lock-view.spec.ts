// `lock_view` freezes the camera against pointer input, including when it is turned on
// while the canvas is already live.
//
// That last part is the whole point. deck.gl copies its `controller` prop onto the first
// view only when the prop is truthy (`Deck._getViews`, "Backward compatibility: support
// controller prop") and writes it onto the view instance in place, so a memoized view
// kept the controller a previous render had given it and `controller={false}` never took
// it back. The canvases declare the controller on the view itself now.
//
// A unit test cannot see this: the bug was in *where* the controller was passed, not in
// what the code computed. Nor can a pre-locked share link — loaded locked, the controller
// is false from the first render and there is no stale `true` to survive, so such a test
// passes against the broken code too. It has to be toggled at runtime on a live canvas,
// which is what the Cirro dashboard's inspector does over the embed protocol.
//
// Embed mode renders no in-canvas controls, so the camera is observed through the
// protocol instead: the viewer emits `display-changed` (debounced 500ms) whenever a pan
// or zoom moves the active display's viewport. Applying a display never echoes one back
// (the protocol's echo guard), so any event after an apply came from the camera.
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The smallest demo checkpoint carrying an image layer; this spec is about the camera,
// and the 32MB Xenium one spends minutes loading cells nothing here reads.
const CHECKPOINT = `/@fs${path.resolve(process.cwd(), '..', 'docs-site/viewer-data/visium-mouse-brain.sdata.zarr.zip')}`;
const OPEN = `/?checkpoint=${encodeURIComponent(CHECKPOINT)}&embed=1`;

// A cold load parses the archive and fits the camera before `ready`; the suite's default
// per-assertion timeout is not enough for that on a cold Vite cache.
const READY_MS = 120_000;
// Comfortably past the viewer's 500ms `display-changed` debounce.
const SETTLE_MS = 3_000;

test.setTimeout(300_000);

interface DisplayPayload {
  kind: string;
  encoding: Record<string, unknown>;
  viewport: unknown;
}

/** Collect every viewer -> parent message. In embed mode at the top level
 *  `window.parent === window`, so the bridge's posts land back on this page. */
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

const clearMessages = (page: Page) => page.evaluate(() => {
  (window as unknown as { __sds: unknown[] }).__sds = [];
});

async function applyDisplay(page: Page, display: DisplayPayload): Promise<void> {
  await page.evaluate((d) => {
    window.postMessage(
      { source: 'cirro-dashboard', version: 1, type: 'apply-display', display: d },
      '*',
    );
  }, display);
  await page.waitForTimeout(1_000);
}

/** Scroll-zoom over the middle of the canvas — pointer input, which only deck's
 *  controller can act on. */
async function wheelOverCanvas(page: Page): Promise<void> {
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(SETTLE_MS);
}

test('locking a live canvas stops the camera, and unlocking gives it back', async ({ page }) => {
  await collectEmbedMessages(page);
  await page.goto(OPEN);
  await expect.poll(async () => (await messagesOfType(page, 'ready')).length, { timeout: READY_MS })
    .toBeGreaterThan(0);

  // Control: the wheel reaches deck's controller at all, and a camera move is observable.
  await clearMessages(page);
  await wheelOverCanvas(page);
  const moved = await messagesOfType(page, 'display-changed') as { display: DisplayPayload }[];
  expect(moved.length, 'the wheel should move the camera while unlocked').toBeGreaterThan(0);

  // Lock the display that is on screen, carrying its current viewport so the lock is the
  // only thing that changes. This is the sequence that broke: the canvas has been live
  // and interactive, so its view already carries a controller.
  const live = moved[moved.length - 1].display;
  await applyDisplay(page, { ...live, encoding: { ...live.encoding, lock_view: true } });

  await clearMessages(page);
  await wheelOverCanvas(page);
  expect(
    await messagesOfType(page, 'display-changed'),
    'the wheel must not move the camera while the view is locked',
  ).toHaveLength(0);

  // Control: the canvas is still live, and the lock releases.
  await applyDisplay(page, { ...live, encoding: { ...live.encoding, lock_view: false } });
  await clearMessages(page);
  await wheelOverCanvas(page);
  expect(
    await messagesOfType(page, 'display-changed'),
    'unlocking should give the camera back',
  ).not.toHaveLength(0);
});
