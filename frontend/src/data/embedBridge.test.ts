// The bridge takes a host reply only from the embedding page. Any window holding a
// reference to the viewer frame can post to it, with a well-formed envelope and a
// guessable request id, so a reply from anywhere else must not answer the request.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { embedFolderAccess, requestFreshCheckpointUrl } from './embedBridge';

const SIGNED = 'https://host.example/store.zarr.zip?sig=good';
const FORGED = 'https://elsewhere.example/store.zarr.zip';

/** Stop the bridge's request at `window.parent` (unframed, this window) and hand back
 *  the last one it posted, for its request id. */
function interceptRequests(): () => { requestId: string } {
  const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  return () => post.mock.lastCall![0] as { requestId: string };
}

function hostReply(source: MessageEventSource, reply: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', {
    source,
    data: { source: 'cirro-dashboard', version: 1, ...reply },
  }));
}

// A window that is not this frame's parent: a sibling frame, an opener, a popup.
function otherWindow(): Window {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  return frame.contentWindow!;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('embed host replies', () => {
  it('take a refreshed checkpoint URL only from the parent window', async () => {
    const lastRequest = interceptRequests();
    const refreshed = requestFreshCheckpointUrl();
    const { requestId } = lastRequest();
    const other = otherWindow();
    expect(other).not.toBe(window.parent);

    hostReply(other, { type: 'checkpoint-url', requestId, url: FORGED });
    hostReply(window.parent, { type: 'checkpoint-url', requestId, url: SIGNED });
    await expect(refreshed).resolves.toBe(SIGNED);
  });

  it('take signed keys only from the parent window', async () => {
    const lastRequest = interceptRequests();
    const signed = embedFolderAccess.signKeys(['zarr.json']);
    const { requestId } = lastRequest();

    hostReply(otherWindow(), { type: 'signed-keys', requestId, urls: [FORGED] });
    hostReply(window.parent, { type: 'signed-keys', requestId, urls: [SIGNED] });
    await expect(signed).resolves.toEqual([SIGNED]);
  });
});
