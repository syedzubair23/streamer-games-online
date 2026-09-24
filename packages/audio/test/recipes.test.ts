import { describe, expect, it } from "vitest";
import {
  DEFAULT_ATTACK_MS,
  MODE_SWELL,
  SFX_LIST,
  SFX_RECIPES,
  centsOff,
  noteFreq,
  quantize,
  type NoiseVoice,
  type ToneVoice,
} from "../src/index.ts";
import { RESEARCH_8_1, type FixtureNoise, type FixtureTone } from "./fixtures/research-8-1.ts";

const close = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe("SFX recipes equal the research 03 §8.1 fixture table (ROADMAP M1-08 Accept 1)", () => {
  it("has exactly the SPEC §13.7 core set, in order", () => {
    expect(SFX_LIST).toEqual([
      "pop",
      "tick",
      "tok",
      "card",
      "chime",
      "success",
      "fail",
      "capture",
      "win",
      "vote",
    ]);
    expect(Object.keys(RESEARCH_8_1).sort()).toEqual([...SFX_LIST].sort());
  });

  for (const name of SFX_LIST) {
    const fixture = RESEARCH_8_1[name];
    if (!fixture) throw new Error(`no fixture for ${name}`);
    it(`${name}: oscillator types, envelope ms, base notes, peaks and filters`, () => {
      const recipe = SFX_RECIPES[name];
      expect(recipe.name).toBe(name);
      expect(recipe.voices).toHaveLength(fixture.voices.length);
      fixture.voices.forEach((fv, i) => {
        const rv = recipe.voices[i];
        expect(rv?.kind, `voice ${i}`).toBe(fv.kind);
        if (fv.kind === "tone") checkTone(rv as ToneVoice, fv, recipe.voices as ToneVoice[]);
        else checkNoise(rv as NoiseVoice, fv);
      });
      if (fixture.sparkle) {
        expect(recipe.sparkle?.count).toBe(fixture.sparkle.count);
        expect(recipe.sparkle?.spreadMs).toBe(fixture.sparkle.spreadMs);
      } else expect(recipe.sparkle).toBeUndefined();
    });
  }

  it("pop is the loudest sound (peak 0.25); nothing exceeds it", () => {
    for (const r of Object.values(SFX_RECIPES))
      for (const v of r.voices) expect(v.peak).toBeLessThanOrEqual(0.25);
    expect(MODE_SWELL.peak).toBeLessThanOrEqual(0.25);
  });

  it("only mellow waves (sine, triangle) are used", () => {
    for (const r of Object.values(SFX_RECIPES))
      for (const v of r.voices)
        if (v.kind === "tone") expect(["sine", "triangle"]).toContain(v.type);
  });

  it("mode switch: a filtered noise swell of 0.6 s", () => {
    expect(MODE_SWELL.kind).toBe("noise");
    expect(MODE_SWELL.attackMs + MODE_SWELL.decayMs).toBe(600);
    expect(MODE_SWELL.filter.toHz).toBeGreaterThan(MODE_SWELL.filter.hz);
  });
});

function checkTone(rv: ToneVoice, fv: FixtureTone, all: ToneVoice[]): void {
  expect(rv.type).toBe(fv.type);
  if (fv.relativeTo) {
    const base = all[fv.relativeTo.index] as ToneVoice;
    close(noteFreq(rv.note) / noteFreq(base.note), fv.relativeTo.ratio);
    close(rv.peak / base.peak, fv.relativeTo.gain);
  } else if (fv.hz > 0) {
    // The base note is the research pitch, snapped to C major pentatonic (never > 1 semitone).
    close(noteFreq(rv.note), quantize(fv.hz));
    expect(centsOff(fv.hz)).toBeLessThanOrEqual(100);
  }
  if (fv.glideToHz !== undefined) {
    expect(rv.glideTo).toBeDefined();
    close(noteFreq(rv.glideTo as ToneVoice["note"]), quantize(fv.glideToHz));
    expect(rv.glideMs).toBe(fv.glideMs);
  } else expect(rv.glideTo).toBeUndefined();
  expect(rv.atMs).toBe(fv.atMs ?? 0);
  if (fv.totalMs !== undefined) {
    expect(rv.attackMs + rv.decayMs).toBe(fv.totalMs);
    expect(rv.attackMs).toBe(fv.attackMs ?? DEFAULT_ATTACK_MS);
  } else {
    expect(rv.attackMs).toBe(fv.attackMs ?? (fv.relativeTo ? rv.attackMs : DEFAULT_ATTACK_MS));
    if (fv.decayMs !== undefined) expect(rv.decayMs).toBe(fv.decayMs);
    else if (fv.glideMs !== undefined) expect(rv.decayMs).toBeGreaterThanOrEqual(fv.glideMs);
  }
  if (fv.peak !== undefined) expect(rv.peak).toBe(fv.peak);
  expect(rv.lowpassHz).toBe(fv.lowpassHz);
}

function checkNoise(rv: NoiseVoice, fv: FixtureNoise): void {
  expect(rv.attackMs + rv.decayMs).toBe(fv.totalMs);
  expect(rv.filter.type).toBe(fv.filter.type);
  expect(rv.filter.hz).toBe(fv.filter.hz);
  expect(rv.filter.toHz).toBe(fv.filter.toHz);
  if (fv.filter.q !== undefined) expect(rv.filter.q).toBe(fv.filter.q);
  if (fv.peak !== undefined) expect(rv.peak).toBe(fv.peak);
}
