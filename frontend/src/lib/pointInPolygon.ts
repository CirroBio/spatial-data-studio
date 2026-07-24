// Ray-casting point-in-polygon test for one ring (array of [x,y] vertices).
function inRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Row indices of the `numRows` points (a flat stride-2-or-3 [x,y,(z)] buffer, as
 * produced by useArrowPositions) that fall inside the union of `rings`. Rings and
 * points must share the same 2D coordinate space; the z of a 3-stride buffer is
 * ignored (callers that need a 3D→screen projection pre-project into a stride-2
 * screen buffer and pass screen-space rings). */
export function indicesInRings(coords: Float32Array, numRows: number, rings: [number, number][][]): number[] {
  const usable = rings.filter((r) => r.length >= 3);
  if (!usable.length || numRows === 0) return [];
  const stride = coords.length / numRows;
  const out: number[] = [];
  for (let i = 0; i < numRows; i++) {
    const x = coords[i * stride];
    const y = coords[i * stride + 1];
    if (usable.some((r) => inRing(x, y, r))) out.push(i);
  }
  return out;
}

/** Count of points inside the union of `rings` (see indicesInRings). */
export function countPointsInRings(coords: Float32Array, numRows: number, rings: [number, number][][]): number {
  return indicesInRings(coords, numRows, rings).length;
}
