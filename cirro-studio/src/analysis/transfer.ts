/** The distinct ArrayBuffers behind every typed array in a message (found through plain
 * objects and arrays), for postMessage's transfer list. Listing a buffer twice throws, and
 * several arrays may view one buffer. */
export function transferables(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const visit = (v: unknown) => {
    if (typeof v !== 'object' || v === null) return;
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer) buffers.add(v.buffer);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    for (const item of Object.values(v)) visit(item);
  };
  visit(value);
  return [...buffers];
}
