/**
 * The generative lofi loop (research 03 §8.2 option A, SPEC §13.7): a 4-bar ii–V–I–vi
 * progression in Rhodes-ish voicings (sine + detuned triangle through a 4 Hz tremolo), a bass,
 * a sparse pentatonic lead, a noise/sine kick and snare, swung hats (58%) at 72–84 BPM, a vinyl
 * crackle (sparse clicks + lowpassed hiss at −38 dB) and a mode-dependent "tape" lowpass.
 *
 * **Pentatonic voicings.** The pentatonic rule covers every pitched sound, so the progression
 * keeps its functions (roots D, G, C, A) but voices each chord with C major pentatonic tones
 * only (no F, no B): open, quartal voicings such as D–A–C–E for ii and C–G–D–E for I, which is
 * the airy lofi colour anyway. There are 4 chord sets; each mode plays them in its own seeded
 * order, swapping set every 4 bars. Mode changes take effect on the next bar line.
 *
 * `lofiBar` is pure (events in beats); `createLofi` schedules them with the look-ahead scheduler.
 *
 * @module
 */
import { createRng, type AmbientMode, type Rng } from "@sg/shared";
import { dbToGain } from "./buses.ts";
import { noteFreq, type PentatonicNote } from "./pentatonic.ts";
import { createScheduler, type SchedulerOptions } from "./scheduler.ts";
import { noiseSource } from "./sfx/noise.ts";

/** Harmonic function of a chord in the progression. */
export type ChordFn = "ii" | "V" | "I" | "vi";

/** One chord: its function, bass root and Rhodes voicing (all pentatonic). */
export interface Chord {
  readonly fn: ChordFn;
  readonly root: PentatonicNote;
  readonly voicing: readonly PentatonicNote[];
}

/** A 4-chord ii–V–I–vi set. */
export type ChordSet = readonly [Chord, Chord, Chord, Chord];

/** The progression's functions, in order. */
export const PROGRESSION: readonly ChordFn[] = ["ii", "V", "I", "vi"];

const ROOTS: readonly PentatonicNote[] = ["D2", "G2", "C2", "A1"];

const chordSet = (v: readonly (readonly PentatonicNote[])[]): ChordSet =>
  PROGRESSION.map((fn, i) => ({
    fn,
    root: ROOTS[i] as PentatonicNote,
    voicing: v[i] as readonly PentatonicNote[],
  })) as unknown as ChordSet;

/** The 4 chord sets. */
export const CHORD_SETS: readonly ChordSet[] = [
  chordSet([
    ["D3", "A3", "C4", "E4"],
    ["G3", "D4", "E4", "A4"],
    ["C3", "G3", "D4", "E4"],
    ["A2", "G3", "C4", "E4"],
  ]),
  chordSet([
    ["D3", "G3", "C4", "E4"],
    ["G3", "C4", "D4", "A4"],
    ["C3", "G3", "A3", "E4"],
    ["A2", "E3", "G3", "D4"],
  ]),
  chordSet([
    ["D3", "E3", "A3", "C4"],
    ["G2", "D3", "A3", "C4"],
    ["C3", "E3", "A3", "D4"],
    ["A2", "C3", "G3", "E4"],
  ]),
  chordSet([
    ["D3", "C4", "E4", "A4"],
    ["G3", "D4", "E4", "A4"],
    ["C3", "E4", "G4", "D5"],
    ["A3", "C4", "E4", "G4"],
  ]),
];

/** Swing: the off-beat 8th lands at 58% of the beat (research 03 §8.2). */
export const SWING = 0.58;
/** Tempo range (research 03 §8.2). */
export const BPM_RANGE = { min: 72, max: 84 } as const;
/** Vinyl hiss level (research 03 §8.2). */
export const HISS_DB = -38;

/** Per-mode style: base tempo and tape lowpass. */
export const MODE_STYLE: Readonly<Record<AmbientMode, { bpm: number; tapeHz: number }>> = {
  day: { bpm: 82, tapeHz: 5200 },
  dusk: { bpm: 78, tapeHz: 4200 },
  night: { bpm: 74, tapeHz: 3000 },
  rain: { bpm: 75, tapeHz: 3400 },
  snow: { bpm: 77, tapeHz: 3800 },
};

const LEAD_NOTES: readonly PentatonicNote[] = ["C5", "D5", "E5", "G5", "A5"];
const FIFTH: Readonly<Record<string, PentatonicNote>> = { D2: "A2", G2: "D3", C2: "G2", A1: "E2" };

/** One scheduled musical event, in beats from the bar start. */
export type LofiEvent =
  | { kind: "chord"; beat: number; beats: number; hz: number[]; level: number }
  | { kind: "bass" | "lead"; beat: number; beats: number; hz: number; level: number }
  | { kind: "kick" | "snare" | "hat" | "click"; beat: number; level: number };

/** Kick sweep endpoints and snare body (pentatonic): C3→A1 and G3. */
export const DRUM_PITCH = {
  kickFrom: noteFreq("C3"),
  kickTo: noteFreq("A1"),
  snare: noteFreq("G3"),
} as const;

/** The events of bar `bar` (0–3 → ii, V, I, vi) of `chords`. Pure for a given `rng` state. */
export function lofiBar(chords: ChordSet, bar: number, rng: Rng): LofiEvent[] {
  const c = chords[((bar % 4) + 4) % 4] as Chord;
  const hz = c.voicing.map(noteFreq);
  const ev: LofiEvent[] = [];
  const off = (beat: number): number => beat + SWING;
  const restrike = rng.bool(0.7);
  ev.push({ kind: "chord", beat: 0, beats: restrike ? 2.4 : 3.9, hz, level: 1 });
  if (restrike) ev.push({ kind: "chord", beat: off(2), beats: 1.3, hz, level: 0.75 });
  ev.push({ kind: "bass", beat: 0, beats: 1.8, hz: noteFreq(c.root), level: 1 });
  ev.push({
    kind: "bass",
    beat: off(2),
    beats: 1.2,
    hz: noteFreq(rng.bool(0.5) ? (FIFTH[c.root] as PentatonicNote) : c.root),
    level: 0.8,
  });
  for (let b = 1; b < 4; b++)
    if (rng.bool(0.28))
      ev.push({
        kind: "lead",
        beat: off(b),
        beats: 0.9,
        hz: noteFreq(rng.pick(LEAD_NOTES)),
        level: 0.6 + rng.float() * 0.3,
      });
  ev.push({ kind: "kick", beat: 0, level: 1 }, { kind: "kick", beat: off(2), level: 0.85 });
  if (rng.bool(0.3)) ev.push({ kind: "kick", beat: off(1), level: 0.5 });
  ev.push({ kind: "snare", beat: 1, level: 1 }, { kind: "snare", beat: 3, level: 1 });
  for (let b = 0; b < 4; b++) {
    ev.push({ kind: "hat", beat: b, level: 0.8 + rng.float() * 0.2 });
    ev.push({ kind: "hat", beat: off(b), level: 0.45 + rng.float() * 0.2 });
  }
  const clicks = rng.int(4);
  for (let i = 0; i < clicks; i++)
    ev.push({ kind: "click", beat: rng.float() * 4, level: 0.3 + rng.float() * 0.7 });
  return ev.sort((a, b) => a.beat - b.beat);
}

/** A mode's seeded tempo (inside {@link BPM_RANGE}) and chord-set order. */
export function modePlan(
  mode: AmbientMode,
  seed: number | string = 0,
): { bpm: number; order: number[] } {
  const rng = createRng(`lofi:${mode}:${String(seed)}`);
  const bpm = Math.min(
    BPM_RANGE.max,
    Math.max(BPM_RANGE.min, MODE_STYLE[mode].bpm + rng.int(5) - 2),
  );
  return { bpm, order: rng.shuffle([0, 1, 2, 3]) };
}

/** Options of {@link createLofi}. */
export interface LofiOptions {
  mode?: AmbientMode;
  seed?: number | string;
  scheduler?: SchedulerOptions;
}

/** A playing lofi loop. */
export interface Lofi {
  /** The current (or pending, from the next bar line) mode. */
  readonly mode: AmbientMode;
  readonly bpm: number;
  /** Bars scheduled so far. */
  readonly bar: number;
  /** Switches style on the next bar line. */
  setMode(mode: AmbientMode): void;
  /** Fades out over `fadeMs` (default 1200) and frees every node. */
  stop(fadeMs?: number): void;
}

const FLOOR = 0.0001;

interface Queued {
  t: number;
  e: LofiEvent;
  beatS: number;
}

/** Starts the loop into `out` (the music bus), fading in over 1.5 s. */
export function createLofi(ctx: BaseAudioContext, out: AudioNode, o: LofiOptions = {}): Lofi {
  const seed = o.seed ?? 0;
  const rng = createRng(`lofi:${String(seed)}`);
  let mode: AmbientMode = o.mode ?? "dusk";
  let pending: AmbientMode | null = null;
  let plan = modePlan(mode, seed);
  const t0 = ctx.currentTime + 0.05;

  // out ← fade ← tape lowpass ← [rhodes (tremolo) | bass | drums] ; hiss → fade
  const fade = ctx.createGain();
  fade.gain.setValueAtTime(FLOOR, t0);
  fade.gain.exponentialRampToValueAtTime(1, t0 + 1.5);
  fade.connect(out);
  const tape = ctx.createBiquadFilter();
  tape.type = "lowpass";
  tape.frequency.value = MODE_STYLE[mode].tapeHz;
  tape.Q.value = 0.4;
  tape.connect(fade);
  const rhodes = ctx.createGain();
  rhodes.gain.value = 0.85;
  rhodes.connect(tape);
  const trem = ctx.createOscillator();
  trem.frequency.value = 4;
  const tremDepth = ctx.createGain();
  tremDepth.gain.value = 0.15;
  trem.connect(tremDepth).connect(rhodes.gain);
  trem.start(t0);
  const hiss = noiseSource(ctx, "pink", t0, true);
  const hissLp = ctx.createBiquadFilter();
  hissLp.type = "lowpass";
  hissLp.frequency.value = 3000;
  const hissGain = ctx.createGain();
  hissGain.gain.value = dbToGain(HISS_DB);
  hiss.connect(hissLp).connect(hissGain).connect(fade);
  const fixed: AudioNode[] = [fade, tape, rhodes, trem, tremDepth, hiss, hissLp, hissGain];

  const env = (t: number, peak: number, attack: number, dur: number, into: AudioNode): GainNode => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
    g.connect(into);
    return g;
  };
  const osc = (
    type: OscillatorType,
    hz: number,
    t: number,
    end: number,
    into: AudioNode,
    detune = 0,
  ): OscillatorNode => {
    const n = ctx.createOscillator();
    n.type = type;
    n.frequency.setValueAtTime(hz, t);
    n.detune.value = detune;
    n.connect(into);
    n.start(t);
    n.stop(end + 0.02);
    return n;
  };
  const freeOnEnd = (src: AudioScheduledSourceNode, nodes: AudioNode[]): void => {
    src.onended = () => {
      for (const n of nodes) n.disconnect();
    };
  };
  const rhodesNote = (hz: number, t: number, dur: number, peak: number): void => {
    const g = env(t, peak, 0.008, dur, rhodes);
    const body = osc("sine", hz, t, t + dur, g);
    const shimmer = ctx.createGain();
    shimmer.gain.value = 0.35;
    shimmer.connect(g);
    // The detuned triangle: +3 cents through `detune`; its frequency stays pentatonic.
    const tri = osc("triangle", hz, t, t + dur, shimmer, 3);
    freeOnEnd(body, [body, g]);
    freeOnEnd(tri, [tri, shimmer]);
  };
  const noiseHit = (
    t: number,
    type: BiquadFilterType,
    hz: number,
    q: number,
    peak: number,
    dur: number,
  ): void => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    const g = env(t, peak, 0.002, dur, tape);
    f.connect(g);
    const src = noiseSource(ctx, "white", t, false, rng.float() * 2);
    src.connect(f);
    src.stop(t + dur + 0.02);
    freeOnEnd(src, [src, f, g]);
  };
  const tone = (
    hz: number,
    t: number,
    dur: number,
    peak: number,
    type: OscillatorType,
  ): OscillatorNode => {
    const g = env(t, peak, 0.003, dur, tape);
    const n = osc(type, hz, t, t + dur, g);
    freeOnEnd(n, [n, g]);
    return n;
  };

  const play = ({ e, t, beatS }: Queued): void => {
    switch (e.kind) {
      case "chord": {
        const peak = (0.075 * e.level) / Math.sqrt(e.hz.length / 2);
        for (const hz of e.hz) rhodesNote(hz, t, e.beats * beatS, peak);
        return;
      }
      case "lead":
        rhodesNote(e.hz, t, e.beats * beatS, 0.05 * e.level);
        return;
      case "bass":
        tone(e.hz, t, e.beats * beatS, 0.22 * e.level, "sine");
        return;
      case "kick":
        tone(
          DRUM_PITCH.kickFrom,
          t,
          0.26,
          0.5 * e.level,
          "sine",
        ).frequency.exponentialRampToValueAtTime(DRUM_PITCH.kickTo, t + 0.12);
        return;
      case "snare":
        noiseHit(t, "bandpass", 1800, 0.8, 0.2 * e.level, 0.14);
        tone(DRUM_PITCH.snare, t, 0.08, 0.08 * e.level, "triangle");
        return;
      case "hat":
        noiseHit(t, "bandpass", 5000, 1, 0.045 * e.level, 0.035);
        return;
      case "click":
        noiseHit(t, "highpass", 2500, 0.7, 0.05 * e.level, 0.004);
        return;
    }
  };

  let bar = 0;
  let barStart = t0;
  const queue: Queued[] = [];
  const scheduler = createScheduler(
    ctx,
    (_from, to) => {
      while (barStart < to) {
        if (pending) {
          mode = pending;
          pending = null;
          plan = modePlan(mode, seed);
          tape.frequency.setTargetAtTime(MODE_STYLE[mode].tapeHz, barStart, 0.5);
        }
        const beatS = 60 / plan.bpm;
        const chords = CHORD_SETS[plan.order[Math.floor(bar / 4) % 4] as number] as ChordSet;
        for (const e of lofiBar(chords, bar, rng))
          queue.push({ t: barStart + e.beat * beatS, e, beatS });
        bar++;
        barStart += 4 * beatS;
      }
      queue.sort((a, b) => a.t - b.t);
      while (queue.length > 0 && (queue[0] as Queued).t < to) play(queue.shift() as Queued);
    },
    { aheadS: 0.2, ...o.scheduler },
  );

  return {
    get mode() {
      return pending ?? mode;
    },
    get bpm() {
      return plan.bpm;
    },
    get bar() {
      return bar;
    },
    setMode(m) {
      pending = m === mode ? null : m;
    },
    stop(fadeMs = 1200) {
      scheduler.stop();
      queue.length = 0;
      const now = ctx.currentTime;
      const end = now + Math.max(10, fadeMs) / 1000;
      fade.gain.cancelScheduledValues(now);
      fade.gain.setValueAtTime(Math.max(FLOOR, fade.gain.value), now);
      fade.gain.exponentialRampToValueAtTime(FLOOR, end);
      trem.stop(end + 0.05);
      hiss.stop(end + 0.05);
      hiss.onended = () => {
        for (const n of fixed) n.disconnect();
      };
    },
  };
}
