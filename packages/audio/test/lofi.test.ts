import { AMBIENT_MODES, createRng } from "@sg/shared";
import { describe, expect, it } from "vitest";
import {
  BPM_RANGE,
  CHORD_SETS,
  HISS_DB,
  MODE_STYLE,
  PROGRESSION,
  SWING,
  createLofi,
  dbToGain,
  lofiBar,
  modePlan,
  noteFreq,
} from "../src/index.ts";
import {
  FakeAudioContext,
  FakeBiquad,
  FakeGain,
  FakeOscillator,
  FakeTimers,
  run,
} from "./fake-audio.ts";

function setup(mode: (typeof AMBIENT_MODES)[number] = "dusk") {
  const ctx = new FakeAudioContext();
  ctx.state = "running";
  const timers = new FakeTimers();
  const out = ctx.createGain();
  const lofi = createLofi(ctx.asAudio, out as unknown as AudioNode, {
    mode,
    seed: 4,
    scheduler: { timers },
  });
  return { ctx, timers, out, lofi };
}

describe("lofi composition (research 03 §8.2)", () => {
  it("is a 4-bar ii–V–I–vi with roots D, G, C, A in all 4 chord sets", () => {
    expect(PROGRESSION).toEqual(["ii", "V", "I", "vi"]);
    expect(CHORD_SETS).toHaveLength(4);
    for (const set of CHORD_SETS) {
      expect(set.map((c) => c.fn)).toEqual(PROGRESSION);
      expect(set.map((c) => c.root)).toEqual(["D2", "G2", "C2", "A1"]);
      for (const c of set) {
        expect(c.voicing.length).toBeGreaterThanOrEqual(4);
        // Each voicing contains its chord root's pitch class.
        expect(c.voicing.some((n) => n[0] === c.root[0])).toBe(true);
      }
    }
    expect(new Set(CHORD_SETS.map((s) => JSON.stringify(s))).size).toBe(4);
  });

  it("tempo stays in 72–84 BPM and each mode has its own seeded chord-set order", () => {
    for (const m of AMBIENT_MODES)
      for (let seed = 0; seed < 50; seed++) {
        const p = modePlan(m, seed);
        expect(p.bpm).toBeGreaterThanOrEqual(BPM_RANGE.min);
        expect(p.bpm).toBeLessThanOrEqual(BPM_RANGE.max);
        expect([...p.order].sort()).toEqual([0, 1, 2, 3]);
      }
    expect(modePlan("night", 1)).toEqual(modePlan("night", 1));
    const orders = new Set(AMBIENT_MODES.map((m) => modePlan(m, 0).order.join("")));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("swings the off-beat 8ths to 58% and backbeats the snare", () => {
    expect(SWING).toBe(0.58);
    const rng = createRng(1);
    for (let bar = 0; bar < 40; bar++) {
      const ev = lofiBar(CHORD_SETS[0]!, bar, rng);
      const hats = ev.filter((e) => e.kind === "hat").map((e) => e.beat);
      expect(hats).toEqual([0, 0.58, 1, 1.58, 2, 2.58, 3, 3.58]);
      expect(ev.filter((e) => e.kind === "snare").map((e) => e.beat)).toEqual([1, 3]);
      expect(ev.find((e) => e.kind === "bass" && e.beat === 0)).toMatchObject({
        hz: noteFreq(CHORD_SETS[0]![bar % 4]!.root),
      });
      for (const e of ev) {
        expect(e.beat).toBeGreaterThanOrEqual(0);
        expect(e.beat).toBeLessThan(4);
      }
    }
  });
});

describe("lofi player", () => {
  it("builds the Rhodes tremolo (4 Hz), tape lowpass and −38 dB vinyl hiss, fading in", () => {
    const { ctx, out } = setup("night");
    const lfo = ctx.of(FakeOscillator).find((o) => o.frequency.value === 4);
    expect(lfo).toBeDefined();
    expect(ctx.of(FakeBiquad).some((f) => f.frequency.value === MODE_STYLE.night.tapeHz)).toBe(
      true,
    );
    expect(ctx.of(FakeGain).some((g) => Math.abs(g.gain.value - dbToGain(HISS_DB)) < 1e-9)).toBe(
      true,
    );
    const fade = ctx.of(FakeGain).find((g) => g.outputs[0] === out) as FakeGain;
    expect(fade.gain.valueAt(0.05)).toBeLessThan(0.001);
    expect(fade.gain.valueAt(1.55)).toBeCloseTo(1, 6);
  });

  it("plays bars at the mode tempo, rotating chord sets every 4 bars", () => {
    const { ctx, timers, lofi } = setup("dusk");
    const bpm = lofi.bpm;
    const barS = (4 * 60) / bpm;
    run(ctx, timers, barS * 8 + 0.1);
    expect(lofi.bar).toBe(9);
    const plan = modePlan("dusk", 4);
    // Bass roots on beat 1 of bar 0 and bar 4 come from the set order.
    const bassAt = (t: number): number | undefined =>
      ctx
        .of(FakeOscillator)
        .find(
          (o) =>
            o.startTime !== null &&
            Math.abs(o.startTime - t) < 1e-6 &&
            o.frequency.targets()[0]! > 20 &&
            o.frequency.targets()[0]! < 100,
        )
        ?.frequency.targets()[0];
    expect(bassAt(0.05)).toBeCloseTo(noteFreq(CHORD_SETS[plan.order[0]!]![0].root), 6);
    expect(bassAt(0.05 + barS * 2)).toBeCloseTo(noteFreq("C2"), 6);
    // Hat on the swung off-beat of beat 1.
    const kickTimes = ctx
      .of(FakeOscillator)
      .filter((o) => o.frequency.events.some((e) => e.type === "exp"))
      .map((o) => o.startTime as number);
    expect(kickTimes.some((t) => Math.abs(t - (0.05 + (2 + SWING) * (60 / bpm))) < 1e-6)).toBe(
      true,
    );
  });

  it("switches mode on the next bar line", () => {
    const { ctx, timers, lofi } = setup("day");
    const dayBpm = lofi.bpm;
    run(ctx, timers, 1);
    lofi.setMode("night");
    expect(lofi.mode).toBe("night");
    expect(lofi.bpm).toBe(dayBpm);
    run(ctx, timers, (4 * 60) / dayBpm + 0.5);
    expect(lofi.bpm).toBe(modePlan("night", 4).bpm);
    lofi.setMode("night");
    expect(lofi.mode).toBe("night");
  });

  it("stop fades out, stops scheduling and frees the fixed graph", () => {
    const { ctx, timers, out, lofi } = setup();
    run(ctx, timers, 3);
    lofi.stop(400);
    const count = ctx.nodes.length;
    run(ctx, timers, 10);
    expect(ctx.nodes.length).toBe(count);
    for (const n of ctx.nodes)
      if (n !== ctx.destination && n !== out) expect(n.disconnected).toBe(true);
  });
});
