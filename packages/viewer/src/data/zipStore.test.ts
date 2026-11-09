import type { AbsolutePath } from '@zarrita/storage';
import type { Reader } from 'unzipit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RangeGetReader } from './checkpointSource';
import { ZipRangeStore } from './zipStore';

const FILES: [string, Uint8Array][] = [
  ['zarr.json', new TextEncoder().encode('{"zarr_format":3}')],
  ['x/c/0', Uint8Array.from({ length: 300 }, (_, i) => i % 256)],
  ['x/c/1', Uint8Array.from({ length: 500 }, (_, i) => (i * 7) % 256)],
];

// An extra field of `length` bytes: one record (id, size, then that many bytes), or none.
function extraField(length: number): Uint8Array {
  const field = new Uint8Array(length);
  if (length) new DataView(field.buffer).setUint32(0, 0xcafe | ((length - 4) << 16), true);
  return field;
}

/** A ZIP_STORED archive of `files`, its local headers' extra fields `localExtra` bytes
 * long and its central records' `centralExtra`, which writers don't always keep equal. */
function storedZip(files: [string, Uint8Array][], { localExtra = 0, centralExtra = 0 } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const records: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = new TextEncoder().encode(name);
    const local = new Uint8Array(30 + nameBytes.length + localExtra);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, nameBytes.length, true);
    l.setUint16(28, localExtra, true);
    local.set(nameBytes, 30);
    local.set(extraField(localExtra), 30 + nameBytes.length);
    const record = new Uint8Array(46 + nameBytes.length + centralExtra);
    const c = new DataView(record.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, nameBytes.length, true);
    c.setUint16(30, centralExtra, true);
    c.setUint32(42, offset, true);
    record.set(nameBytes, 46);
    record.set(extraField(centralExtra), 46 + nameBytes.length);
    parts.push(local, data);
    records.push(record);
    offset += local.length + data.length;
  }
  const directorySize = records.reduce((n, r) => n + r.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, directorySize, true);
  e.setUint32(16, offset, true);
  const zip = new Uint8Array(offset + directorySize + end.length);
  let at = 0;
  for (const part of [...parts, ...records, end]) {
    zip.set(part, at);
    at += part.length;
  }
  return zip;
}

/** A reader over `bytes` that records each read it is asked for. */
function recordingReader(bytes: Uint8Array): Reader & { reads: [number, number][] } {
  const reads: [number, number][] = [];
  return {
    reads,
    getLength: async () => bytes.length,
    read: async (offset, length) => {
      reads.push([offset, length]);
      return bytes.slice(offset, offset + length);
    },
  };
}

/** A store over a zip, with the central directory already read so only entry reads count. */
async function openStore(zip: Uint8Array) {
  const reader = recordingReader(zip);
  const store = new ZipRangeStore(reader);
  expect(await store.get('/absent' as AbsolutePath)).toBeUndefined();
  reader.reads.length = 0;
  return { store, reads: reader.reads };
}

afterEach(() => vi.unstubAllGlobals());

describe('ZipRangeStore', () => {
  it.each([
    ['as long as the central record', { localExtra: 8, centralExtra: 8 }],
    ['shorter than the central record (a zip64 offset only there)', { localExtra: 0, centralExtra: 12 }],
  ])('reads an entry in one range when its local extra field is %s', async (_, extra) => {
    const { store, reads } = await openStore(storedZip(FILES, extra));
    for (const [name, data] of FILES) {
      expect(await store.get(`/${name}` as AbsolutePath)).toEqual(data);
    }
    expect(reads).toHaveLength(FILES.length);
  });

  it('reads the rest when the local extra field is longer than the central record says', async () => {
    const { store, reads } = await openStore(storedZip(FILES, { localExtra: 20, centralExtra: 0 }));
    expect(await store.get('/x/c/1' as AbsolutePath)).toEqual(FILES[2][1]);
    expect(reads).toHaveLength(2);
  });

  it('reads ranges of an entry, its header once', async () => {
    const { store, reads } = await openStore(storedZip(FILES, { localExtra: 4, centralExtra: 16 }));
    const key = '/x/c/1' as AbsolutePath;
    const data = FILES[2][1];
    expect(await store.getRange(key, { offset: 10, length: 5 })).toEqual(data.slice(10, 15));
    expect(await store.getRange(key, { suffixLength: 7 })).toEqual(data.slice(-7));
    expect(reads).toHaveLength(3);
    expect(await store.getRange('/absent' as AbsolutePath, { offset: 0, length: 1 })).toBeUndefined();
  });

  it('turns entries asked for together into one GET through RangeGetReader', async () => {
    const zip = storedZip(FILES);
    const ranges: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string>).Range;
      ranges.push(range);
      const [a, b] = range.replace('bytes=', '').split('-').map(Number);
      return new Response(zip.slice(a, Math.min(b + 1, zip.length)), {
        status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${zip.length}` },
      });
    }));
    const store = new ZipRangeStore(new RangeGetReader('https://bucket.example/store.zip'));
    await store.get('/zarr.json' as AbsolutePath);
    ranges.length = 0;
    const [first, second] = await Promise.all([store.get('/x/c/0' as AbsolutePath), store.get('/x/c/1' as AbsolutePath)]);
    expect(first).toEqual(FILES[1][1]);
    expect(second).toEqual(FILES[2][1]);
    expect(ranges).toHaveLength(1);
  });
});
