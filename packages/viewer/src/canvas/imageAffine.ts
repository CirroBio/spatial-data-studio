// Level-0 pixel <-> world mapping via the 6-float affine from image_info /
// snapshot render.image.pixel_to_world: world_x = a*px + b*py + c,
// world_y = d*px + e*py + f. Shared by the live image-tile layer and the
// read-only snapshot viewer so both place BitmapLayers the same way.
//
// The helpers taking `readonly number[]` read only the first six entries, so they take
// a row-major 3x3 ([[a, b, c], [d, e, f], [0, 0, 1]]) as well.
export type Affine = [number, number, number, number, number, number];

type Box = [number, number, number, number];

export const wx = (m: readonly number[], px: number, py: number) => m[0] * px + m[1] * py + m[2];
export const wy = (m: readonly number[], px: number, py: number) => m[3] * px + m[4] * py + m[5];

const determinant = ([a, b, , d, e]: readonly number[]) => a * e - b * d;

function inverseOver([a, b, c, d, e, f]: readonly number[], det: number): Affine {
  return [
    e / det, -b / det, (b * f - c * e) / det,
    -d / det, a / det, (c * d - a * f) / det,
  ];
}

/** The inverse of `m`, or null when `m` is singular. Callers decide what a singular
 * transform means: the data readers refuse it, the image layer substitutes. */
export function invertAffine(m: readonly number[]): Affine | null {
  const det = determinant(m);
  return det === 0 ? null : inverseOver(m, det);
}

// The inverse (world->pixel) affine as its own 6-float [A,B,C,D,E,F]
// (px = A*x+B*y+C, py = D*x+E*y+F). Used as a deck.gl layer modelMatrix so
// world-space layers (points, shapes, lasso) render in the image-pixel coordinate
// space the canvas adopts when an image is shown — the image itself then needs no
// modelMatrix and Viv's MultiscaleImageLayer selects tiles natively (DESIGN 9.4).
// Unlike `invertAffine` this never fails: a singular affine is inverted over a
// near-zero determinant, so the canvas always gets a finite modelMatrix.
export function worldToPixelAffine(m: Affine): Affine {
  return inverseOver(m, determinant(m) || 1e-9);
}

// Linear scale of an affine, sqrt(|det|) — for pixel_to_world this is world units per
// pixel, so 1/affineScale converts a world-unit point radius into the pixel-space frame.
export function affineScale(m: Affine): number {
  return Math.sqrt(Math.abs(determinant(m))) || 1;
}

/** `box` pushed through `m`, as the axis-aligned box of all four corners — the affine
 * may rotate, so two opposite corners would not bound the result (`bbox_aabb`). */
export function boxThrough(m: readonly number[], [x0, y0, x1, y1]: Box): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    xs.push(wx(m, x, y));
    ys.push(wy(m, x, y));
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function isIdentityAffine([a, b, c, d, e, f]: readonly number[]): boolean {
  return a === 1 && b === 0 && c === 0 && d === 0 && e === 1 && f === 0;
}

/** `m` applied in place to the points (xs[i], ys[i]) for every `stride`-th i —
 * `transform.apply_affine6_xy`. An interleaved [x0, y0, x1, y1, …] buffer is
 * `(m, xy, xy.subarray(1), 2)`. An identity leaves the coordinates untouched, so a
 * non-finite one is not turned into NaN by the `0 *` terms. */
export function applyAffineXy(
  m: readonly number[], xs: Float32Array | Float64Array, ys: Float32Array | Float64Array, stride = 1,
): void {
  if (isIdentityAffine(m)) return;
  const [a, b, c, d, e, f] = m;
  for (let i = 0; i < xs.length; i += stride) {
    const x = xs[i];
    const y = ys[i];
    xs[i] = a * x + b * y + c;
    ys[i] = d * x + e * y + f;
  }
}
