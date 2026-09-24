import { createRng } from "@sg/shared";
import { describe, expect, it } from "vitest";
import {
  MODE_SWELL,
  NOISE_SECONDS,
  PITCH_STEP_RANGE,
  SFX_RECIPES,
  clampPitchStep,
  createScheduler,
  createSfxPlayer,
  fillNoise,
  noiseBuffer,
  noteFreq,
  pentatonicRange,
  planLengthMs,
  planSfx,
  renderVoice,
} from "../src/index.ts";
import {
  FakeAudioContext,
  FakeBiquad,
  FakeBufferSource,
  type FakeGain,
  FakeOscillator,
  FakeTimers,
} from "./fake-audio.ts";

function player(opts: Parameters<typeof createSfxPlayer>[2] = {}) {
  const ctx = new FakeAudioContext();
  const out = ctx.createGain();
  const p = createSfxPlayer(ctx.asAudio, out as unknown as AudioNode, {
    rng: createRng(3),
    ...opts,
  });
  return { ctx, out, p };
}

describe("sfx planning", () => {
  it("clamps pitch steps and ignores junk", () => {
    expect(clampPitchStep(undefined)).toBe(0);
    expect(clampPitchStep(Number.NaN)).toBe(0);
    expect(clampPitchStep(99)).toBe(PITCH_STEP_RANGE.max);
    expect(clampPitchStep(-99)).toBe(PITCH_STEP_RANGE.min);
    expect(clampPitchStep(2.7)).toBe(2);
  });

  it("varies repetitive sounds by at most ±1 step and keeps melodic ones exact", () => {
    const seen = new Set<number>();
    const rng = createRng(11);
    for (let i = 0; i < 300; i++) {
      const v = planSfx(SFX_RECIPES.pop, rng)[0];
      if (v?.kind === "tone") seen.add(Math.round(v.hz * 100));
    }
    expect([...seen].sort()).toEqual(
      [noteFreq("D5"), noteFreq("E5"), noteFreq("G5")].map((f) => Math.round(f * 100)).sort(),
    );
    for (let i = 0; i < 50; i++) {
      const hz = planSfx(SFX_RECIPES.success, rng).map((v) => (v.kind === "tone" ? v.hz : 0));
      expect(hz).toEqual([noteFreq("C5"), noteFreq("E5"), noteFreq("G5")]);
    }
  });

  it("win adds 6 sparkles within 800 ms from the C6–A6 range", () => {
    const plan = planSfx(SFX_RECIPES.win, createRng(5));
    const sparkles = plan.slice(4);
    expect(sparkles).toHaveLength(6);
    const range = pentatonicRange("C6", "A6");
    expect(range).toHaveLength(5);
    for (const s of sparkles) {
      if (s.kind !== "tone") throw new Error("sparkle is a tone");
      expect(range).toContain(s.hz);
      expect(s.atMs).toBeGreaterThanOrEqual(60);
      expect(s.atMs).toBeLessThan(60 + 800);
    }
    expect(planLengthMs(plan)).toBe(1620);
  });

  it("plans are deterministic for a seed", () => {
    expect(planSfx(SFX_RECIPES.vote, createRng(9))).toEqual(
      planSfx(SFX_RECIPES.vote, createRng(9)),
    );
  });
});

describe("sfx rendering", () => {
  it("renders a tone with a linear attack, exponential decay, glide and detune", () => {
    const { ctx, out, p } = player();
    expect(p.play("pop")).toBe(true);
    const [osc] = ctx.of(FakeOscillator);
    if (!osc) throw new Error("no oscillator");
    expect(osc.type).toBe("sine");
    expect(osc.startTime).toBe(0);
    expect(osc.stopTime).toBeCloseTo(0.093 + 0.02, 9);
    const f = osc.frequency.events.map((e) => e.type);
    expect(f).toEqual(["set", "exp"]);
    const env = osc.outputs[0] as FakeGain;
    expect(env.outputs).toEqual([out]);
    expect(env.gain.valueAt(0)).toBe(0);
    expect(env.gain.valueAt(0.003)).toBeCloseTo(0.25, 9);
    expect(env.gain.valueAt(0.093)).toBeCloseTo(0.0001, 6);
  });

  it("tick goes through its own 3 kHz lowpass; noise voices through their filter", () => {
    const { ctx, p } = player();
    p.play("tick");
    const lp = ctx.of(FakeBiquad)[0];
    expect(lp?.frequency.value).toBe(3000);
    p.play("card");
    const bp = ctx.of(FakeBiquad)[1];
    expect(bp?.type).toBe("bandpass");
    expect(bp?.frequency.targets()).toEqual([2000, 800]);
    const src = ctx.of(FakeBufferSource)[0];
    expect(src?.buffer).toBeTruthy();
    expect(src?.loop).toBe(false);
  });

  it("frees every node when its voice ends and tracks active voices", () => {
    const { ctx, out, p } = player();
    p.play("win");
    p.play("capture");
    expect(p.active).toBe(13);
    ctx.advance(2);
    expect(p.active).toBe(0);
    for (const n of ctx.nodes)
      if (n !== ctx.destination && n !== out) expect(n.disconnected).toBe(true);
  });

  it("rate-limits repeats of one sound and respects the voice budget", () => {
    const { ctx, p } = player({ minIntervalMs: 30, maxVoices: 12 });
    expect(p.play("vote")).toBe(true);
    expect(p.play("vote")).toBe(false);
    ctx.advance(0.031);
    expect(p.play("vote")).toBe(true);
    expect(p.play("pop")).toBe(true);
    expect(p.active).toBe(5);
    expect(p.play("win")).toBe(false); // 10 more voices would exceed 12
    expect(p.play("chime")).toBe(true);
    expect(p.active).toBe(8);
  });

  it("plays the mode swell as a 0.6 s lowpass sweep", () => {
    const { ctx, p } = player();
    p.swell();
    const f = ctx.of(FakeBiquad)[0];
    expect(f?.type).toBe("lowpass");
    expect(f?.frequency.targets()).toEqual([MODE_SWELL.filter.hz, MODE_SWELL.filter.toHz]);
    expect(ctx.of(FakeBufferSource)[0]?.stopTime).toBeCloseTo(0.62, 9);
  });

  it("renderVoice schedules at an offset time", () => {
    const ctx = new FakeAudioContext();
    const src = renderVoice(
      ctx.asAudio,
      ctx.destination as unknown as AudioNode,
      planSfx(SFX_RECIPES.chime, createRng(1))[1]!,
      2,
    );
    expect((src as unknown as FakeOscillator).startTime).toBeCloseTo(2.09, 9);
  });
});

describe("noise and scheduler", () => {
  it("noise buffers are cached per context, deterministic and bounded", () => {
    const ctx = new FakeAudioContext();
    const a = noiseBuffer(ctx.asAudio, "pink");
    expect(noiseBuffer(ctx.asAudio, "pink")).toBe(a);
    expect(a.length).toBe(ctx.sampleRate * NOISE_SECONDS);
    for (const color of ["white", "pink", "brown"] as const) {
      const x = new Float32Array(20000);
      const y = new Float32Array(20000);
      fillNoise(x, color);
      fillNoise(y, color);
      expect(x).toEqual(y);
      const peak = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      expect(peak).toBeGreaterThan(0.05);
      expect(peak).toBeLessThanOrEqual(1.5);
    }
  });

  it("hands out contiguous windows and skips a stalled gap instead of bursting", () => {
    const ctx = { currentTime: 0 };
    const timers = new FakeTimers();
    const windows: [number, number][] = [];
    const s = createScheduler(ctx, (a, b) => windows.push([a, b]), { aheadS: 0.1, timers });
    expect(windows).toEqual([[0, 0.1]]);
    ctx.currentTime = 0.05;
    timers.tick();
    expect(windows[1]).toEqual([0.1, 0.15000000000000002]);
    timers.tick(); // clock stood still (suspended): nothing new
    expect(windows).toHaveLength(2);
    ctx.currentTime = 5;
    timers.tick();
    expect(windows[2]?.[0]).toBe(5);
    expect(s.horizon).toBeCloseTo(5.1, 9);
    s.stop();
    expect(timers.fns.size).toBe(0);
  });

  it("uses real timers by default", async () => {
    const ctx = { currentTime: 0 };
    let calls = 0;
    const s = createScheduler(ctx, () => calls++, { intervalMs: 1 });
    ctx.currentTime = 1;
    await new Promise((r) => setTimeout(r, 20));
    s.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
