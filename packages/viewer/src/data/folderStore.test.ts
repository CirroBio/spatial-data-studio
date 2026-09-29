import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostSignedFolderStore } from './folderStore';

function access(keys: string[]) {
  const signKeys = vi.fn(async (requested: readonly string[]) => requested.map((k) => `https://signed/${k}`));
  const listKeys = vi.fn(async () => keys);
  return { signKeys, listKeys };
}

afterEach(() => vi.unstubAllGlobals());

describe('HostSignedFolderStore', () => {
  it('answers an unlisted key as absent without signing or fetching it', async () => {
    const host = access(['zarr.json']);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store = await HostSignedFolderStore.open(host);
    expect(await store.get('/tables/zarr.json')).toBeUndefined();
    expect(host.signKeys).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs every key requested in the same tick in one batch', async () => {
    const host = access(['a', 'b', 'c']);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    const store = await HostSignedFolderStore.open(host);
    await Promise.all([store.get('/a'), store.get('/b'), store.get('/c')]);
    expect(host.signKeys).toHaveBeenCalledTimes(1);
    expect(host.signKeys).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('re-signs once when a listed key answers 403 (an expired signature)', async () => {
    const host = access(['a']);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([7])));
    vi.stubGlobal('fetch', fetchMock);
    const store = await HostSignedFolderStore.open(host);
    expect(await store.get('/a')).toEqual(new Uint8Array([7]));
    expect(host.signKeys).toHaveBeenCalledTimes(2);
  });

  it('sends a Range header for a range read', async () => {
    const host = access(['a']);
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 206 }));
    vi.stubGlobal('fetch', fetchMock);
    const store = await HostSignedFolderStore.open(host);
    await store.getRange('/a', { offset: 10, length: 2 });
    expect(fetchMock).toHaveBeenCalledWith('https://signed/a', { headers: { Range: 'bytes=10-11' } });
  });
});
