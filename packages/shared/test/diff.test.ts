import { describe, expect, it } from "vitest";
import { apply, diff, PatchError, type Json } from "../src/diff.ts";
import type { PatchOp } from "../src/protocol.ts";
import { createRng, type Rng } from "../src/rng.ts";

/** Awkward keys on purpose: prototype names, numeric-looking strings, empty and unicode. */
const KEYS = [
  "a",
  "b",
  "c",
  "id",
  "phase",
  "0",
  "1",
  "",
  "__proto__",
  "constructor",
  "toString",
  "é",
  "k 1",
];

function randomScalar(rng: Rng): Json {
  switch (rng.int(7)) {
    case 0:
      return null;
    case 1:
      return rng.bool();
    case 2:
      return rng.int(10) - 5;
    case 3:
      return (rng.float() - 0.5) * 1e6;
    case 4:
      return rng.pick(["", "x", "y", "hello", "üñí", "🎲", 'a"b', "0"]);
    case 5:
      return rng.int(2 ** 32);
    default:
      return rng.pick(["lobby", "play", "reveal"]);
  }
}

function randomJson(rng: Rng, depth: number): Json {
  if (depth <= 0 || rng.int(3) === 0) return randomScalar(rng);
  if (rng.bool()) {
    return Array.from({ length: rng.int(6) }, () => randomJson(rng, depth - 1));
  }
  const obj: Record<string, Json> = {};
  const n = rng.int(6);
  for (let i = 0; i < n; i++) {
    Object.defineProperty(obj, rng.pick(KEYS), {
      value: randomJson(rng, depth - 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return obj;
}

/** A structurally similar `next`: copies `prev` and makes a few local edits (the realistic case). */
function mutate(rng: Rng, value: Json, depth: number): Json {
  if (rng.int(8) === 0) return randomJson(rng, depth);
  if (Array.isArray(value)) {
    const out = value.map((v) => (rng.int(3) === 0 ? mutate(rng, v, depth - 1) : v));
    const edit = rng.int(4);
    if (edit === 0) out.push(randomJson(rng, depth - 1));
    if (edit === 1 && out.length > 0) out.pop();
    if (edit === 2 && out.length > 0) out.splice(rng.int(out.length), 1);
    return out;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) {
      if (rng.int(6) === 0) continue; // delete key
      Object.defineProperty(out, k, {
        value: rng.int(3) === 0 ? mutate(rng, v, depth - 1) : v,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (rng.int(3) === 0) {
      Object.defineProperty(out, rng.pick(KEYS), {
        value: randomJson(rng, depth - 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return rng.bool() ? value : randomScalar(rng);
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const child of Object.values(v)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

const clone = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

// 10k-pair property run; the 5 s default is too tight under full-suite parallel load.
describe("diff/apply property (M0-02 accept)", { timeout: 60_000 }, () => {
  it("apply(prev, diff(prev, next)) deep-equals next over 10k random JSON pairs", () => {
    const rng = createRng("diff-property");
    let patched = 0;
    for (let k = 0; k < 10_000; k++) {
      const prev = randomJson(rng, 5);
      const next = k % 3 === 0 ? randomJson(rng, 5) : mutate(rng, prev, 5);
      const prevSnapshot = clone(prev);
      deepFreeze(prev);
      deepFreeze(next);

      const ops = diff(prev, next);
      if (ops.length > 0) patched++;
      const out = apply(prev, ops);
      expect(out).toEqual(next);
      // Over the wire: ops survive JSON encoding and still apply.
      expect(apply(clone(prev), clone(ops) as PatchOp[])).toEqual(next);
      // prev was not mutated (also enforced by the freeze).
      expect(prev).toEqual(prevSnapshot);
      // Equal inputs give no ops.
      expect(diff(next, clone(next))).toEqual([]);
    }
    expect(patched).toBeGreaterThan(7_000);
  });
});

describe("diff", () => {
  it("returns [] for equal documents and skips shared subtrees by reference", () => {
    const shared = { big: [1, 2, 3] };
    expect(diff({ a: 1, s: shared }, { a: 1, s: shared })).toEqual([]);
    expect(diff(Number.NaN, Number.NaN)).toEqual([]);
    expect(diff(null, null)).toEqual([]);
  });

  it("emits minimal ops for typical view changes", () => {
    const prev = { phase: "play", deadline: 1000, scores: { p1: 1, p2: 2 }, log: ["a"] };
    const next = { phase: "reveal", deadline: null, scores: { p1: 3, p2: 2 }, log: ["a", "b"] };
    expect(diff(prev, next)).toEqual([
      { op: "set", path: ["phase"], value: "reveal" },
      { op: "set", path: ["deadline"], value: null },
      { op: "set", path: ["scores", "p1"], value: 3 },
      { op: "set", path: ["log", 1], value: "b" },
    ]);
  });

  it("deletes removed keys and trailing array elements (highest index first)", () => {
    expect(diff({ a: 1, b: 2 }, { a: 1 })).toEqual([{ op: "del", path: ["b"] }]);
    const item = (n: number) => ({ id: n, text: "a fairly long line of chat text" });
    expect(diff([item(1), item(2), item(3), item(4)], [item(1), item(2)])).toEqual([
      { op: "del", path: [3] },
      { op: "del", path: [2] },
    ]);
    // Short arrays are cheaper to resend whole.
    expect(diff([1, 2, 3, 4], [1, 2])).toEqual([{ op: "set", path: [], value: [1, 2] }]);
  });

  it("treats undefined object values as absent (JSON semantics)", () => {
    expect(diff({ a: 1, b: undefined }, { a: 1 })).toEqual([]);
    expect(diff({ a: 1 }, { a: 1, b: undefined })).toEqual([]);
    expect(diff({ a: 1 }, { a: undefined })).toEqual([{ op: "del", path: ["a"] }]);
    expect(diff({ a: undefined }, { a: 2 })).toEqual([{ op: "set", path: ["a"], value: 2 }]);
  });

  it("replaces on type changes, including at the root", () => {
    expect(diff({ a: [1] }, { a: { 0: 1 } })).toEqual([
      { op: "set", path: ["a"], value: { 0: 1 } },
    ]);
    expect(diff([1], { x: 1 })).toEqual([{ op: "set", path: [], value: { x: 1 } }]);
    expect(diff(1, "1")).toEqual([{ op: "set", path: [], value: "1" }]);
  });

  it("sends a whole array when element-wise ops would be bigger on the wire", () => {
    const prev = [1, 2, 3, 4, 5];
    const next = [0, 1, 2, 3, 4, 5]; // insertion at the front shifts everything
    expect(diff(prev, next)).toEqual([{ op: "set", path: [], value: next }]);
    expect(diff({ list: prev }, { list: next })).toEqual([
      { op: "set", path: ["list"], value: next },
    ]);
    // One changed field inside big elements stays a small nested patch.
    const big = (ready: boolean) =>
      Array.from({ length: 4 }, (_, i) => ({ id: `player-${i}`, name: "x".repeat(40), ready }));
    const ops = diff(big(false), big(true));
    expect(ops).toHaveLength(4);
    expect(ops.every((op) => op.path.length === 2 && op.path[1] === "ready")).toBe(true);
  });

  it("never reads inherited properties: a '__proto__' key is an ordinary key", () => {
    const withProto = JSON.parse('{"__proto__": {"x": 1}, "a": 1}') as Record<string, unknown>;
    const ops = diff({ a: 1 }, withProto);
    expect(ops).toEqual([{ op: "set", path: ["__proto__"], value: { x: 1 } }]);
    const out = apply<Record<string, unknown>>({ a: 1 }, ops);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined(); // no prototype pollution
    expect(diff(withProto, { a: 1 })).toEqual([{ op: "del", path: ["__proto__"] }]);
  });
});

describe("apply", () => {
  it("does not mutate its input and shares unchanged subtrees", () => {
    const prev = deepFreeze({ keep: { deep: [1, 2] }, change: { n: 1 } });
    const out = apply<typeof prev>(prev, [{ op: "set", path: ["change", "n"], value: 2 }]);
    expect(out).toEqual({ keep: { deep: [1, 2] }, change: { n: 2 } });
    expect(out.keep).toBe(prev.keep);
    expect(out).not.toBe(prev);
    expect(prev.change.n).toBe(1);
  });

  it("applies many ops to one container while copying it once", () => {
    const prev = deepFreeze({ list: [0, 0, 0] });
    const out = apply<{ list: number[] }>(prev, [
      { op: "set", path: ["list", 0], value: 1 },
      { op: "set", path: ["list", 1], value: 2 },
      { op: "set", path: ["list", 3], value: 4 },
      { op: "del", path: ["list", 2] },
    ]);
    expect(out.list).toEqual([1, 2, 4]);
  });

  it("does not mutate values inserted by an earlier op", () => {
    const inserted = deepFreeze({ x: 1 });
    const out = apply<{ o: { x: number } }>({}, [
      { op: "set", path: ["o"], value: inserted },
      { op: "set", path: ["o", "x"], value: 2 },
    ]);
    expect(out.o.x).toBe(2);
    expect(inserted.x).toBe(1);
  });

  it("replaces the root with an empty path", () => {
    expect(apply({ a: 1 }, [{ op: "set", path: [], value: [1] }])).toEqual([1]);
    expect(apply(5, [])).toBe(5);
  });

  it.each<[string, unknown, PatchOp[]]>([
    ["deleting the root", { a: 1 }, [{ op: "del", path: [] }]],
    ["a missing intermediate key", { a: 1 }, [{ op: "set", path: ["b", "c"], value: 1 }]],
    ["walking into a scalar", { a: 1 }, [{ op: "set", path: ["a", "b"], value: 1 }]],
    ["a scalar root", 5, [{ op: "set", path: ["a"], value: 1 }]],
    ["an array index past the end", [1], [{ op: "set", path: [2], value: 1 }]],
    ["a negative array index", [1], [{ op: "set", path: [-1], value: 1 }]],
    ["a string index into an array", [1], [{ op: "set", path: ["0"], value: 1 }]],
    ["a number key into an object", { 0: 1 }, [{ op: "set", path: [0], value: 1 }]],
    ["deleting a missing key", { a: 1 }, [{ op: "del", path: ["b"] }]],
    ["deleting past the end of an array", [1], [{ op: "del", path: [1] }]],
    ["deleting with a number key on an object", { a: 1 }, [{ op: "del", path: [0] }]],
    ["reading past the end of an array", [[1]], [{ op: "set", path: [3, 0], value: 1 }]],
    ["reading a number key on an object", { a: {} }, [{ op: "set", path: [0, "x"], value: 1 }]],
    ["an unknown op", { a: 1 }, [{ op: "move", path: ["a"] } as unknown as PatchOp]],
    ["a non-array path", { a: 1 }, [{ op: "set", path: "a", value: 1 } as unknown as PatchOp]],
  ])("throws PatchError on %s", (_name, doc, ops) => {
    expect(() => apply(doc, ops)).toThrow(PatchError);
  });

  it("PatchError reports the failing op index", () => {
    try {
      apply({ a: 1 }, [
        { op: "set", path: ["a"], value: 2 },
        { op: "del", path: ["zzz"] },
      ]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PatchError);
      expect((err as PatchError).opIndex).toBe(1);
      expect((err as PatchError).name).toBe("PatchError");
    }
  });
});
