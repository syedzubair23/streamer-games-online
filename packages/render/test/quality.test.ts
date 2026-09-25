/**
 * Quality tiers and dynamic resolution (ROADMAP M1-06 Accept: "Dynamic resolution steps down and
 * up with hysteresis (unit test using a fake frame feed)"; SPEC §10).
 */
import { describe, expect, it, vi } from "vitest";
import {
  detectTier,
  DYNRES,
  DynamicResolution,
  effectivePixelRatio,
  parseQualityParams,
  percentileInto,
  readDeviceHints,
  tierPreset,
  TIERS,
} from "../src/quality.ts";
import { QUALITY_TIERS } from "../src/types.ts";

const TARGET = 1000 / 30;

/** Feeds `windows` full windows of a constant frame time, advancing a fake clock. */
function feed(
  dr: DynamicResolution,
  frameMs: number | ((scale: number) => number),
  windows: number,
  clock: { t: number },
  frames = 30,
): number[] {
  const scales: number[] = [];
  for (let w = 0; w < windows; w++) {
    for (let f = 0; f < frames; f++) {
      const ms = typeof frameMs === "number" ? frameMs : frameMs(dr.scale);
      clock.t += ms;
      dr.push(ms, clock.t);
    }
    scales.push(dr.scale);
  }
  return scales;
}

describe("tier presets (SPEC §10)", () => {
  it("match the SPEC §10 table", () => {
    expect(TIERS.low).toMatchObject({
      dprCap: 1.25,
      antialias: false,
      ambientFps: 30,
      shadows: "blob",
    });
    expect(TIERS.mid).toMatchObject({
      dprCap: 1.5,
      antialias: true,
      ambientFps: 30,
      shadows: "blob",
    });
    expect(TIERS.high).toMatchObject({
      dprCap: 2,
      antialias: true,
      ambientFps: 60,
      shadows: "blob+map",
      shadowMapSize: 1024,
    });
    expect(TIERS.low.budgets).toEqual({
      drawCalls: 60,
      triangles: 50_000,
      programs: 10,
      textureMB: 24,
    });
    expect(TIERS.mid.budgets).toEqual({
      drawCalls: 100,
      triangles: 100_000,
      programs: 12,
      textureMB: 48,
    });
    expect(TIERS.high.budgets).toEqual({
      drawCalls: 150,
      triangles: 150_000,
      programs: 14,
      textureMB: 64,
    });
  });

  it("follow research 03 §5.5 for rim, props, particles and grain", () => {
    expect([TIERS.low.rim, TIERS.mid.rim, TIERS.high.rim]).toEqual([false, true, true]);
    expect([
      TIERS.low.weatherParticles,
      TIERS.mid.weatherParticles,
      TIERS.high.weatherParticles,
    ]).toEqual([80, 180, 300]);
    expect([TIERS.low.confetti, TIERS.mid.confetti, TIERS.high.confetti]).toEqual([120, 200, 300]);
    expect(TIERS.low.grainAnimated).toBe(false);
    expect(TIERS.high.dustMotes).toBe(true);
    for (const t of QUALITY_TIERS) expect(tierPreset(t).tier).toBe(t);
  });

  it("frame targets are 30 fps on low/mid and 60 fps on high", () => {
    expect(TIERS.low.frameTargetMs).toBeCloseTo(33.33, 1);
    expect(TIERS.high.frameTargetMs).toBeCloseTo(16.67, 1);
  });
});

describe("detectTier", () => {
  it("goes low on ≤ 4 cores, ≤ 4 GB or a slow bench", () => {
    expect(detectTier({ hints: { hardwareConcurrency: 4 } })).toBe("low");
    expect(detectTier({ hints: { hardwareConcurrency: 8, deviceMemory: 4 } })).toBe("low");
    expect(detectTier({ hints: { hardwareConcurrency: 16 }, benchMs: 8.5 })).toBe("low");
  });
  it("goes high on a fast desktop, mid otherwise", () => {
    expect(detectTier({ hints: { hardwareConcurrency: 8, mobile: false }, benchMs: 2.5 })).toBe(
      "high",
    );
    expect(detectTier({ hints: { hardwareConcurrency: 8, mobile: true }, benchMs: 2.5 })).toBe(
      "mid",
    );
    expect(detectTier({ hints: { hardwareConcurrency: 8 }, benchMs: 5 })).toBe("mid");
    expect(detectTier({ hints: { hardwareConcurrency: 6 }, benchMs: 1 })).toBe("mid");
    expect(detectTier({ hints: {} })).toBe("mid");
  });
  it("honours overrides and OBS mode", () => {
    expect(detectTier({ hints: { hardwareConcurrency: 2 }, override: "high" })).toBe("high");
    expect(detectTier({ hints: { hardwareConcurrency: 32 }, benchMs: 1, override: "low" })).toBe(
      "low",
    );
    expect(detectTier({ hints: { hardwareConcurrency: 2 }, obs: true })).toBe("high");
    expect(detectTier({ hints: { hardwareConcurrency: 2 }, override: "auto" })).toBe("low");
  });
  it("reads device hints from a navigator", () => {
    expect(readDeviceHints(undefined)).toEqual({});
    expect(
      readDeviceHints({ hardwareConcurrency: 8, deviceMemory: 8, userAgent: "X11; Linux" }),
    ).toEqual({
      hardwareConcurrency: 8,
      deviceMemory: 8,
      mobile: false,
    });
    expect(readDeviceHints({ userAgent: "Mozilla/5.0 (Linux; Android 10)" }).mobile).toBe(true);
    expect(readDeviceHints({ userAgent: "Android", userAgentData: { mobile: false } }).mobile).toBe(
      false,
    );
  });
  it("parses the quality URL flags", () => {
    expect(parseQualityParams("?quality=low&obs=1")).toEqual({
      override: "low",
      obs: true,
      overlay: false,
    });
    expect(parseQualityParams("?tier=high&overlay=true")).toEqual({
      override: "high",
      obs: false,
      overlay: true,
    });
    expect(parseQualityParams("?quality=ultra&obs=0")).toEqual({
      override: "auto",
      obs: false,
      overlay: false,
    });
  });
  it("clamps the pixel ratio to the tier cap, then scales", () => {
    expect(effectivePixelRatio(3, "low")).toBe(1.25);
    expect(effectivePixelRatio(3, "mid", 0.5)).toBe(0.75);
    expect(effectivePixelRatio(1, "high")).toBe(1);
    expect(effectivePixelRatio(Number.NaN, "high")).toBe(1);
  });
});

describe("DynamicResolution (fake frame feed)", () => {
  const make = (extra: Partial<ConstructorParameters<typeof DynamicResolution>[0]> = {}) =>
    new DynamicResolution({ targetMs: TARGET, warmupFrames: 0, ...extra });

  it("steps down by 0.1 after ONE bad window (p90 > 1.15 × target)", () => {
    const dr = make();
    const clock = { t: 0 };
    feed(dr, TARGET * 1.3, 1, clock);
    expect(dr.scale).toBe(0.9);
    expect(dr.windows).toBe(1);
  });

  it("does not step down on a window that is only slightly slow (hysteresis band)", () => {
    const dr = make();
    const scales = feed(dr, TARGET * 1.1, 10, { t: 0 });
    expect(scales.every((s) => s === 1)).toBe(true);
  });

  it("changes at most once per second", () => {
    const dr = make();
    const clock = { t: 0 };
    // 30 frames of 40 ms = 1.2 s per window: every bad window may step.
    feed(dr, 40, 2, clock);
    expect(dr.scale).toBe(0.8);
    // Short windows (30 × 20 ms = 0.6 s) of bad frames: only every other window may change.
    const dr2 = make();
    const c2 = { t: 0 };
    const s2: number[] = [];
    for (let w = 0; w < 4; w++) {
      for (let f = 0; f < 30; f++) {
        c2.t += 20;
        dr2.push(TARGET * 2, c2.t);
      }
      s2.push(dr2.scale);
    }
    expect(s2).toEqual([0.9, 0.9, 0.8, 0.8]);
  });

  it("steps up by 0.05 only after THREE good windows in a row", () => {
    const dr = make();
    const clock = { t: 0 };
    feed(dr, TARGET * 1.5, 3, clock); // → 0.7
    expect(dr.scale).toBe(0.7);
    const up = feed(dr, TARGET * 0.5, 7, clock);
    expect(up).toEqual([0.7, 0.7, 0.75, 0.75, 0.75, 0.8, 0.8]);
  });

  it("a neutral window resets the good-window streak", () => {
    const dr = make();
    const clock = { t: 0 };
    feed(dr, TARGET * 1.5, 1, clock); // → 0.9
    feed(dr, TARGET * 0.5, 2, clock); // 2 good
    feed(dr, TARGET * 0.9, 1, clock); // neutral: streak reset
    const after = feed(dr, TARGET * 0.5, 2, clock);
    expect(after).toEqual([0.9, 0.9]);
    expect(feed(dr, TARGET * 0.5, 1, clock)).toEqual([0.95]);
  });

  it("a bad window also resets the good streak", () => {
    const dr = make();
    const clock = { t: 0 };
    feed(dr, TARGET * 1.5, 2, clock); // → 0.8
    feed(dr, TARGET * 0.5, 2, clock);
    feed(dr, TARGET * 1.5, 1, clock); // → 0.7, streak reset
    expect(dr.scale).toBe(0.7);
    expect(feed(dr, TARGET * 0.5, 2, clock)).toEqual([0.7, 0.7]);
  });

  it("floors at 0.5 and reports it; caps at 1.0", () => {
    const onFloor = vi.fn();
    const onChange = vi.fn();
    const dr = make({ onFloor, onChange });
    const clock = { t: 0 };
    feed(dr, TARGET * 3, 10, clock);
    expect(dr.scale).toBe(DYNRES.min);
    expect(onFloor).toHaveBeenCalled();
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([0.9, 0.8, 0.7, 0.6, 0.5]);
    feed(dr, TARGET * 0.2, 60, clock);
    expect(dr.scale).toBe(DYNRES.max);
  });

  it("uses the p90, so a few hitches do not trigger a step", () => {
    const dr = make();
    const clock = { t: 0 };
    for (let f = 0; f < 30; f++) {
      const ms = f < 2 ? 200 : TARGET * 0.9;
      clock.t += ms;
      dr.push(ms, clock.t);
    }
    expect(dr.scale).toBe(1);
    expect(dr.lastP90).toBeCloseTo(TARGET * 0.9, 3);
  });

  it("ignores the warm-up frames after load and after reset()", () => {
    const dr = new DynamicResolution({ targetMs: TARGET, warmupFrames: 60 });
    const clock = { t: 0 };
    feed(dr, TARGET * 3, 2, clock);
    expect(dr.scale).toBe(1);
    expect(dr.windows).toBe(0);
    feed(dr, TARGET * 3, 1, clock);
    expect(dr.scale).toBe(0.9);
    dr.reset(30);
    feed(dr, TARGET * 3, 1, clock);
    expect(dr.scale).toBe(0.9);
  });

  it("is inert when disabled (overlay / ?obs=1) and ignores junk samples", () => {
    const dr = new DynamicResolution({ targetMs: TARGET, enabled: false });
    feed(dr, TARGET * 3, 10, { t: 0 });
    expect(dr.scale).toBe(1);
    expect(dr.enabled).toBe(false);
    const dr2 = make();
    expect(dr2.push(Number.NaN, 0)).toBe(false);
    expect(dr2.push(-1, 0)).toBe(false);
    expect(() => new DynamicResolution({ targetMs: 0 })).toThrow(RangeError);
  });

  it("settles without oscillating when frame cost scales with pixel count", () => {
    const dr = make();
    const clock = { t: 0 };
    // Cost ∝ pixels (scale²): 60 ms at full res; the target is 33.3 ms.
    const scales = feed(dr, (s) => 60 * s * s, 120, clock);
    const tail = scales.slice(-60);
    expect(new Set(tail).size).toBe(1);
    const settled = tail[0] as number;
    expect(60 * settled * settled).toBeLessThanOrEqual(TARGET * DYNRES.badRatio);
    expect(60 * settled * settled).toBeGreaterThanOrEqual(TARGET * DYNRES.goodRatio);
  });

  it("recovers once load drops", () => {
    const dr = make();
    const clock = { t: 0 };
    feed(dr, 60, 5, clock);
    const low = dr.scale;
    expect(low).toBeLessThan(1);
    feed(dr, 8, 100, clock);
    expect(dr.scale).toBe(1);
  });

  it("percentileInto uses nearest rank without allocating", () => {
    const v = new Float32Array([5, 1, 4, 2, 3, 10, 9, 8, 7, 6]);
    const s = new Float32Array(10);
    expect(percentileInto(v, s, 0.9)).toBe(9);
    expect(percentileInto(v, s, 0.5)).toBe(5);
    expect(percentileInto(v, s, 0)).toBe(1);
    expect(v[0]).toBe(5);
  });
});
