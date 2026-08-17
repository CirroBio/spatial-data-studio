// Download the WebGL canvas as a PNG, exactly as drawn.
//
// This is the serverless viewer's stand-in for a snapshot: the matplotlib figure
// export (vector PDF, chosen output size and DPI) is a backend render and has no
// client equivalent, so a checkpoint offers a straight screen capture instead.
// deck.gl 9 creates its device with `preserveDrawingBuffer: true` by default, so the
// backbuffer is still readable after the frame is composited.

import { downloadBlob } from './download';

function timestampedName(label: string): string {
  const slug = label.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'view';
  // Local time, filename-safe: 2026-08-12T14-32-05
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${slug}-${stamp}.png`;
}

/** Save the canvas inside `container` as a PNG. Rejects if the container holds no
 * canvas or the browser refuses to encode it. */
export async function downloadCanvasPng(container: HTMLElement | null, label: string): Promise<void> {
  const canvas = container?.querySelector('canvas');
  if (!canvas) throw new Error('no canvas to capture');

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('the browser could not encode the canvas as a PNG');
  downloadBlob(blob, timestampedName(label));
}
