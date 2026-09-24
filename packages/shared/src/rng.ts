/**
 * Seeded, serialisable pseudo-random numbers: Chris Doty-Humphrey's **sfc32** ("Small Fast
 * Counting", from PractRand). 128 bits of state, period ≥ 2^32 guaranteed by the counter word
 * (≈ 2^127 on average), passes PractRand/BigCrush, and uses only 32-bit integer ops, so it is
 * bit-for-bit identical on every JS engine.
 *
 * Game logic gets its randomness only from `ctx.rng` (SPEC §9.3 rule 1). The state is four
 * unsigned 32-bit integers, so it round-trips through JSON snapshots via {@link Rng.state}
 * and {@link rngFrom}.
 *
 * @module
 */

/** The full generator state: `[a, b, c, counter]`, each an unsigned 32-bit integer. */
export type RngState = [number, number, number, number];

/** A seeded sfc32 generator. Methods advance the state unless stated otherwise. */
export interface Rng {
  /** The next raw output: an unsigned 32-bit integer in `[0, 2^32)`. */
  next(): number;
  /** A float in `[0, 1)` with 32 bits of resolution. */
  float(): number;
  /**
   * A uniform integer in `[0, n)`, without modulo bias (rejection sampling).
   * @throws RangeError unless `n` is an integer in `[1, 2^32]`.
   */
  int(n: number): number;
  /** `true` with probability `p` (default 0.5). */
  bool(p?: number): boolean;
  /**
   * A uniformly chosen element.
   * @throws RangeError on an empty array.
   */
  pick<T>(items: readonly T[]): T;
  /** A new array with the items in uniformly random order (Fisher–Yates). The input is not modified. */
  shuffle<T>(items: readonly T[]): T[];
  /**
   * An independent child generator for a labelled sub-stream (e.g. `fork("bots")`). Does
   * **not** advance this generator: the same label at the same parent state always yields the
   * same child, and different labels yield unrelated streams.
   */
  fork(label: string): Rng;
  /** A copy of the current state (does not advance). Restore with {@link rngFrom}. */
  state(): RngState;
}

const TWO_POW_32 = 0x1_0000_0000;
/** Outputs discarded after seeding so nearby seeds decorrelate (PractRand uses 12 for sfc32). */
const WARMUP_ROUNDS = 12;

/**
 * Creates a generator from a seed. Integer seeds use their low 64 bits (so any safe integer,
 * including negatives, is distinct); strings and non-integer numbers are hashed. The same
 * seed always produces the same sequence.
 * @throws RangeError for `NaN` or infinite seeds.
 */
export function createRng(seed: number | string): Rng {
  let lo: number;
  let hi: number;
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) throw new RangeError(`createRng: seed must be finite, got ${seed}`);
    if (Number.isSafeInteger(seed)) {
      lo = seed >>> 0;
      hi = Math.floor(seed / TWO_POW_32) >>> 0;
    } else {
      [lo, hi] = hashString(`n:${seed}`);
    }
  } else {
    [lo, hi] = hashString(`s:${seed}`);
  }
  return seeded(lo, hi);
}

/**
 * Restores a generator from {@link Rng.state}. The restored generator continues the exact
 * sequence the original would have produced.
 * @throws TypeError unless `state` is an array of exactly four unsigned 32-bit integers.
 */
export function rngFrom(state: Readonly<RngState> | readonly number[]): Rng {
  if (
    !Array.isArray(state) ||
    state.length !== 4 ||
    !state.every((w) => Number.isInteger(w) && w >= 0 && w < TWO_POW_32)
  ) {
    throw new TypeError("rngFrom: state must be an array of four unsigned 32-bit integers");
  }
  return new Sfc32(state[0] as number, state[1] as number, state[2] as number, state[3] as number);
}

function seeded(lo: number, hi: number): Rng {
  // splitmix32 expands the 64-bit seed into three well-mixed words; the counter starts at 1.
  let s = (lo ^ fmix32((hi + 0x632be5ab) | 0)) | 0;
  const split = (): number => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
  const rng = new Sfc32(split(), split(), split(), 1);
  for (let i = 0; i < WARMUP_ROUNDS; i++) rng.next();
  return rng;
}

class Sfc32 implements Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(a: number, b: number, c: number, d: number) {
    this.a = a | 0;
    this.b = b | 0;
    this.c = c | 0;
    this.d = d | 0;
  }

  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  float(): number {
    return this.next() / TWO_POW_32;
  }

  int(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > TWO_POW_32) {
      throw new RangeError(`Rng.int: n must be an integer in [1, 2^32], got ${n}`);
    }
    // Reject the top partial bucket so every residue is equally likely.
    const limit = TWO_POW_32 - (TWO_POW_32 % n);
    let x = this.next();
    while (x >= limit) x = this.next();
    return x % n;
  }

  bool(p = 0.5): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("Rng.pick: cannot pick from an empty array");
    return items[this.int(items.length)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }

  fork(label: string): Rng {
    const [h1, h2] = hashString(`f:${label}`);
    const lo = (fmix32((this.a ^ h1) | 0) ^ this.c) >>> 0;
    const hi = (fmix32((this.b ^ h2) | 0) ^ fmix32((this.d + 0x2545f491) | 0)) >>> 0;
    return seeded(lo, hi);
  }

  state(): RngState {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }
}

/** murmur3's 32-bit finaliser: a fast avalanche mix. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A 64-bit string hash (two 32-bit lanes, cyrb53-style) over UTF-16 code units. */
function hashString(str: string): [number, number] {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x9e3779b1);
    h2 = Math.imul(h2 ^ ch, 0x5f356495);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b) ^ Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 0x85ebca6b) ^ Math.imul(h1 ^ (h1 >>> 13), 0xc2b2ae35);
  return [h1 >>> 0, h2 >>> 0];
}
