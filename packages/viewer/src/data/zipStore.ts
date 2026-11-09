// A zarr store over a `.zarr.zip` read by range. Checkpoints are ZIP_STORED, so each
// zarr chunk is one entry whose bytes follow its local header unchanged.
//
// zarrita's own ZipFileStore reads an entry's 30-byte local header first and its bytes
// second: two dependent requests per chunk, and the coalescing reader then downloads the
// stretch between a whole array's headers twice. This store reads header and bytes in one
// range, so the chunks of an array requested together become a few large GETs.
import type { AbsolutePath, AsyncReadable, RangeQuery } from '@zarrita/storage';
import { unzip, type Reader, type ZipEntry } from 'unzipit';

const LOCAL_HEADER_BYTES = 30;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const STORED = 0;

export class ZipRangeStore implements Required<AsyncReadable> {
  private readonly entries: Promise<Record<string, ZipEntry>>;
  // Where each entry's bytes start, once its local header has been read.
  private readonly dataStarts = new Map<string, Promise<number>>();

  constructor(private readonly reader: Reader) {
    this.entries = unzip(reader).then((info) => info.entries);
  }

  async get(key: AbsolutePath): Promise<Uint8Array | undefined> {
    const entry = (await this.entries)[key.slice(1)];
    if (!entry) return undefined;
    if (entry.compressionMethod !== STORED) return new Uint8Array(await entry.arrayBuffer());
    // The local header's extra field usually matches the central directory's in length,
    // or is shorter (a zip64 offset is only in the central record). Read that much; a
    // longer one costs a second read for the tail.
    const { relativeOffsetOfLocalHeader: at, extraFieldLength } = rawEntry(entry);
    const guess = LOCAL_HEADER_BYTES + entry.nameBytes.length + extraFieldLength + entry.compressedSize;
    const bytes = await this.reader.read(at, guess);
    const start = dataStart(bytes, key);
    const end = start + entry.compressedSize;
    if (end <= bytes.length) return bytes.subarray(start, end);
    const tail = await this.reader.read(at + bytes.length, end - bytes.length);
    const whole = new Uint8Array(entry.compressedSize);
    whole.set(bytes.subarray(start));
    whole.set(tail, bytes.length - start);
    return whole;
  }

  async getRange(key: AbsolutePath, range: RangeQuery): Promise<Uint8Array | undefined> {
    const entry = (await this.entries)[key.slice(1)];
    if (!entry) return undefined;
    if (entry.compressionMethod !== STORED) {
      const bytes = new Uint8Array(await entry.arrayBuffer());
      return 'suffixLength' in range
        ? bytes.slice(-range.suffixLength)
        : bytes.slice(range.offset, range.offset + range.length);
    }
    const start = await this.dataStartOf(key, entry);
    return 'suffixLength' in range
      ? this.reader.read(start + entry.compressedSize - range.suffixLength, range.suffixLength)
      : this.reader.read(start + range.offset, range.length);
  }

  // A sharded image reads many ranges of one entry; its header is read once for all.
  private dataStartOf(key: AbsolutePath, entry: ZipEntry): Promise<number> {
    let start = this.dataStarts.get(key);
    if (!start) {
      const { relativeOffsetOfLocalHeader: at, extraFieldLength } = rawEntry(entry);
      start = this.reader.read(at, LOCAL_HEADER_BYTES + entry.nameBytes.length + extraFieldLength)
        .then((header) => at + dataStart(header, key));
      this.dataStarts.set(key, start);
      start.catch(() => this.dataStarts.delete(key));
    }
    return start;
  }
}

// unzipit keeps an entry's offset in the zip private; zarrita's ZipFileStore reads the
// same field. The version is pinned (package.json) so the shape can't move under us.
function rawEntry(entry: ZipEntry): { relativeOffsetOfLocalHeader: number; extraFieldLength: number } {
  const raw = entry['_rawEntry'];
  if (typeof raw?.relativeOffsetOfLocalHeader !== 'number') {
    throw new Error('This version of unzipit does not expose zip entry offsets.');
  }
  return raw;
}

// Offset of an entry's bytes from the start of its local header, read from the header.
function dataStart(header: Uint8Array, key: string): number {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length < LOCAL_HEADER_BYTES || view.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`No zip local header where the central directory places ${key}.`);
  }
  return LOCAL_HEADER_BYTES + view.getUint16(26, true) + view.getUint16(28, true);
}
