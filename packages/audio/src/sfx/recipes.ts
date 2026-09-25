/**
 * The synthesised UI sound set (research 03 §8.1, SPEC §13.7) as **data**: each recipe is a list
 * of oscillator and noise voices with envelopes. `plan.ts` turns a recipe into concrete,
 * pentatonic frequencies; `play.ts` renders the plan with WebAudio. Nothing is downloaded.
 *
 * Transcription notes (research value → recipe):
 * - Pitches are pentatonic note names. Research frequencies that are not C major pentatonic are
 *   quantised to the nearest pentatonic pitch, as the research's own pentatonic rule requires:
 *   `tick` 1200 Hz → D6, `chime` B5 → C6, `capture` sweep 500→180 Hz → C5→G3, `win` Cmaj7's B4
 *   → C5. 660/440/220 Hz are E5/A4/A3.
 * - Where the research gives a total length ("25 ms", "noise burst 40 ms") it is split into a
 *   short attack plus the decay. Where it gives no attack, the attack is {@link DEFAULT_ATTACK_MS}.
 *   Where it gives no peak, peaks are set so the mix sits under `pop` (0.25), the loudest.
 * - `vote` has no pitch in the research; it is G5, with its 4× harmonic (G7) at 10% gain.
 *
 * @module
 */
import type { PentatonicNote } from "../pentatonic.ts";

/** The core sound names (structurally identical to `@sg/engine`'s `SfxName`). */
export type SfxName =
  "pop" | "tick" | "tok" | "card" | "chime" | "success" | "fail" | "capture" | "win" | "vote";

/** Oscillator shapes: only the mellow ones (research 03 §8.1). */
export type OscType = "sine" | "triangle";

/** Attack used where the research gives none, in ms. */
export const DEFAULT_ATTACK_MS = 3;

/** A pitched oscillator voice. */
export interface ToneVoice {
  readonly kind: "tone";
  readonly type: OscType;
  /** The base note. */
  readonly note: PentatonicNote;
  /** Optional pitch glide target, reached `glideMs` after the voice starts. */
  readonly glideTo?: PentatonicNote;
  readonly glideMs?: number;
  /** Start offset from the trigger, in ms. */
  readonly atMs: number;
  readonly attackMs: number;
  readonly decayMs: number;
  /** Peak gain (linear). */
  readonly peak: number;
  /** Optional per-voice lowpass cutoff, in Hz. */
  readonly lowpassHz?: number;
}

/** A filtered white-noise burst. */
export interface NoiseVoice {
  readonly kind: "noise";
  readonly atMs: number;
  readonly attackMs: number;
  readonly decayMs: number;
  readonly peak: number;
  /** Filter; `toHz` sweeps the cutoff over the voice's length. */
  readonly filter: {
    readonly type: "bandpass" | "lowpass";
    readonly hz: number;
    readonly toHz?: number;
    readonly q: number;
  };
}

/** One voice of a recipe. */
export type Voice = ToneVoice | NoiseVoice;

/** Random high pentatonic notes scattered after a sting (`win`). */
export interface Sparkle {
  readonly count: number;
  /** The notes land within this many ms after `atMs`. */
  readonly spreadMs: number;
  readonly atMs: number;
  /** Inclusive pentatonic range the notes are drawn from. */
  readonly low: PentatonicNote;
  readonly high: PentatonicNote;
  readonly type: OscType;
  readonly attackMs: number;
  readonly decayMs: number;
  readonly peak: number;
}

/** A sound effect. */
export interface SfxRecipe {
  readonly name: SfxName;
  readonly voices: readonly Voice[];
  readonly sparkle?: Sparkle;
  /**
   * Repetitive sounds get ±1 pentatonic step of random variation per trigger (research 03 §8.1:
   * stops repetition fatigue). Melodic sounds (chime, success, fail, win) keep their shape.
   */
  readonly vary: boolean;
}

const tone = (v: Omit<ToneVoice, "kind">): ToneVoice => ({ kind: "tone", ...v });
const noise = (v: Omit<NoiseVoice, "kind">): NoiseVoice => ({ kind: "noise", ...v });

// tok: sine 220 Hz + a noise burst (8 ms, bandpass 900 Hz Q 1.5), D 120 ms.
const TOK: readonly Voice[] = [
  tone({
    type: "sine",
    note: "A3",
    atMs: 0,
    attackMs: DEFAULT_ATTACK_MS,
    decayMs: 120,
    peak: 0.22,
  }),
  noise({
    atMs: 0,
    attackMs: 1,
    decayMs: 7,
    peak: 0.12,
    filter: { type: "bandpass", hz: 900, q: 1.5 },
  }),
];

/** Every recipe, keyed by name. */
export const SFX_RECIPES: Readonly<Record<SfxName, SfxRecipe>> = {
  // Sine 660→440 Hz pitch drop over 60 ms, gain A 3 ms / D 90 ms, peak 0.25.
  pop: {
    name: "pop",
    vary: true,
    voices: [
      tone({
        type: "sine",
        note: "E5",
        glideTo: "A4",
        glideMs: 60,
        atMs: 0,
        attackMs: 3,
        decayMs: 90,
        peak: 0.25,
      }),
    ],
  },
  // Triangle 1200 Hz, 25 ms, peak 0.08, through lowpass 3 kHz.
  tick: {
    name: "tick",
    vary: true,
    voices: [
      tone({
        type: "triangle",
        note: "D6",
        atMs: 0,
        attackMs: DEFAULT_ATTACK_MS,
        decayMs: 22,
        peak: 0.08,
        lowpassHz: 3000,
      }),
    ],
  },
  // Pitch +1 pentatonic step per consecutive hop: callers pass `pitchStep`.
  tok: { name: "tok", vary: true, voices: TOK },
  // Noise burst 40 ms, bandpass sweeping 2 k→800 Hz, peak 0.12 ("fwip").
  card: {
    name: "card",
    vary: false,
    voices: [
      noise({
        atMs: 0,
        attackMs: 4,
        decayMs: 36,
        peak: 0.12,
        filter: { type: "bandpass", hz: 2000, toHz: 800, q: 1.2 },
      }),
    ],
  },
  // Two triangle notes E5 → B5 at 90 ms apart, D 500 ms, + a quiet sine an octave below.
  chime: {
    name: "chime",
    vary: false,
    voices: [
      tone({
        type: "triangle",
        note: "E5",
        atMs: 0,
        attackMs: DEFAULT_ATTACK_MS,
        decayMs: 500,
        peak: 0.16,
      }),
      tone({
        type: "triangle",
        note: "C6",
        atMs: 90,
        attackMs: DEFAULT_ATTACK_MS,
        decayMs: 500,
        peak: 0.16,
      }),
      tone({
        type: "sine",
        note: "E4",
        atMs: 0,
        attackMs: DEFAULT_ATTACK_MS,
        decayMs: 500,
        peak: 0.06,
      }),
    ],
  },
  // Arpeggio C5-E5-G5 at 60 ms steps, triangle, D 300 ms each.
  success: {
    name: "success",
    vary: false,
    voices: (["C5", "E5", "G5"] as const).map((note, i) =>
      tone({
        type: "triangle",
        note,
        atMs: i * 60,
        attackMs: DEFAULT_ATTACK_MS,
        decayMs: 300,
        peak: 0.14,
      }),
    ),
  },
  // Sine G4 → E4 glide 180 ms, D 250 ms (soft, never harsh).
  fail: {
    name: "fail",
    vary: false,
    voices: [
      tone({
        type: "sine",
        note: "G4",
        glideTo: "E4",
        glideMs: 180,
        atMs: 0,
        attackMs: DEFAULT_ATTACK_MS,
        decayMs: 250,
        peak: 0.16,
      }),
    ],
  },
  // tok + downward sine sweep 500→180 Hz over 200 ms ("bloop").
  capture: {
    name: "capture",
    vary: false,
    voices: [
      ...TOK,
      tone({
        type: "sine",
        note: "C5",
        glideTo: "G3",
        glideMs: 200,
        atMs: 0,
        attackMs: DEFAULT_ATTACK_MS,
        decayMs: 200,
        peak: 0.14,
      }),
    ],
  },
  // Cmaj7 triangle stack, A 20 ms, D 1.6 s, + 6 random pentatonic high notes over 800 ms.
  win: {
    name: "win",
    vary: false,
    voices: (["C4", "E4", "G4", "C5"] as const).map((note) =>
      tone({ type: "triangle", note, atMs: 0, attackMs: 20, decayMs: 1600, peak: 0.08 }),
    ),
    sparkle: {
      count: 6,
      spreadMs: 800,
      atMs: 60,
      low: "C6",
      high: "A6",
      type: "sine",
      attackMs: DEFAULT_ATTACK_MS,
      decayMs: 260,
      peak: 0.04,
    },
  },
  // Soft marimba-ish: sine + 4× harmonic at 10% gain, very short. Audience = purple = this.
  vote: {
    name: "vote",
    vary: true,
    voices: [
      tone({
        type: "sine",
        note: "G5",
        atMs: 0,
        attackMs: DEFAULT_ATTACK_MS,
        decayMs: 80,
        peak: 0.14,
      }),
      tone({
        type: "sine",
        note: "G7",
        atMs: 0,
        attackMs: DEFAULT_ATTACK_MS,
        decayMs: 40,
        peak: 0.014,
      }),
    ],
  },
};

/** Every sound name, in the SPEC §13.7 order. */
export const SFX_LIST: readonly SfxName[] = Object.freeze(Object.keys(SFX_RECIPES) as SfxName[]);

/**
 * The mode-switch swell (research 03 §8.1): filtered noise swelling over 0.6 s. Not an
 * `SfxName`; the ambience controller plays it on every mode change.
 */
export const MODE_SWELL: NoiseVoice = noise({
  atMs: 0,
  attackMs: 300,
  decayMs: 300,
  peak: 0.1,
  filter: { type: "lowpass", hz: 400, toHz: 2400, q: 0.7 },
});
