/**
 * The pitch rule (SPEC §13.7, research 03 §8.1): every pitched sound is quantised to
 * **C major pentatonic** (C D E G A), so overlapping sounds never clash.
 *
 * Pitches are 12-tone equal temperament with A4 = 440 Hz. Notes are written in scientific pitch
 * notation (`"C4"` is middle C, `"E5"` ≈ 659.26 Hz). Every frequency a recipe, bed or loop
 * schedules comes from {@link noteFreq}, {@link quantize} or {@link stepFreq}, so it is exactly
 * a pentatonic pitch; the only micro-variation (a few cents of detune for warmth and anti-fatigue)
 * is applied through the oscillator's separate `detune` parameter.
 *
 * @module
 */

/** A note name in scientific pitch notation, e.g. `"C4"`, `"A#3"` is not pentatonic. */
export type PentatonicNote = `${"C" | "D" | "E" | "G" | "A"}${number}`;

/** Semitone offsets from C of the five pentatonic pitch classes: C, D, E, G, A. */
export const PENTATONIC_PCS: readonly number[] = Object.freeze([0, 2, 4, 7, 9]);

const LETTER_PC: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, G: 7, A: 9 };
const A4 = 440;
/** MIDI number of A4. */
const A4_MIDI = 69;

/** Frequency of a MIDI note number (A4 = 69 = 440 Hz). */
export function midiFreq(midi: number): number {
  return A4 * 2 ** ((midi - A4_MIDI) / 12);
}

/** The (fractional) MIDI number of a frequency. */
export function freqMidi(hz: number): number {
  return A4_MIDI + 12 * Math.log2(hz / A4);
}

/** The MIDI number of a pentatonic note name. @throws RangeError on a non-pentatonic name. */
export function noteMidi(note: PentatonicNote): number {
  const m = /^([CDEGA])(-?\d+)$/.exec(note);
  const pc = m ? LETTER_PC[m[1] as string] : undefined;
  if (!m || pc === undefined) throw new RangeError(`not a C major pentatonic note: ${note}`);
  return 12 * (Number(m[2]) + 1) + pc;
}

/** Frequency of a pentatonic note name, e.g. `noteFreq("E5")` ≈ 659.255. */
export function noteFreq(note: PentatonicNote): number {
  return midiFreq(noteMidi(note));
}

/** Index along the pentatonic scale: 5 steps per octave, step 0 = C-1 (MIDI 0). */
function degreeOfMidi(midi: number): number {
  const octave = Math.floor(midi / 12);
  const i = PENTATONIC_PCS.indexOf(midi - octave * 12);
  if (i < 0) throw new RangeError(`MIDI ${midi} is not pentatonic`);
  return octave * 5 + i;
}

function midiOfDegree(degree: number): number {
  const octave = Math.floor(degree / 5);
  return octave * 12 + (PENTATONIC_PCS[degree - octave * 5] as number);
}

/**
 * The nearest pentatonic MIDI note to a frequency (by cents; ties go down). E.g. 1200 Hz → D6,
 * B5 → C6, 500 Hz → C5.
 */
export function quantizeMidi(hz: number): number {
  const m = freqMidi(hz);
  const lo = Math.floor(m);
  let best = lo;
  let bestDist = Infinity;
  for (let c = lo - 2; c <= lo + 3; c++) {
    const pc = ((c % 12) + 12) % 12;
    if (!PENTATONIC_PCS.includes(pc)) continue;
    const d = Math.abs(c - m);
    if (d < bestDist - 1e-9) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

/** Snaps any frequency to the nearest C major pentatonic pitch (in Hz). */
export function quantize(hz: number): number {
  return midiFreq(quantizeMidi(hz));
}

/**
 * Moves a frequency `steps` pentatonic steps up (or down, if negative), after quantising it.
 * `stepFreq(noteFreq("A3"), 1)` is C4; five steps is one octave.
 */
export function stepFreq(hz: number, steps: number): number {
  return midiFreq(midiOfDegree(degreeOfMidi(quantizeMidi(hz)) + Math.trunc(steps)));
}

/** Distance in cents from `hz` to the nearest pentatonic pitch (0 for an exact pitch). */
export function centsOff(hz: number): number {
  return 100 * Math.abs(freqMidi(hz) - quantizeMidi(hz));
}

/** Whether `hz` is a C major pentatonic pitch, within `toleranceCents` (default 0.01). */
export function isPentatonic(hz: number, toleranceCents = 0.01): boolean {
  return Number.isFinite(hz) && hz > 0 && centsOff(hz) <= toleranceCents;
}
