import { describe, expect, it } from "vitest";
import { createRng, rngFrom, type RngState } from "../src/rng.ts";
import fixture from "./fixtures/rng-seed42.json" with { type: "json" };

/** Independent reference sfc32 (PractRand's algorithm, as in bryc's widely used JS port). */
function referenceSfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
}

describe("sfc32 sequence snapshot (M0-02 accept)", () => {
  it("the first 5 values for seed 42 match the frozen fixture", () => {
    const rng = createRng(42);
    expect(rng.state()).toEqual(fixture.initialState);
    expect(Array.from({ length: 5 }, () => rng.next())).toEqual(fixture.u32);
  });

  it("floats and ints for seed 42 match the frozen fixture", () => {
    const f = createRng(42);
    expect(Array.from({ length: 5 }, () => f.float())).toEqual(fixture.floats);
    const i = createRng(42);
    expect(Array.from({ length: 5 }, () => i.int(100))).toEqual(fixture.int100);
  });

  it("the core step is exactly sfc32 (matches an independent reference implementation)", () => {
    const states: RngState[] = [
      [0, 0, 0, 1],
      [0xdeadbeef, 0x12345678, 0x9abcdef0, 7],
      fixture.initialState as RngState,
      [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff],
    ];
    for (const s of states) {
      const ours = rngFrom(s);
      const ref = referenceSfc32(...s);
      for (let k = 0; k < 1000; k++) expect(ours.next()).toBe(ref());
    }
  });
});

describe("createRng", () => {
  it("is deterministic per seed and distinct across nearby seeds", () => {
    const seq = (seed: number | string) => {
      const r = createRng(seed);
      return Array.from({ length: 8 }, () => r.next());
    };
    expect(seq(7)).toEqual(seq(7));
    expect(seq("room-ABCD")).toEqual(seq("room-ABCD"));
    const firsts = new Set<number>();
    for (let s = 0; s < 1000; s++) firsts.add(createRng(s).next());
    expect(firsts.size).toBe(1000);
    expect(seq(1)).not.toEqual(seq(-1));
    expect(seq(2 ** 40)).not.toEqual(seq(0));
    expect(seq(0.5)).not.toEqual(seq(0));
    expect(seq("42")).not.toEqual(seq(42));
    expect(seq("")).toEqual(seq(""));
  });

  it("rejects non-finite seeds", () => {
    expect(() => createRng(Number.NaN)).toThrow(RangeError);
    expect(() => createRng(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("Rng methods", () => {
  it("next() yields u32 and float() yields [0, 1)", () => {
    const r = createRng(1);
    for (let k = 0; k < 10_000; k++) {
      const u = r.next();
      expect(Number.isInteger(u) && u >= 0 && u < 2 ** 32).toBe(true);
      const f = r.float();
      expect(f >= 0 && f < 1).toBe(true);
    }
  });

  it("int(n) stays in range and is roughly uniform (chi-square)", () => {
    const r = createRng(99);
    const n = 10;
    const draws = 100_000;
    const counts = new Array<number>(n).fill(0);
    for (let k = 0; k < draws; k++) {
      const v = r.int(n);
      expect(v >= 0 && v < n && Number.isInteger(v)).toBe(true);
      counts[v] = (counts[v] as number) + 1;
    }
    const expected = draws / n;
    const chi2 = counts.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(27.88); // df = 9, p = 0.001
  });

  it("int() handles the extremes and rejects bad bounds", () => {
    const r = createRng(3);
    expect(r.int(1)).toBe(0);
    const big = r.int(2 ** 32);
    expect(big >= 0 && big < 2 ** 32).toBe(true);
    // n just above 2^31 forces frequent rejection; results must stay in range.
    for (let k = 0; k < 1000; k++) expect(r.int(2 ** 31 + 1)).toBeLessThanOrEqual(2 ** 31);
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 32 + 1]) {
      expect(() => r.int(bad)).toThrow(RangeError);
    }
  });

  it("bool(p) respects its probability", () => {
    const r = createRng(5);
    expect(Array.from({ length: 100 }, () => r.bool(0)).some(Boolean)).toBe(false);
    expect(Array.from({ length: 100 }, () => r.bool(1)).every(Boolean)).toBe(true);
    const heads = Array.from({ length: 20_000 }, () => r.bool()).filter(Boolean).length;
    expect(heads).toBeGreaterThan(9_500);
    expect(heads).toBeLessThan(10_500);
  });

  it("pick() returns members, covers all of them, and throws on empty", () => {
    const r = createRng(11);
    const items = ["a", "b", "c", "d"] as const;
    const seen = new Set<string>();
    for (let k = 0; k < 200; k++) {
      const v = r.pick(items);
      expect(items).toContain(v);
      seen.add(v);
    }
    expect(seen.size).toBe(4);
    expect(() => r.pick([])).toThrow(RangeError);
  });

  it("shuffle() returns a new permutation, leaves the input alone, and is uniform", () => {
    const r = createRng(12);
    const input = Object.freeze([1, 2, 3]);
    const counts = new Map<string, number>();
    for (let k = 0; k < 60_000; k++) {
      const out = r.shuffle(input);
      expect(out).not.toBe(input);
      expect([...out].sort()).toEqual([1, 2, 3]);
      counts.set(out.join(""), (counts.get(out.join("")) ?? 0) + 1);
    }
    expect(input).toEqual([1, 2, 3]);
    expect(counts.size).toBe(6);
    for (const c of counts.values()) expect(Math.abs(c - 10_000)).toBeLessThan(500);
    expect(r.shuffle([])).toEqual([]);
  });
});

describe("fork(label)", () => {
  it("does not advance the parent and is deterministic per label", () => {
    const a = createRng(42);
    const b = createRng(42);
    const child1 = a.fork("bots");
    expect(a.state()).toEqual(b.state());
    const child2 = b.fork("bots");
    expect(Array.from({ length: 10 }, () => child1.next())).toEqual(
      Array.from({ length: 10 }, () => child2.next()),
    );
  });

  it("different labels, and different parent states, give different streams", () => {
    const parent = createRng(42);
    const seq = (r: ReturnType<typeof createRng>) => Array.from({ length: 10 }, () => r.next());
    const bots = seq(parent.fork("bots"));
    expect(seq(parent.fork("audience"))).not.toEqual(bots);
    expect(seq(createRng(42))).not.toEqual(bots); // the child is not the parent stream
    parent.next();
    expect(seq(parent.fork("bots"))).not.toEqual(bots);
  });

  it("consuming a child leaves the parent untouched", () => {
    const parent = createRng(8);
    const before = parent.state();
    const child = parent.fork("x");
    for (let k = 0; k < 100; k++) child.next();
    expect(parent.state()).toEqual(before);
  });
});

describe("state() / rngFrom()", () => {
  it("round-trips through JSON and continues the exact sequence", () => {
    const original = createRng("snapshot");
    for (let k = 0; k < 37; k++) original.next();
    const restored = rngFrom(JSON.parse(JSON.stringify(original.state())) as RngState);
    for (let k = 0; k < 1000; k++) expect(restored.next()).toBe(original.next());
  });

  it("state() is a copy and does not advance", () => {
    const r = createRng(1);
    const s = r.state();
    s[0] = 123;
    expect(r.state()).not.toEqual(s);
    expect(r.state()).toEqual(r.state());
    expect(r.state().every((w) => Number.isInteger(w) && w >= 0 && w < 2 ** 32)).toBe(true);
  });

  it("rejects malformed states", () => {
    for (const bad of [
      [1, 2, 3],
      [1, 2, 3, 4, 5],
      [1, 2, 3, -1],
      [1, 2, 3, 2 ** 32],
      [1, 2, 3, 0.5],
      "nope",
    ]) {
      expect(() => rngFrom(bad as never)).toThrow(TypeError);
    }
  });
});
