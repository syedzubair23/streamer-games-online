import { describe, expect, it } from "vitest";
import {
  DUCK_ATTACK_MS,
  DUCK_RELEASE_MS,
  REVEAL_DUCK_DB,
  SFX_LOWPASS_HZ,
  STREAMER_DUCK_DB,
  STREAMER_MUSIC_LEVEL,
  createBuses,
  dbToGain,
  levelToGain,
  withStreamerSafe,
  type AudioSettings,
} from "../src/index.ts";
import { FakeAudioContext, FakeBiquad, type FakeCompressor, type FakeGain } from "./fake-audio.ts";

const SETTINGS: AudioSettings = { music: 0.6, sfx: 0.8, ambience: 0.5, streamerSafe: false };

function setup(settings = SETTINGS) {
  const ctx = new FakeAudioContext();
  const buses = createBuses(ctx.asAudio, settings);
  const duck = buses.musicDuck as unknown as FakeGain;
  const at = (s: number): number => duck.gain.valueAt(s);
  return { ctx, buses, duck, at };
}

const db = (gain: number): number => 20 * Math.log10(gain);

describe("buses", () => {
  it("wires sfx → lowpass 7 kHz → gentle compressor → master, music → duck → master", () => {
    const { ctx, buses } = setup();
    const lp = buses.sfxLowpass as unknown as FakeBiquad;
    const comp = buses.compressor as unknown as FakeCompressor;
    expect(ctx.of(FakeBiquad)).toEqual([lp]);
    expect(lp.type).toBe("lowpass");
    expect(lp.frequency.value).toBe(SFX_LOWPASS_HZ);
    expect((buses.sfx as unknown as FakeGain).outputs).toEqual([lp]);
    expect(lp.outputs).toEqual([comp]);
    expect(comp.outputs).toEqual([buses.master]);
    expect(comp.ratio.value).toBeLessThanOrEqual(4); // gentle
    expect((buses.music as unknown as FakeGain).outputs).toEqual([buses.musicDuck]);
    expect((buses.musicDuck as unknown as FakeGain).outputs).toEqual([buses.master]);
    expect((buses.ambience as unknown as FakeGain).outputs).toEqual([buses.master]);
    expect((buses.master as unknown as FakeGain).outputs).toEqual([ctx.destination]);
  });

  it("levels use a squared taper and ramp without zipper", () => {
    expect(levelToGain(0.5)).toBe(0.25);
    expect(levelToGain(2)).toBe(1);
    expect(levelToGain(-1)).toBe(0);
    expect(levelToGain(Number.NaN)).toBe(0);
    const { ctx, buses } = setup();
    const music = buses.music as unknown as FakeGain;
    expect(music.gain.valueAt(0)).toBeCloseTo(0.36, 6);
    buses.apply({ ...SETTINGS, music: 1 });
    ctx.advance(1);
    expect(music.gain.valueAt(1)).toBeCloseTo(1, 3);
    expect(music.gain.valueAt(0.01)).toBeLessThan(0.9);
  });

  it("streamer-safe defaults music to 35% (pure settings helper)", () => {
    expect(withStreamerSafe(SETTINGS, true)).toEqual({
      ...SETTINGS,
      music: STREAMER_MUSIC_LEVEL,
      streamerSafe: true,
    });
    expect(withStreamerSafe({ ...SETTINGS, music: 0.2 }, true).music).toBe(0.2);
    expect(withStreamerSafe({ ...SETTINGS, streamerSafe: true, music: 0.35 }, false)).toEqual({
      ...SETTINGS,
      music: 0.35,
      streamerSafe: false,
    });
    expect(dbToGain(-20)).toBeCloseTo(0.1, 9);
  });
});

describe("music ducking works (ROADMAP M1-08 Accept 5)", () => {
  it("a reveal ducks the music 4 dB within the attack, then swells back after release", () => {
    const { ctx, buses, at } = setup();
    expect(at(0)).toBe(1);
    ctx.advance(1);
    const release = buses.duck();
    expect(buses.duckDb).toBe(REVEAL_DUCK_DB);
    expect(db(at(1 + DUCK_ATTACK_MS / 1000))).toBeCloseTo(-4, 0);
    expect(db(at(1.5))).toBeCloseTo(-4, 2);
    ctx.advance(3);
    release();
    release(); // idempotent
    expect(buses.duckDb).toBe(0);
    expect(db(at(3.2))).toBeLessThan(-1); // swells, does not snap
    expect(db(at(3 + (DUCK_RELEASE_MS / 1000) * 2))).toBeGreaterThan(-0.05);
  });

  it("streamer-safe holds −12 dB; the deepest hold wins and ducks nest", () => {
    const { ctx, buses, at } = setup({ ...SETTINGS, streamerSafe: true });
    ctx.advance(2);
    expect(buses.duckDb).toBe(STREAMER_DUCK_DB);
    expect(db(at(2))).toBeCloseTo(-12, 1);
    const reveal = buses.duck();
    expect(buses.duckDb).toBe(STREAMER_DUCK_DB);
    reveal();
    buses.apply({ ...SETTINGS, streamerSafe: false });
    expect(buses.duckDb).toBe(0);
    ctx.advance(4);
    expect(db(at(4))).toBeGreaterThan(-0.05);

    const a = buses.duck(4);
    const b = buses.duck(8);
    expect(buses.duckDb).toBe(8);
    b();
    expect(buses.duckDb).toBe(4);
    ctx.advance(6);
    expect(db(at(6))).toBeCloseTo(-4, 2);
    a();
    expect(buses.duckDb).toBe(0);
    buses.apply({ ...SETTINGS, streamerSafe: true });
    buses.apply({ ...SETTINGS, streamerSafe: true });
    expect(buses.duckDb).toBe(12);
  });

  it("ducking touches only the music: sfx and ambience keep their gain", () => {
    const { ctx, buses } = setup();
    ctx.advance(1);
    buses.duck(12);
    ctx.advance(2);
    expect((buses.sfx as unknown as FakeGain).gain.valueAt(2)).toBeCloseTo(0.64, 6);
    expect((buses.ambience as unknown as FakeGain).gain.valueAt(2)).toBeCloseTo(0.25, 6);
  });

  it("dispose disconnects every bus node", () => {
    const { ctx, buses } = setup();
    buses.dispose();
    for (const n of ctx.nodes) if (n !== ctx.destination) expect(n.disconnected).toBe(true);
  });
});
