// Symmetric eigenproblems for PCA.
import { gaussian, type Random } from './random';

// Lanczos steps per wanted eigenpair.
const LANCZOS_FACTOR = 8;

/** The `count` largest eigenvalues of a symmetric positive semi-definite row-major matrix
 * and their eigenvectors (row-major size × count), by Lanczos with full
 * reorthogonalization: Rayleigh–Ritz on a Krylov space of LANCZOS_FACTOR × count
 * dimensions, or of every dimension when the matrix is no larger, which is exact. */
export function leadingEigenpairs(a: Float64Array, size: number, count: number, random: Random) {
  const steps = Math.min(size, LANCZOS_FACTOR * count);
  let trace = 0;
  for (let i = 0; i < size; i++) trace += a[i * size + i];
  const basis = new Float64Array(steps * size);
  const alpha = new Float64Array(steps);
  const beta = new Float64Array(steps);
  const w = new Float64Array(size);
  const orthogonalize = (upTo: number) => {
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j <= upTo; j++) {
        let dot = 0;
        for (let r = 0; r < size; r++) dot += basis[j * size + r] * w[r];
        for (let r = 0; r < size; r++) w[r] -= dot * basis[j * size + r];
      }
    }
  };
  const normalizeInto = (row: number) => {
    let norm = 0;
    for (let r = 0; r < size; r++) norm += w[r] * w[r];
    norm = Math.sqrt(norm);
    for (let r = 0; r < size; r++) basis[row * size + r] = w[r] / norm;
    return norm;
  };
  for (let r = 0; r < size; r++) w[r] = gaussian(random);
  normalizeInto(0);
  for (let i = 0; i < steps; i++) {
    for (let r = 0; r < size; r++) {
      let sum = 0;
      for (let c = 0; c < size; c++) sum += a[r * size + c] * basis[i * size + c];
      w[r] = sum;
    }
    for (let r = 0; r < size; r++) alpha[i] += basis[i * size + r] * w[r];
    if (i === steps - 1) break;
    orthogonalize(i);
    let norm = 0;
    for (let r = 0; r < size; r++) norm += w[r] * w[r];
    if (Math.sqrt(norm) > 1e-10 * trace) {
      beta[i] = normalizeInto(i + 1);
      continue;
    }
    // The Krylov space is invariant (the matrix has lower rank than `steps`): carry on
    // from a fresh direction, which leaves the tridiagonal matrix block-diagonal.
    for (let r = 0; r < size; r++) w[r] = gaussian(random);
    orthogonalize(i);
    normalizeInto(i + 1);
  }
  const ritz = tridiagonalEigen(alpha, beta);
  const vectors = new Float64Array(size * count);
  for (let i = 0; i < steps; i++) {
    for (let t = 0; t < count; t++) {
      const s = ritz.vectors[i * steps + t];
      for (let r = 0; r < size; r++) vectors[r * count + t] += basis[i * size + r] * s;
    }
  }
  return { values: ritz.values.subarray(0, count), vectors };
}

/** Eigen-decomposition of a symmetric tridiagonal matrix (diagonal `d`, off-diagonal `e`,
 * e[i] joining i and i + 1) by the implicit QL method: EISPACK tql2 as transcribed in
 * JAMA. Eigenvalues come back in descending order; eigenvector t is column t of the
 * row-major `vectors`. */
function tridiagonalEigen(diagonal: Float64Array, offDiagonal: Float64Array) {
  const n = diagonal.length;
  const d = Float64Array.from(diagonal);
  const e = new Float64Array(n);
  e.set(offDiagonal.subarray(0, n - 1));
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  let f = 0;
  let tst1 = 0;
  for (let l = 0; l < n; l++) {
    tst1 = Math.max(tst1, Math.abs(d[l]) + Math.abs(e[l]));
    let m = l;
    while (m < n && Math.abs(e[m]) > Number.EPSILON * tst1) m++;
    if (m > l) {
      do {
        let g = d[l];
        let p = (d[l + 1] - g) / (2 * e[l]);
        let r = Math.hypot(p, 1);
        if (p < 0) r = -r;
        d[l] = e[l] / (p + r);
        d[l + 1] = e[l] * (p + r);
        const dl1 = d[l + 1];
        let h = g - d[l];
        for (let i = l + 2; i < n; i++) d[i] -= h;
        f += h;
        p = d[m];
        let c = 1;
        let c2 = c;
        let c3 = c;
        const el1 = e[l + 1];
        let s = 0;
        let s2 = 0;
        for (let i = m - 1; i >= l; i--) {
          c3 = c2;
          c2 = c;
          s2 = s;
          g = c * e[i];
          h = c * p;
          r = Math.hypot(p, e[i]);
          e[i + 1] = s * r;
          s = e[i] / r;
          c = p / r;
          p = c * d[i] - s * g;
          d[i + 1] = h + s * (c * g + s * d[i]);
          for (let k = 0; k < n; k++) {
            const vk = k * n;
            h = v[vk + i + 1];
            v[vk + i + 1] = s * v[vk + i] + c * h;
            v[vk + i] = c * v[vk + i] - s * h;
          }
        }
        p = (-s * s2 * c3 * el1 * e[l]) / dl1;
        e[l] = s * p;
        d[l] = c * p;
      } while (Math.abs(e[l]) > Number.EPSILON * tst1);
    }
    d[l] += f;
    e[l] = 0;
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => d[b] - d[a]);
  const vectors = new Float64Array(n * n);
  order.forEach((i, t) => {
    for (let k = 0; k < n; k++) vectors[k * n + t] = v[k * n + i];
  });
  return { values: Float64Array.from(order, (i) => d[i]), vectors };
}
