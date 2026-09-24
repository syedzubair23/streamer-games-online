import { describe, expect, it, vi } from "vitest";
import { createMotion, cubicBezier, easing, SPRING_STEP_MS } from "../src/dev/motion.ts";
import { SPRINGS } from "../src/dev/placeholder-theme.ts";

const engine = (reducedMotion = false, onStart?: () => void) =>
  createMotion({ springs: SPRINGS, reducedMotion, ...(onStart ? { onStart } : {}) });

describe("cubic-bezier easings", () => {
  it("match the endpoints and are monotonic for the token curves", () => {
    for (const name of ["outSoft", "inSoft", "inout", "linear"] as const) {
      const f = easing(name);
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
      let prev = 0;
      for (let x = 0.05; x < 1; x += 0.05) {
        const y = f(x);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = y;
      }
    }
    expect(easing("back")(0.6)).toBeGreaterThan(1); // overshoot
    expect(cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3); // CSS "ease"
    expect(easing("linear")(0.3)).toBeCloseTo(0.3, 9);
    // A curve with a flat start makes Newton stall; the bisection fallback still converges.
    const flat = cubicBezier(0, 0, 1, 1);
    expect(flat(0.001)).toBeCloseTo(0.001, 3);
    expect(cubicBezier(1, 0, 0, 1)(0.5)).toBeCloseTo(0.5, 3);
  });
});

describe("tweens", () => {
  it("advance only with the clock, honour delay and easing, then complete", async () => {
    const onStart = vi.fn();
    const m = engine(false, onStart);
    const o = { x: 0, y: 5 };
    const onUpdate = vi.fn();
    const onComplete = vi.fn();
    const h = m.to(
      o,
      { x: 10 },
      { durationMs: 100, delayMs: 50, easing: "linear", onUpdate, onComplete },
    );
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(m.active).toBe(1);
    m.step(40);
    expect(o.x).toBe(0);
    m.step(20); // 10 ms into the tween
    expect(o.x).toBeCloseTo(1, 5);
    expect(onUpdate).toHaveBeenCalled();
    m.step(200);
    expect(o.x).toBe(10);
    expect(o.y).toBe(5);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(m.active).toBe(0);
    await h.finished;
    m.step(0);
    m.step(-5);
  });

  it("a zero-length tween lands on the next step; bad input throws", () => {
    const m = engine();
    const o = { x: 0 };
    m.to(o, { x: 3 }, { durationMs: 0 });
    m.step(1);
    expect(o.x).toBe(3);
    expect(() => m.to(o, { x: 1 }, { durationMs: -1 })).toThrow(/durationMs/);
    expect(() =>
      m.to({ s: "a" } as unknown as { s: number }, { s: 1 }, { durationMs: 10 }),
    ).toThrow(/not a number/);
  });

  it("a new tween on the same property replaces the running one", async () => {
    const m = engine();
    const o = { x: 0, y: 0 };
    const a = m.to(o, { x: 10, y: 10 }, { durationMs: 100 });
    const b = m.to(o, { x: -10 }, { durationMs: 100, easing: "linear" });
    m.step(100);
    expect(o.x).toBe(-10);
    expect(o.y).toBe(10);
    const c = m.to(o, { y: 0 }, { durationMs: 50 });
    const d = m.to(o, { y: 1 }, { durationMs: 50 });
    await c.finished; // fully replaced: resolved without completing
    m.step(50);
    expect(o.y).toBe(1);
    await Promise.all([a.finished, b.finished, d.finished]);
  });

  it("cancel stops a tween where it is; cancelAll stops everything on a target", async () => {
    const m = engine();
    const o = { x: 0 };
    const p = { x: 0 };
    const h = m.to(o, { x: 10 }, { durationMs: 100, easing: "linear" });
    m.to(p, { x: 10 }, { durationMs: 100 });
    m.step(50);
    h.cancel();
    h.cancel();
    await h.finished;
    m.step(50);
    expect(o.x).toBeCloseTo(5, 5);
    m.cancelAll(p);
    expect(m.active).toBe(0);
  });

  it("reduced motion jumps straight to the end values", async () => {
    const m = engine(true);
    const o = { x: 0, k: 0 };
    const done = vi.fn();
    await m.to(o, { x: 7 }, { durationMs: 300, onComplete: done }).finished;
    await m.spring(o, { k: 1 }, "wobbly").finished;
    expect(o).toEqual({ x: 7, k: 1 });
    expect(done).toHaveBeenCalled();
    expect(m.active).toBe(0);
  });
});

describe("springs", () => {
  it("settle exactly on the goal, independent of the frame size", () => {
    const run = (frame: number) => {
      const m = engine();
      const o = { k: 0 };
      const onUpdate = vi.fn();
      m.spring(o, { k: 1 }, "bouncy", { onUpdate });
      let peak = 0;
      for (let t = 0; t < 3000 && m.active > 0; t += frame) {
        m.step(frame);
        peak = Math.max(peak, o.k);
      }
      expect(onUpdate).toHaveBeenCalled();
      return { k: o.k, peak, active: m.active };
    };
    const a = run(1000 / 60);
    const b = run(SPRING_STEP_MS);
    expect(a).toMatchObject({ k: 1, active: 0 });
    expect(b.k).toBe(1);
    expect(a.peak).toBeGreaterThan(1); // bouncy overshoots
    expect(a.peak).toBeCloseTo(b.peak, 2);
  });

  it("accept a custom config, reject unknown presets, and settle() runs to rest", () => {
    const m = engine();
    const o = { k: 0 };
    const onComplete = vi.fn();
    m.spring(o, { k: 2 }, { stiffness: 200, damping: 30, mass: 2 }, { onComplete });
    const ms = m.settle();
    expect(ms).toBeGreaterThan(0);
    expect(o.k).toBe(2);
    expect(onComplete).toHaveBeenCalled();
    expect(() => m.spring(o, { k: 1 }, "nope" as "snappy")).toThrow(/unknown spring/);
  });

  it("finishAll lands every animation on its end value", () => {
    const m = engine();
    const o = { a: 0, b: 0 };
    m.spring(o, { a: 1 }, "gentle");
    m.to(o, { b: 4 }, { durationMs: 1000 });
    m.finishAll();
    expect(o).toEqual({ a: 1, b: 4 });
    expect(m.settle()).toBe(0);
  });
});
