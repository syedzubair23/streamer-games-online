import { AMBIENT_MODES, createRng } from "@sg/shared";
import { describe, expect, it } from "vitest";
import {
  BEDS,
  MODE_FADE_MS,
  createAmbience,
  noteFreq,
  planDroplet,
  poissonGap,
  type NoiseLayer,
} from "../src/index.ts";
import {
  FakeAudioContext,
  FakeBiquad,
  FakeBufferSource,
  FakeGain,
  FakeOscillator,
  FakeTimers,
  run,
} from "./fake-audio.ts";

function setup() {
  const ctx = new FakeAudioContext();
  ctx.state = "running";
  const timers = new FakeTimers();
  const out = ctx.createGain();
  const amb = createAmbience(ctx.asAudio, out as unknown as AudioNode, {
    rng: createRng(1),
    scheduler: { timers },
  });
  return { ctx, timers, out, amb };
}

describe("ambience beds (research 03 §8.2, §9)", () => {
  it("has a bed for every ambient mode", () => {
    expect(Object.keys(BEDS).sort()).toEqual([...AMBIENT_MODES].sort());
    for (const m of AMBIENT_MODES) {
      expect(BEDS[m].mode).toBe(m);
      expect(BEDS[m].layers.length).toBeGreaterThan(0);
    }
  });

  it("rain: pink noise → lowpass 1.2 kHz + droplets at ~6/s", () => {
    const pink = BEDS.rain.layers.find(
      (l): l is NoiseLayer => l.kind === "noise" && l.color === "pink",
    );
    expect(pink?.filter).toEqual({ type: "lowpass", hz: 1200, q: 0.5 });
    expect(BEDS.rain.events).toEqual([expect.objectContaining({ kind: "droplet", ratePerS: 6 })]);
    const d = planDroplet(createRng(2));
    expect(d.durMs).toBeGreaterThanOrEqual(10);
    expect(d.durMs).toBeLessThanOrEqual(25);
  });

  it("night: very low room tone, low hum and far-off crickets; day: birds; dusk/snow: wind", () => {
    expect(BEDS.night.layers.some((l) => l.kind === "hum" && noteFreq(l.note) < 100)).toBe(true);
    expect(BEDS.night.events.map((e) => e.kind)).toEqual(["cricket"]);
    expect(BEDS.night.events[0]?.gain).toBeLessThan(0.01);
    expect(BEDS.day.events.map((e) => e.kind)).toEqual(["bird"]);
    for (const m of ["dusk", "snow"] as const)
      expect(BEDS[m].layers.some((l) => l.kind === "noise" && l.lfo !== undefined)).toBe(true);
    // Snow is muffled: its room tone is darker than every other mode's.
    const tone = (m: keyof typeof BEDS): number =>
      (BEDS[m].layers.find((l) => l.kind === "noise" && l.color === "brown") as NoiseLayer).filter
        .hz;
    for (const m of ["day", "dusk", "night", "rain"] as const)
      expect(tone("snow")).toBeLessThan(tone(m));
  });

  it("Poisson gaps average 1/rate", () => {
    const rng = createRng(3);
    let sum = 0;
    for (let i = 0; i < 20000; i++) sum += poissonGap(rng, 6);
    expect(sum / 20000).toBeCloseTo(1 / 6, 2);
  });
});

describe("ambience player", () => {
  it("starts a mode's layers with a 2.5 s fade-in", () => {
    const { ctx, out, amb } = setup();
    expect(amb.mode).toBeNull();
    amb.setMode("rain");
    expect(amb.mode).toBe("rain");
    const fade = (out as FakeGain).ctx.nodes.find(
      (n) => n instanceof FakeGain && n.outputs[0] === out,
    ) as FakeGain;
    expect(fade.gain.valueAt(0)).toBeLessThan(0.001);
    expect(fade.gain.valueAt(MODE_FADE_MS / 1000)).toBeCloseTo(1, 6);
    const loops = ctx.of(FakeBufferSource).filter((s) => s.loop);
    expect(loops).toHaveLength(2);
    expect(ctx.of(FakeBiquad).some((f) => f.type === "lowpass" && f.frequency.value === 1200)).toBe(
      true,
    );
  });

  it("schedules droplets at about 6 per second", () => {
    const { ctx, timers, amb } = setup();
    amb.setMode("rain");
    run(ctx, timers, 60);
    const droplets = ctx.of(FakeBufferSource).filter((s) => !s.loop);
    expect(droplets.length).toBeGreaterThan(300);
    expect(droplets.length).toBeLessThan(420);
    // Never scheduled into the past.
    for (const d of droplets) expect(d.startTime).toBeGreaterThanOrEqual(0);
  });

  it("crossfades beds over 2.5 s and frees the old one", () => {
    const { ctx, timers, out, amb } = setup();
    amb.setMode("night");
    run(ctx, timers, 10);
    const oldNodes = new Set(ctx.nodes);
    amb.setMode("night"); // no-op
    expect(ctx.nodes.length).toBe(oldNodes.size);
    amb.setMode("day");
    const [oldFade, newFade] = ctx.nodes.filter(
      (n): n is FakeGain => n instanceof FakeGain && n.outputs[0] === out,
    );
    expect(oldFade?.gain.valueAt(10 + 2.5)).toBeLessThan(0.001);
    expect(newFade?.gain.valueAt(10 + 2.5)).toBeCloseTo(1, 6);
    run(ctx, timers, 70);
    const hum = ctx.of(FakeOscillator).find((o) => o.frequency.value === noteFreq("C2"));
    expect(hum?.disconnected).toBe(true);
    expect(oldFade?.disconnected).toBe(true);
    expect(
      ctx
        .of(FakeOscillator)
        .some((o) => o.startTime !== null && o.startTime > 10 && o.frequency.targets()[0]! > 1000),
    ).toBe(true); // birds
  });

  it("stop fades out and releases everything", () => {
    const { ctx, timers, out, amb } = setup();
    amb.setMode("dusk");
    run(ctx, timers, 3);
    amb.stop(500);
    expect(amb.mode).toBeNull();
    run(ctx, timers, 5);
    for (const n of ctx.nodes)
      if (n !== ctx.destination && n !== out) expect(n.disconnected).toBe(true);
    amb.stop();
  });
});
