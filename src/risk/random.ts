/**
 * Seeded PRNG (mulberry32).
 *
 * The random-signal benchmark and the maker-fill simulation both need randomness, and both need to be
 * reproducible: a benchmark that prints a different number every run cannot be used to decide anything, and a
 * test cannot assert on it. Math.random is unseedable, hence this.
 */
export type Rng = () => number;

export const createRng = (seed: number): Rng => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Ascending-sorted copy; used for percentile reporting of benchmark distributions. */
export const percentile = (sortedValues: number[], p: number): number =>
  sortedValues[Math.min(sortedValues.length - 1, Math.max(0, Math.floor(p * (sortedValues.length - 1))))];
