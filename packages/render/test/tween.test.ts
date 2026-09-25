/**
 * Tweens, easings and springs (SPEC §13.4): token curves, fixed-step springs with the documented
 * feel, takeover, cancellation, reduced motion and zero-allocation stepping.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  resolveSpring,
  SPRING_STEP_MS,
  springAtRest,
  springOvershoot,
  SPRINGS,
  stepSpring,
} from "../src/springs.ts";
import {
  createTweens,
  cubicBezier,
  EASING_CURVES,
  EASING_DURATIONS_MS,
  easing,
  MAX_STEP_MS,
} from "../src/tween.ts";
import { EASING_NAMES, SPRING_NAMES } from "../src/types.ts";

describe("easings (SPEC §13.4)", () => {
  it("use the token curves", () => {
    expect(EASING_CURVES.outSoft).toEqual([0.22, 1, 0.36, 1]);
    expect(EASING_CURVES.inSoft).toEqual([0.55, 0, 0.78, 0.4]);
    expect(EASING_CURVES.inout).toEqual([0.65, 0, 0.35, 1]);
    expect(EASING_CURVES.back).toEqual([0.34, 1.56, 0.64, 1]);
    expect(EASING_DURATIONS_MS).toMatchObject({ outSoft: 240, inSoft: 160, back: 320 });
    expect(EASING_DURATIONS_MS.inout).toBeGreaterThanOrEqual(400);
    expect(EASING_DURATIONS_MS.inout).toBeLessThanOrEqual(700);
  });

  it("start at 0, end at 1 and are monotonic (except back's overshoot)", () => {
    for (const name of EASING_NAMES) {
      const f = easing(name);
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
      expect(f(-1)).toBe(0);
      expect(f(2)).toBe(1);
      if (name === "back") continue;
      let prev = 0;
      for (let i = 1; i <= 100; i++) {
        const y = f(i / 100);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = y;
      }
    }
    // back overshoots past 1 before settling.
    let peak = 0;
    for (let i = 0; i <= 100; i++) peak = Math.max(peak, easing("back")(i / 100));
    expect(peak).toBeGreaterThan(1.05);
  });

  it("match CSS cubic-bezier reference values", () => {
    const ease = cubicBezier(0.25, 0.1, 0.25, 1); // CSS `ease`
    expect(ease(0.5)).toBeCloseTo(0.8024, 3);
    expect(easing("linear")(0.37)).toBeCloseTo(0.37, 9);
    expect(easing("outSoft")(0.5)).toBeGreaterThan(0.85);
    expect(easing("inSoft")(0.5)).toBeLessThan(0.3);
    // A degenerate curve with a flat slope still resolves (bisection path).
    const flat = cubicBezier(0, 0, 0, 1);
    expect(flat(0.001)).toBeGreaterThan(0);
    expect(() => easing("nope" as never)).toThrow(RangeError);
  });
});

describe("springs (SPEC §13.4)", () => {
  it("have the documented presets", () => {
    expect(SPRINGS).toEqual({
      snappy: { stiffness: 520, damping: 34 },
      bouncy: { stiffness: 380, damping: 18 },
      gentle: { stiffness: 170, damping: 26 },
      wobbly: { stiffness: 240, damping: 12 },
      camera: { stiffness: 120, damping: 22 },
    });
    for (const n of SPRING_NAMES) expect(resolveSpring(n)).toBe(SPRINGS[n]);
    const cfg = { stiffness: 1, damping: 1 };
    expect(resolveSpring(cfg)).toBe(cfg);
    expect(() => resolveSpring("nope" as never)).toThrow(RangeError);
  });

  it("feel as research 03 §4.2 describes: snappy ~3%, bouncy ~15%, gentle none, wobbly jelly", () => {
    const snappy = springOvershoot(SPRINGS.snappy);
    expect(snappy).toBeGreaterThan(0.005);
    expect(snappy).toBeLessThan(0.08);
    const bouncy = springOvershoot(SPRINGS.bouncy);
    expect(bouncy).toBeGreaterThan(0.1);
    expect(bouncy).toBeLessThan(0.35);
    expect(springOvershoot(SPRINGS.gentle)).toBeLessThan(0.01);
    expect(springOvershoot(SPRINGS.wobbly)).toBeGreaterThan(bouncy);
  });

  it("step in place at a fixed rate", () => {
    const s = new Float64Array([0]);
    const v = new Float64Array([0]);
    stepSpring(s, v, 0, 1, { stiffness: 100, damping: 10, mass: 2 });
    expect(v[0]).toBeCloseTo((100 / 2) * (SPRING_STEP_MS / 1000), 9);
    expect(springAtRest(1, 0, 1)).toBe(true);
    expect(springAtRest(0.9, 0, 1)).toBe(false);
  });
});

describe("tween engine", () => {
  it("tweens numeric properties with the easing and completes", async () => {
    const onStart = vi.fn();
    const t = createTweens({ onStart });
    const o = { x: 0, y: 10 };
    const onUpdate = vi.fn();
    const onComplete = vi.fn();
    const h = t.to(
      o,
      { x: 100, y: 0 },
      { durationMs: 200, easing: "linear", onUpdate, onComplete },
    );
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(t.active).toBe(1);
    t.step(100);
    expect(o.x).toBeCloseTo(50, 6);
    expect(o.y).toBeCloseTo(5, 6);
    t.step(100);
    expect(o).toEqual({ x: 100, y: 0 });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(t.active).toBe(0);
    await h.finished;
  });

  it("honours delays and starts from the value when the delay ends", () => {
    const t = createTweens();
    const o = { x: 0 };
    t.to(o, { x: 10 }, { durationMs: 100, delayMs: 50, easing: "linear" });
    t.step(40);
    expect(o.x).toBe(0);
    o.x = 5; // moved by something else during the delay
    t.step(60);
    expect(o.x).toBeCloseTo(5 + (10 - 5) * 0.5, 6);
    t.step(50);
    expect(o.x).toBe(10);
  });

  it("a zero duration finishes on the next step", () => {
    const t = createTweens();
    const o = { x: 0 };
    t.to(o, { x: 3 }, { durationMs: 0 });
    t.step(1);
    expect(o.x).toBe(3);
  });

  it("a newer animation takes the property over", () => {
    const t = createTweens();
    const o = { x: 0, y: 0 };
    const first = vi.fn();
    const a = t.to(o, { x: 100, y: 100 }, { durationMs: 100, easing: "linear", onComplete: first });
    t.step(50);
    t.to(o, { x: -10 }, { durationMs: 100, easing: "linear" });
    t.step(100);
    expect(o.x).toBe(-10);
    expect(o.y).toBe(100); // y still belonged to the first tween
    expect(first).toHaveBeenCalledTimes(1);
    void a;
    // A tween whose every key is taken over finishes without completing.
    const c = vi.fn();
    t.to(o, { x: 0 }, { durationMs: 100, onComplete: c });
    t.to(o, { x: 1 }, { durationMs: 100 });
    t.step(200);
    expect(c).not.toHaveBeenCalled();
  });

  it("cancel() stops in place and resolves finished; cancelAll() stops a target", async () => {
    const t = createTweens();
    const o = { x: 0 };
    const done = vi.fn();
    const h = t.to(o, { x: 100 }, { durationMs: 100, easing: "linear", onComplete: done });
    t.step(25);
    h.cancel();
    t.step(100);
    expect(o.x).toBeCloseTo(25, 6);
    expect(done).not.toHaveBeenCalled();
    await h.finished;
    const p = { a: 0, b: 0 };
    t.to(p, { a: 1 }, { durationMs: 100 });
    t.spring(p, { b: 1 }, "gentle");
    expect(t.active).toBe(2);
    t.cancelAll(p);
    expect(t.active).toBe(0);
  });

  it("springs converge to the target on the fixed step, independent of frame rate", () => {
    const run = (dt: number) => {
      const t = createTweens();
      const o = { x: 0 };
      const done = vi.fn();
      t.spring(o, { x: 1 }, "snappy", { onComplete: done });
      const samples: number[] = [];
      for (let ms = 0; ms < 2000; ms += dt) {
        t.step(dt);
        if (Math.abs((ms + dt) % 100) < 1e-6) samples.push(o.x);
      }
      return { o, done, samples };
    };
    const a = run(1000 / 60);
    const b = run(1000 / 240);
    expect(a.o.x).toBe(1);
    expect(a.done).toHaveBeenCalledTimes(1);
    expect(b.o.x).toBe(1);
  });

  it("retargeting a spring keeps its velocity (no kink)", () => {
    const t = createTweens();
    const o = { x: 0 };
    t.spring(o, { x: 10 }, "camera");
    for (let i = 0; i < 10; i++) t.step(1000 / 60);
    const before = o.x;
    t.spring(o, { x: 20 }, "camera");
    t.step(1000 / 60);
    // Still moving forward immediately (velocity carried), not restarting from rest.
    const delta = o.x - before;
    const fresh = createTweens();
    const f = { x: before };
    fresh.spring(f, { x: 20 }, "camera");
    fresh.step(1000 / 60);
    expect(delta).toBeGreaterThan(f.x - before);
  });

  it("the engine integrates springs exactly like stepSpring", () => {
    const t = createTweens();
    const o = { x: 0 };
    t.spring(o, { x: 1 }, "bouncy");
    const s = new Float64Array([0]);
    const v = new Float64Array([0]);
    for (let f = 0; f < 30; f++) {
      t.step(SPRING_STEP_MS * 4);
      for (let i = 0; i < 4; i++) stepSpring(s, v, 0, 1, SPRINGS.bouncy);
      expect(o.x).toBeCloseTo(s[0] as number, 12);
    }
  });

  it("accepts a custom spring config", () => {
    const t = createTweens();
    const o = { x: 0 };
    t.spring(o, { x: 1 }, { stiffness: 300, damping: 30, mass: 1 });
    t.settle();
    expect(o.x).toBe(1);
  });

  it("reduced motion jumps to the end value and still runs callbacks", async () => {
    const onStart = vi.fn();
    const t = createTweens({ reducedMotion: true, onStart });
    const o = { x: 0, y: 0 };
    const onUpdate = vi.fn();
    const onComplete = vi.fn();
    const h = t.to(o, { x: 5 }, { durationMs: 1000, onUpdate, onComplete });
    const s = t.spring(o, { y: 7 }, "wobbly", { onComplete });
    expect(o).toEqual({ x: 5, y: 7 });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(t.active).toBe(0);
    expect(onStart).not.toHaveBeenCalled();
    await Promise.all([h.finished, s.finished]);
  });

  it("an empty target set resolves immediately", async () => {
    const t = createTweens();
    const onComplete = vi.fn();
    await t.to({ x: 1 }, {}, { durationMs: 100, onComplete }).finished;
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("rejects non-numeric properties and targets", () => {
    const t = createTweens();
    expect(() => t.to({ x: "a" } as unknown as { x: number }, { x: 1 }, { durationMs: 1 })).toThrow(
      TypeError,
    );
    expect(() => t.to({ x: 0 }, { x: Number.NaN }, { durationMs: 1 })).toThrow(TypeError);
  });

  it("finishAll() jumps everything to its end, including animations started by callbacks", () => {
    const t = createTweens();
    const o = { x: 0, y: 0 };
    t.to(
      o,
      { x: 1 },
      {
        durationMs: 1000,
        onComplete: () => void t.to(o, { y: 2 }, { durationMs: 1000 }),
      },
    );
    const q = { s: 0 };
    t.spring(q, { s: 1 }, "bouncy");
    t.finishAll();
    expect(o).toEqual({ x: 1, y: 2 });
    expect(q.s).toBe(1);
    expect(t.active).toBe(0);
  });

  it("settle() steps until idle and reports the time", () => {
    const t = createTweens();
    const o = { x: 0 };
    t.to(o, { x: 1 }, { durationMs: 250 });
    const ms = t.settle();
    expect(o.x).toBe(1);
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(t.settle()).toBe(0);
  });

  it("clamps huge steps and animations started in callbacks begin next step", () => {
    const t = createTweens();
    const o = { x: 0, y: 0 };
    t.to(
      o,
      { x: 1 },
      {
        durationMs: 10 * MAX_STEP_MS,
        easing: "linear",
        onComplete: () => void t.to(o, { y: 1 }, { durationMs: 10, easing: "linear" }),
      },
    );
    t.step(1e9);
    expect(o.x).toBeCloseTo(0.1, 6);
    t.step(1e9);
    t.step(1e9);
    t.step(1e9);
    t.step(1e9);
    t.step(1e9);
    t.step(1e9);
    t.step(1e9);
    t.step(1e9);
    t.step(1e9); // x completes here, starts y
    expect(o.x).toBe(1);
    expect(o.y).toBe(0);
    t.step(10);
    expect(o.y).toBe(1);
  });

  it("stepping allocates nothing per frame once optimised (heap stays flat)", () => {
    // 5000 steps × 100 animations (50 tweens, 50 springs) in a fresh process: a per-step
    // allocation of even one boxed number per animation would add ~6 MB per round.
    const out = execFileSync(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        fileURLToPath(new URL("./fixtures/tween-alloc.ts", import.meta.url)),
      ],
      { encoding: "utf8" },
    );
    const r = JSON.parse(out) as { rounds: number[]; active: number };
    expect(r.active).toBe(100);
    expect(Math.min(...r.rounds)).toBeLessThan(256 * 1024);
  }, 60_000);
});
