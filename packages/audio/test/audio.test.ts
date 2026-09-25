import { describe, expect, it } from "vitest";
import { STREAM_SAFE_LABEL, createAudio, type AudioSettings } from "../src/index.ts";
import {
  FakeAudioContext,
  FakeBufferSource,
  FakeDocument,
  type FakeGain,
  flush,
} from "./fake-audio.ts";

function setup(settings?: AudioSettings) {
  const doc = new FakeDocument();
  const ctx = new FakeAudioContext();
  const audio = createAudio({
    doc,
    create: () => ctx.asAudio,
    mode: "rain",
    seed: 1,
    ...(settings ? { settings } : {}),
  });
  return { doc, ctx, audio };
}

const duckGain = (audio: ReturnType<typeof createAudio>): FakeGain =>
  audio.buses!.musicDuck as unknown as FakeGain;

describe("createAudio (the shell's audio system)", () => {
  it("does nothing audible before unlock, then builds buses and the mode's bed", async () => {
    const { ctx, audio } = setup();
    audio.sfx("pop");
    audio.setMusic(true);
    expect(audio.host.ctx).toBeNull();
    expect(audio.buses).toBeNull();
    expect(ctx.nodes).toHaveLength(1);
    await audio.unlock();
    expect(audio.buses).not.toBeNull();
    // Rain bed (2 looping layers) + lofi hiss = 3 looping sources.
    expect(ctx.of(FakeBufferSource).filter((s) => s.loop)).toHaveLength(3);
    const before = ctx.nodes.length;
    audio.sfx("pop");
    expect(ctx.nodes.length).toBeGreaterThan(before);
    await audio.dispose();
    expect(ctx.state).toBe("closed");
  });

  it("applies settings: levels and the streamer-safe −12 dB duck", async () => {
    const { ctx, audio } = setup({ music: 0.5, sfx: 1, ambience: 0, streamerSafe: false });
    await audio.unlock();
    expect((audio.buses!.sfx as unknown as FakeGain).gain.valueAt(0)).toBe(1);
    audio.applySettings({ music: 0.5, sfx: 1, ambience: 0, streamerSafe: true });
    expect(audio.settings.streamerSafe).toBe(true);
    ctx.advance(2);
    expect(20 * Math.log10(duckGain(audio).gain.valueAt(2))).toBeCloseTo(-12, 1);
  });

  it("replays reveal ducks taken before unlock, and releases them", async () => {
    const { ctx, audio } = setup();
    const release = audio.duck();
    const gone = audio.duck(8);
    gone();
    gone();
    await audio.unlock();
    expect(audio.buses!.duckDb).toBe(4);
    ctx.advance(1);
    release();
    release();
    expect(audio.buses!.duckDb).toBe(0);
    const later = audio.duck(6);
    expect(audio.buses!.duckDb).toBe(6);
    later();
  });

  it("setMode swells, crossfades the bed and restyles the music; toggles work", async () => {
    const { ctx, audio } = setup();
    await audio.unlock();
    audio.setMusic(true);
    expect(audio.mode).toBe("rain");
    audio.setMode("rain");
    const before = ctx.nodes.length;
    audio.setMode("night");
    expect(audio.mode).toBe("night");
    expect(ctx.nodes.length).toBeGreaterThan(before);
    audio.setAmbience(false);
    audio.setMusic(false);
    ctx.advance(5);
    const loops = ctx.of(FakeBufferSource).filter((s) => s.loop);
    expect(loops.every((s) => s.stopTime !== null)).toBe(true);
    audio.setAmbience(true);
    expect(
      ctx.of(FakeBufferSource).filter((s) => s.loop && s.stopTime === null).length,
    ).toBeGreaterThan(0);
  });

  it("while hidden the mode still changes but no swell is played", async () => {
    const { doc, ctx, audio } = setup();
    await audio.unlock();
    doc.setVisibility("hidden");
    await flush();
    const swells = (): number => ctx.of(FakeBufferSource).filter((s) => !s.loop).length;
    const n = swells();
    audio.setMode("snow");
    expect(swells()).toBe(n);
    expect(audio.mode).toBe("snow");
  });

  it("labels the audio stream-safe", () => {
    expect(STREAM_SAFE_LABEL).toBe("Stream-safe audio ✓");
  });
});
