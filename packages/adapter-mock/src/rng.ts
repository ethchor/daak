/**
 * Seeded PRNG.
 *
 * Every non-deterministic choice this package makes goes through here. A
 * failing chaos test must reproduce from its seed alone — a mock server that
 * reaches for `Math.random()` produces failures nobody can debug, which is
 * worse than no fault injection at all.
 *
 * mulberry32: small, fast, and good enough for shuffling and coin flips. Not
 * for anything cryptographic, and nothing here is.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, boundExclusive). */
  int(boundExclusive: number): number;
  bool(probability: number): boolean;
  /** Fisher-Yates. Returns a new array; never mutates the input. */
  shuffle<T>(items: readonly T[]): T[];
}

export const createRng = (seed: number): Rng => {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (boundExclusive: number): number => Math.floor(next() * boundExclusive);

  return {
    next,
    int,
    bool: (probability) => next() < probability,
    shuffle<T>(items: readonly T[]): T[] {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = int(i + 1);
        const a = copy[i];
        const b = copy[j];
        if (a === undefined || b === undefined) continue;
        copy[i] = b;
        copy[j] = a;
      }
      return copy;
    },
  };
};

/** Turn a human-readable seed into a number, so tests can name their seeds. */
export const seedFrom = (text: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};
