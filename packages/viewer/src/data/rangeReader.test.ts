import { afterEach, describe, expect, it, vi } from 'vitest';
import { RangeGetReader } from './checkpointSource';

const BYTES = Uint8Array.from({ length: 1 << 20 }, (_, i) => i % 251);

/** A fetch that answers Range GETs over BYTES with 206, recording each range asked. */
function mockFetch(status = 206) {
  const ranges: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>).Range;
    ranges.push(range);
    const [a, b] = range.replace('bytes=', '').split('-').map(Number);
    return new Response(BYTES.slice(a, b + 1), { status, headers: { 'Content-Range': `bytes ${a}-${b}/${BYTES.length}` } });
  }));
  return ranges;
}

afterEach(() => vi.unstubAllGlobals());

describe('RangeGetReader', () => {
  it('joins nearby reads made in the same tick into one GET and slices them back', async () => {
    const ranges = mockFetch();
    const reader = new RangeGetReader('https://bucket.example/store.zip');
    const [a, b, c, far] = await Promise.all([
      reader.read(100, 10), reader.read(120, 5), reader.read(110, 10), reader.read(900_000, 4),
    ]);
    expect(ranges).toEqual(['bytes=100-124', 'bytes=900000-900003']);
    expect([...a]).toEqual([...BYTES.slice(100, 110)]);
    expect([...b]).toEqual([...BYTES.slice(120, 125)]);
    expect([...c]).toEqual([...BYTES.slice(110, 120)]);
    expect([...far]).toEqual([...BYTES.slice(900_000, 900_004)]);
  });

  it('rejects every read in a group when the server ignores Range', async () => {
    mockFetch(200);
    const reader = new RangeGetReader('https://bucket.example/store.zip');
    const results = await Promise.allSettled([reader.read(0, 4), reader.read(4, 4)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });
});
