/**
 * A seeded generator, so a seeded mailbox is reproducible.
 *
 * The same algorithm `@daak/adapter-mock` uses, and for the same reason: a
 * performance number is only comparable if the corpus behind it is identical,
 * and "identical" has to survive a different machine and a different day.
 * `Math.random()` would make every measurement a one-off.
 */
export interface Random {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, bound). */
  int(bound: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Zipf-like: index 0 is commonest, the tail is long. */
  zipf(size: number): number;
}

export const createRandom = (seed: number): Random => {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (bound: number): number => (bound <= 0 ? 0 : Math.floor(next() * bound));

  return {
    next,
    int,
    chance: (probability) => next() < probability,
    pick<T>(items: readonly T[]): T {
      const value = items[int(items.length)];
      // `noUncheckedIndexedAccess` is right to insist: an empty array has no
      // element to pick, and returning `undefined` from `pick` would push the
      // problem into every caller.
      if (value === undefined) throw new Error("pick from an empty array");
      return value;
    },
    /**
     * Zipf without the exact normalisation.
     *
     * Sampling `size ** u` gives a distribution close enough to Zipf for a
     * corpus generator and costs one multiply — the property that matters is
     * that a few values dominate and the tail is long, not the exact exponent.
     */
    zipf(size) {
      if (size <= 1) return 0;
      const value = Math.floor(size ** next()) - 1;
      return value < 0 ? 0 : value >= size ? size - 1 : value;
    },
  };
};
