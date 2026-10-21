// Seeded randomness, so an analysis run twice on the same data gives the same answer.

export type Random = () => number;

/** mulberry32: a 32-bit-state generator of uniform numbers in [0, 1). */
export function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal draw (Box–Muller). */
export function gaussian(random: Random): number {
  const u = 1 - random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

export function randomInt(random: Random, below: number): number {
  return Math.floor(random() * below);
}

/** Fisher–Yates, in place. */
export function shuffle(values: Int32Array, random: Random): void {
  for (let i = values.length - 1; i > 0; i--) {
    const j = randomInt(random, i + 1);
    const t = values[i];
    values[i] = values[j];
    values[j] = t;
  }
}
