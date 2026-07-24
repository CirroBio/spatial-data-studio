// Level-0 pixel <-> world mapping via the 6-float affine from image_info /
// snapshot render.image.pixel_to_world: world_x = a*px + b*py + c,
// world_y = d*px + e*py + f. Shared by the live image-tile layer and the
// read-only snapshot viewer so both place BitmapLayers the same way.
export type Affine = [number, number, number, number, number, number];

export const wx = (m: Affine, px: number, py: number) => m[0] * px + m[1] * py + m[2];
export const wy = (m: Affine, px: number, py: number) => m[3] * px + m[4] * py + m[5];

// The inverse (world->pixel) affine as its own 6-float [A,B,C,D,E,F]
// (px = A*x+B*y+C, py = D*x+E*y+F). Used as a deck.gl layer modelMatrix so
// world-space layers (points, shapes, lasso) render in the image-pixel coordinate
// space the canvas adopts when an image is shown — the image itself then needs no
// modelMatrix and Viv's MultiscaleImageLayer selects tiles natively (DESIGN 9.4).
export function worldToPixelAffine(m: Affine): Affine {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d || 1e-9;
  return [
    e / det, -b / det, (b * f - e * c) / det,
    -d / det, a / det, (d * c - a * f) / det,
  ];
}

// Linear scale of an affine, sqrt(|det|) — for pixel_to_world this is world units per
// pixel, so 1/affineScale converts a world-unit point radius into the pixel-space frame.
export function affineScale(m: Affine): number {
  const [a, b, , d, e] = m;
  return Math.sqrt(Math.abs(a * e - b * d)) || 1;
}
