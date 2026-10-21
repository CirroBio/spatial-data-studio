// Chebyshev coefficients for erfc (Numerical Recipes, 3rd ed., §6.2.2): relative error
// near machine precision over the whole positive axis, so tail p-values stay accurate.
const ERFC_COEFFICIENTS = [
  -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2, -9.561514786808631e-3,
  -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
  -1.624290004647e-6, 1.30365583558e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
  5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11, 2.394038e-12, -6.886027e-12,
  8.94487e-13, 3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15, -1.523e-15, -9.4e-17, 1.21e-16, -2.8e-17,
];

export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  let d = 0;
  let dd = 0;
  for (let j = ERFC_COEFFICIENTS.length - 1; j > 0; j--) {
    const previous = d;
    d = ty * d - dd + ERFC_COEFFICIENTS[j];
    dd = previous;
  }
  const value = t * Math.exp(-z * z + 0.5 * (ERFC_COEFFICIENTS[0] + ty * d) - dd);
  return x >= 0 ? value : 2 - value;
}

/** Upper tail of the standard normal, P(Z > z). */
export function normalSf(z: number): number {
  return 0.5 * erfc(z / Math.SQRT2);
}

/** Two-sided p-value of a z-score. */
export function twoSidedP(z: number): number {
  return erfc(Math.abs(z) / Math.SQRT2);
}

/** Benjamini–Hochberg adjusted p-values, as statsmodels' `multipletests(method='fdr_bh')`. */
export function benjaminiHochberg(pvals: ArrayLike<number>): Float64Array {
  const m = pvals.length;
  const order = Array.from({ length: m }, (_, i) => i).sort((a, b) => pvals[a] - pvals[b]);
  const adjusted = new Float64Array(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const i = order[rank - 1];
    running = Math.min(running, (pvals[i] * m) / rank);
    adjusted[i] = running;
  }
  return adjusted;
}

/** numpy's `round`: halves go to the even neighbour. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
