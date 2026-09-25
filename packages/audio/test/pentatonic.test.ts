import { createRng } from "@sg/shared";
import { describe, expect, it } from "vitest";
import {
  BEDS,
  BIRD_NOTES,
  CHORD_SETS,
  CRICKET_HZ,
  DETUNE_CENTS,
  DRUM_PITCH,
  PENTATONIC_PCS,
  SFX_LIST,
  SFX_RECIPES,
  centsOff,
  createAmbience,
  createLofi,
  createSfxPlayer,
  freqMidi,
  isPentatonic,
  lofiBar,
  midiFreq,
  noteFreq,
  noteMidi,
  planBird,
  planCricket,
  planSfx,
  quantize,
  quantizeMidi,
  stepFreq,
  type PentatonicNote,
} from "../src/index.ts";
import { FakeAudioContext, FakeOscillator, FakeTimers, run } from "./fake-audio.ts";

const expectPentatonic = (hz: number, what: string): void => {
  expect(isPentatonic(hz), `${what}: ${hz} Hz is ${centsOff(hz).toFixed(3)} cents off`).toBe(true);
};

describe("pentatonic quantiser", () => {
  it("uses 12-TET with A4 = 440 and names C D E G A only", () => {
    expect(noteFreq("A4")).toBe(440);
    expect(noteFreq("C4")).toBeCloseTo(261.6256, 3);
    expect(noteFreq("E5")).toBeCloseTo(659.2551, 3);
    expect(noteMidi("C-1")).toBe(0);
    expect(midiFreq(freqMidi(1234))).toBeCloseTo(1234, 9);
    expect(PENTATONIC_PCS).toEqual([0, 2, 4, 7, 9]);
    expect(() => noteFreq("F4" as PentatonicNote)).toThrow(RangeError);
    expect(() => noteFreq("B3" as PentatonicNote)).toThrow(RangeError);
  });

  it("snaps to the nearest pentatonic pitch by cents", () => {
    expect(quantize(1200)).toBe(noteFreq("D6"));
    expect(quantize(noteFreq("A4") * 2 ** (1 / 12) * 2)).toBe(noteFreq("A5")); // A#5 → A5 (100 vs 200 cents)
    expect(quantize(987.77)).toBe(noteFreq("C6")); // B5 → C6
    expect(quantize(500)).toBe(noteFreq("C5"));
    expect(quantize(180)).toBe(noteFreq("G3"));
    expect(quantize(4500)).toBe(noteFreq("D8"));
    expect(quantize(349.23)).toBe(noteFreq("E4")); // F4 → E4
    // C#4 is equidistant from C4 and D4: ties go down.
    expect(quantizeMidi(midiFreq(61))).toBe(60);
    expect(quantizeMidi(midiFreq(68))).toBe(67);
    for (let hz = 30; hz < 12000; hz *= 1.013) expectPentatonic(quantize(hz), `quantize(${hz})`);
  });

  it("steps along the scale (5 steps per octave)", () => {
    expect(stepFreq(noteFreq("A3"), 1)).toBe(noteFreq("C4"));
    expect(stepFreq(noteFreq("C4"), -1)).toBe(noteFreq("A3"));
    expect(stepFreq(noteFreq("C4"), 5)).toBeCloseTo(noteFreq("C5"), 9);
    expect(stepFreq(noteFreq("E5"), 0)).toBe(noteFreq("E5"));
    expect(isPentatonic(440 * 2 ** (1 / 12))).toBe(false);
    expect(isPentatonic(Number.NaN)).toBe(false);
    expect(isPentatonic(-1)).toBe(false);
  });
});

describe("every pitched sound is quantised to C major pentatonic (ROADMAP M1-08 Accept 2)", () => {
  it("sfx plans: every recipe × pitchStep −8..14 × 200 seeds (incl. win sparkles)", () => {
    for (const name of SFX_LIST)
      for (let step = -8; step <= 14; step++) {
        const rng = createRng(`${name}:${step}`);
        for (let i = 0; i < 200; i++)
          for (const v of planSfx(SFX_RECIPES[name], rng, { pitchStep: step })) {
            if (v.kind !== "tone") continue;
            expectPentatonic(v.hz, `${name} step ${step}`);
            if (v.toHz !== undefined) expectPentatonic(v.toHz, `${name} glide`);
            expect(Math.abs(v.detune)).toBeLessThanOrEqual(DETUNE_CENTS);
          }
      }
  });

  it("tok rises one pentatonic step per consecutive hop", () => {
    const plain = { ...SFX_RECIPES.tok, vary: false };
    const base = (step: number): number => {
      const v = planSfx(plain, createRng(1), { pitchStep: step })[0];
      if (v?.kind !== "tone") throw new Error("tok voice 0 is a tone");
      return v.hz;
    };
    for (let hop = 0; hop < 8; hop++) expect(base(hop + 1)).toBe(stepFreq(base(hop), 1));
  });

  it("the renderer sets only pentatonic frequencies on audible oscillators", () => {
    const ctx = new FakeAudioContext();
    const player = createSfxPlayer(ctx.asAudio, ctx.destination as unknown as AudioNode, {
      rng: createRng(7),
      minIntervalMs: 0,
      maxVoices: 10_000,
    });
    for (let i = 0; i < 50; i++)
      for (const name of SFX_LIST) {
        ctx.advance(ctx.currentTime + 0.01);
        expect(player.play(name, { pitchStep: i % 9 })).toBe(true);
      }
    const oscs = ctx.of(FakeOscillator);
    expect(oscs.length).toBeGreaterThan(500);
    for (const o of oscs) {
      for (const hz of o.frequency.targets()) expectPentatonic(hz, "sfx oscillator");
      for (const c of o.detune.targets()) expect(Math.abs(c)).toBeLessThanOrEqual(DETUNE_CENTS);
    }
  });

  it("ambience: hums, cricket (4.5 kHz → D8) and bird phrases", () => {
    expectPentatonic(CRICKET_HZ, "cricket");
    expect(CRICKET_HZ).toBe(quantize(4500));
    for (const hz of BIRD_NOTES) expectPentatonic(hz, "bird range");
    for (const bed of Object.values(BEDS))
      for (const l of bed.layers) if (l.kind === "hum") expectPentatonic(noteFreq(l.note), "hum");
    const rng = createRng("events");
    for (let i = 0; i < 500; i++) {
      for (const b of [...planBird(rng), ...planCricket(rng)]) {
        expectPentatonic(b.hz, "blip");
        expectPentatonic(b.toHz, "blip glide");
      }
    }
  });

  it("lofi: chord sets, bass, lead and drum pitches over 400 bars", () => {
    for (const set of CHORD_SETS)
      for (const c of set)
        for (const n of [c.root, ...c.voicing]) expectPentatonic(noteFreq(n), `${c.fn} ${n}`);
    for (const hz of Object.values(DRUM_PITCH)) expectPentatonic(hz, "drum");
    const rng = createRng("bars");
    for (let bar = 0; bar < 400; bar++)
      for (const e of lofiBar(CHORD_SETS[bar % 4] as (typeof CHORD_SETS)[number], bar, rng)) {
        if (e.kind === "chord") for (const hz of e.hz) expectPentatonic(hz, "chord");
        if (e.kind === "bass" || e.kind === "lead") expectPentatonic(e.hz, e.kind);
      }
  });

  it("rendered ambience and lofi: every audio-rate oscillator frequency is pentatonic", () => {
    const ctx = new FakeAudioContext();
    ctx.state = "running";
    const timers = new FakeTimers();
    const out = ctx.createGain() as unknown as AudioNode;
    const amb = createAmbience(ctx.asAudio, out, { scheduler: { timers } });
    const lofi = createLofi(ctx.asAudio, out, { mode: "night", scheduler: { timers } });
    for (const mode of ["day", "night", "rain", "dusk", "snow"] as const) {
      amb.setMode(mode, 100);
      lofi.setMode(mode);
      run(ctx, timers, ctx.currentTime + 30);
    }
    const oscs = ctx.of(FakeOscillator);
    expect(oscs.length).toBeGreaterThan(300);
    let audible = 0;
    for (const o of oscs) {
      const hzs = o.frequency.targets();
      // Sub-audio control LFOs (tremolo 4 Hz, wind 0.07 Hz) are modulators, not pitches.
      if (hzs.every((hz) => hz < 20)) continue;
      audible++;
      for (const hz of hzs) expectPentatonic(hz, "rendered oscillator");
      for (const c of o.detune.targets()) expect(Math.abs(c)).toBeLessThanOrEqual(3);
    }
    expect(audible).toBeGreaterThan(300);
  });
});
