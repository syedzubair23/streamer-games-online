/**
 * Recipe → plan: concrete frequencies and times for one trigger, with no WebAudio involved (so
 * the pentatonic rule is unit-testable on the frequencies themselves).
 *
 * - `pitchStep` moves every pitched voice that many pentatonic steps (e.g. `tok` rises one step
 *   per consecutive hop), clamped to {@link PITCH_STEP_RANGE}.
 * - Recipes with `vary` add a random −1/0/+1 step per trigger.
 * - Every pitched voice gets ±{@link DETUNE_CENTS} of random detune, applied through the
 *   oscillator's `detune` parameter; its `hz`/`toHz` stay exact pentatonic pitches.
 *
 * @module
 */
import type { Rng } from "@sg/shared";
import { freqMidi, noteFreq, noteMidi, stepFreq, type PentatonicNote } from "../pentatonic.ts";
import type { NoiseVoice, OscType, SfxRecipe } from "./recipes.ts";

/** Maximum random detune per voice, in cents (research 03 §8.1). */
export const DETUNE_CENTS = 2;
/** Allowed `pitchStep` range, in pentatonic steps. */
export const PITCH_STEP_RANGE = { min: -5, max: 10 } as const;

/** A pitched voice with concrete values. */
export interface PlannedTone {
  kind: "tone";
  type: OscType;
  atMs: number;
  attackMs: number;
  decayMs: number;
  peak: number;
  /** Start frequency (exact pentatonic pitch). */
  hz: number;
  /** Glide target (exact pentatonic pitch). */
  toHz?: number;
  glideMs?: number;
  /** Random detune in cents, |detune| ≤ {@link DETUNE_CENTS}. */
  detune: number;
  lowpassHz?: number;
}

/** A noise voice (unpitched; filter values are not pitches). */
export type PlannedNoise = NoiseVoice;

/** One voice of a plan. */
export type PlannedVoice = PlannedTone | PlannedNoise;

/** Options of one trigger. */
export interface PlanOptions {
  pitchStep?: number;
}

/** Clamps a requested pitch step to {@link PITCH_STEP_RANGE} (non-finite → 0). */
export function clampPitchStep(step: number | undefined): number {
  if (step === undefined || !Number.isFinite(step)) return 0;
  return Math.max(PITCH_STEP_RANGE.min, Math.min(PITCH_STEP_RANGE.max, Math.trunc(step)));
}

/** The pentatonic notes from `low` to `high`, inclusive, as frequencies. */
export function pentatonicRange(low: PentatonicNote, high: PentatonicNote): number[] {
  const out: number[] = [];
  const top = noteMidi(high);
  for (let hz = noteFreq(low); Math.round(freqMidi(hz)) <= top; hz = stepFreq(hz, 1)) out.push(hz);
  return out;
}

/** Plans one trigger of `recipe`. Deterministic for a given `rng` state. */
export function planSfx(recipe: SfxRecipe, rng: Rng, o: PlanOptions = {}): PlannedVoice[] {
  const steps = clampPitchStep(o.pitchStep) + (recipe.vary ? rng.int(3) - 1 : 0);
  const detune = (): number => (rng.float() * 2 - 1) * DETUNE_CENTS;
  const out: PlannedVoice[] = [];
  for (const v of recipe.voices) {
    if (v.kind === "noise") {
      out.push(v);
      continue;
    }
    const p: PlannedTone = {
      kind: "tone",
      type: v.type,
      atMs: v.atMs,
      attackMs: v.attackMs,
      decayMs: v.decayMs,
      peak: v.peak,
      hz: stepFreq(noteFreq(v.note), steps),
      detune: detune(),
    };
    if (v.glideTo !== undefined) {
      p.toHz = stepFreq(noteFreq(v.glideTo), steps);
      p.glideMs = v.glideMs ?? v.decayMs;
    }
    if (v.lowpassHz !== undefined) p.lowpassHz = v.lowpassHz;
    out.push(p);
  }
  const s = recipe.sparkle;
  if (s) {
    const notes = pentatonicRange(s.low, s.high);
    const slot = s.spreadMs / s.count;
    for (let i = 0; i < s.count; i++)
      out.push({
        kind: "tone",
        type: s.type,
        atMs: s.atMs + i * slot + rng.float() * slot * 0.6,
        attackMs: s.attackMs,
        decayMs: s.decayMs,
        peak: s.peak * (0.7 + rng.float() * 0.3),
        hz: rng.pick(notes),
        detune: detune(),
      });
  }
  return out;
}

/** Length of a planned trigger in ms (last voice's end). */
export function planLengthMs(plan: readonly PlannedVoice[]): number {
  let end = 0;
  for (const v of plan) end = Math.max(end, v.atMs + v.attackMs + v.decayMs);
  return end;
}
