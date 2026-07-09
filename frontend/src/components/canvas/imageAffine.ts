// Level-0 pixel <-> world mapping via the 6-float affine from image_info /
// snapshot render.image.pixel_to_world: world_x = a*px + b*py + c,
// world_y = d*px + e*py + f. Shared by the live image-tile layer and the
// read-only snapshot viewer so both place BitmapLayers the same way.
export type Affine = [number, number, number, number, number, number];

export const wx = (m: Affine, px: number, py: number) => m[0] * px + m[1] * py + m[2];
export const wy = (m: Affine, px: number, py: number) => m[3] * px + m[4] * py + m[5];

// Inverse affine: world (x, y) -> level-0 pixel (px, py).
export function worldToPixel(m: Affine, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d || 1e-9;
  const dx = x - c;
  const dy = y - f;
  return [(e * dx - b * dy) / det, (-d * dx + a * dy) / det];
}

// BitmapLayer quad bounds map to the image's texture corners in the order
// [bottom-left, top-left, top-right, bottom-right]; "top" is image row 0.
type Corner = [number, number];
export function quad(m: Affine, px0: number, py0: number, px1: number, py1: number):
  [Corner, Corner, Corner, Corner] {
  return [
    [wx(m, px0, py1), wy(m, px0, py1)], // bottom-left  (col0, rowN)
    [wx(m, px0, py0), wy(m, px0, py0)], // top-left     (col0, row0)
    [wx(m, px1, py0), wy(m, px1, py0)], // top-right    (colN, row0)
    [wx(m, px1, py1), wy(m, px1, py1)], // bottom-right (colN, rowN)
  ];
}
