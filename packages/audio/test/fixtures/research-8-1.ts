/**
 * Research 03 §8.1 ("Synthesised UI sfx"), transcribed by hand from the table, value for value.
 * Pitches are the research's own values (Hz, or note names converted with plain 12-TET, A4 =
 * 440), **before** pentatonic quantisation; the test quantises them with the package's rule.
 * `totalMs` is used where the research gives a length instead of an attack/decay split.
 * Fields the research leaves open are simply absent.
 *
 * | Sound | Recipe (research) |
 * |---|---|
 * | pop | Sine 660→440 Hz pitch drop over 60 ms, gain A 3 ms / D 90 ms, peak 0.25 |
 * | tick | Triangle 1200 Hz, 25 ms, peak 0.08, through lowpass 3 kHz |
 * | tok | Sine 220 Hz + a noise burst (8 ms, bandpass 900 Hz Q 1.5), D 120 ms. +1 step per hop |
 * | card | Noise burst 40 ms, bandpass sweeping 2 k→800 Hz, peak 0.12 |
 * | chime | Two triangle notes E5 → B5 at 90 ms apart, D 500 ms, + a quiet sine an octave below |
 * | success | Arpeggio C5-E5-G5 at 60 ms steps, triangle, D 300 ms each |
 * | fail | Sine G4 → E4 glide 180 ms, D 250 ms |
 * | capture | tok + downward sine sweep 500→180 Hz over 200 ms |
 * | win | Cmaj7 triangle stack, A 20 ms, D 1.6 s, + 6 random pentatonic high notes over 800 ms |
 * | vote | sine + 4× harmonic at 10% gain, very short |
 */

const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Plain 12-TET, independent of the package under test. */
export function hzOf(note: string): number {
  const m = /^([A-G])(\d)$/.exec(note);
  if (!m) throw new Error(note);
  const midi = 12 * (Number(m[2]) + 1) + (LETTERS[m[1] as string] as number);
  return 440 * 2 ** ((midi - 69) / 12);
}

export interface FixtureTone {
  kind: "tone";
  type: "sine" | "triangle";
  hz: number;
  glideToHz?: number;
  glideMs?: number;
  atMs?: number;
  attackMs?: number;
  decayMs?: number;
  totalMs?: number;
  peak?: number;
  lowpassHz?: number;
  /** Gain relative to another voice of the sound (vote's harmonic). */
  relativeTo?: { index: number; gain: number; ratio: number };
}

export interface FixtureNoise {
  kind: "noise";
  totalMs: number;
  filter: { type: "bandpass" | "lowpass"; hz: number; toHz?: number; q?: number };
  peak?: number;
}

export interface FixtureSound {
  voices: (FixtureTone | FixtureNoise)[];
  sparkle?: { count: number; spreadMs: number };
  /** Supports the per-hop pitch step. */
  hops?: boolean;
}

const TOK: (FixtureTone | FixtureNoise)[] = [
  { kind: "tone", type: "sine", hz: 220, decayMs: 120 },
  { kind: "noise", totalMs: 8, filter: { type: "bandpass", hz: 900, q: 1.5 } },
];

export const RESEARCH_8_1: Record<string, FixtureSound> = {
  pop: {
    voices: [
      {
        kind: "tone",
        type: "sine",
        hz: 660,
        glideToHz: 440,
        glideMs: 60,
        attackMs: 3,
        decayMs: 90,
        peak: 0.25,
      },
    ],
  },
  tick: {
    voices: [
      { kind: "tone", type: "triangle", hz: 1200, totalMs: 25, peak: 0.08, lowpassHz: 3000 },
    ],
  },
  tok: { voices: TOK, hops: true },
  card: {
    voices: [
      { kind: "noise", totalMs: 40, filter: { type: "bandpass", hz: 2000, toHz: 800 }, peak: 0.12 },
    ],
  },
  chime: {
    voices: [
      { kind: "tone", type: "triangle", hz: hzOf("E5"), atMs: 0, decayMs: 500 },
      { kind: "tone", type: "triangle", hz: hzOf("B5"), atMs: 90, decayMs: 500 },
      { kind: "tone", type: "sine", hz: hzOf("E4"), decayMs: 500 },
    ],
  },
  success: {
    voices: ["C5", "E5", "G5"].map((n, i) => ({
      kind: "tone" as const,
      type: "triangle" as const,
      hz: hzOf(n),
      atMs: i * 60,
      decayMs: 300,
    })),
  },
  fail: {
    voices: [
      {
        kind: "tone",
        type: "sine",
        hz: hzOf("G4"),
        glideToHz: hzOf("E4"),
        glideMs: 180,
        decayMs: 250,
      },
    ],
  },
  capture: {
    voices: [...TOK, { kind: "tone", type: "sine", hz: 500, glideToHz: 180, glideMs: 200 }],
  },
  win: {
    voices: ["C4", "E4", "G4", "B4"].map((n) => ({
      kind: "tone" as const,
      type: "triangle" as const,
      hz: hzOf(n),
      attackMs: 20,
      decayMs: 1600,
    })),
    sparkle: { count: 6, spreadMs: 800 },
  },
  vote: {
    voices: [
      { kind: "tone", type: "sine", hz: 0 },
      { kind: "tone", type: "sine", hz: 0, relativeTo: { index: 0, gain: 0.1, ratio: 4 } },
    ],
  },
};
