/**
 * Procedural ambience beds, one per ambient mode (research 03 §8.2 and §9, SPEC §8), as data:
 * continuous noise/hum layers plus stochastic events (Poisson arrivals).
 *
 * | Mode | Bed (research 03 §9) |
 * |---|---|
 * | day | soft room tone + rare bird chirps (FM sine, 2 s) |
 * | dusk | room tone + soft wind |
 * | night | very low room tone + low hum + occasional far-off cricket (4.5 kHz → D8 chirp) |
 * | rain | pink noise → lowpass 1.2 kHz + droplet "tik"s (bandpassed noise, ~6/s) |
 * | snow | muffled room tone + faint wind |
 *
 * @module
 */
import type { AmbientMode } from "@sg/shared";
import type { PentatonicNote } from "../pentatonic.ts";
import type { NoiseColor } from "../sfx/noise.ts";

/** A looping filtered-noise layer, optionally breathing with a slow LFO (wind). */
export interface NoiseLayer {
  readonly kind: "noise";
  readonly color: NoiseColor;
  readonly filter: {
    readonly type: "lowpass" | "bandpass";
    readonly hz: number;
    readonly q: number;
  };
  readonly gain: number;
  /** Slow modulation: `depth` of the gain (0..1) and `filterHz` of cutoff swing. */
  readonly lfo?: { readonly rateHz: number; readonly depth: number; readonly filterHz: number };
}

/** A steady low sine hum on a pentatonic note. */
export interface HumLayer {
  readonly kind: "hum";
  readonly note: PentatonicNote;
  readonly gain: number;
}

/** A continuous layer of a bed. */
export type Layer = NoiseLayer | HumLayer;

/** Stochastic event kinds. */
export type BedEventKind = "droplet" | "cricket" | "bird";

/** Events of one kind arriving as a Poisson process. */
export interface BedEvent {
  readonly kind: BedEventKind;
  /** Mean arrivals per second. */
  readonly ratePerS: number;
  /** Peak gain of one event. */
  readonly gain: number;
}

/** A mode's ambience bed. */
export interface BedRecipe {
  readonly mode: AmbientMode;
  readonly layers: readonly Layer[];
  readonly events: readonly BedEvent[];
}

const roomTone = (hz: number, gain: number): NoiseLayer => ({
  kind: "noise",
  color: "brown",
  filter: { type: "lowpass", hz, q: 0.5 },
  gain,
});
const wind = (hz: number, gain: number): NoiseLayer => ({
  kind: "noise",
  color: "pink",
  filter: { type: "bandpass", hz, q: 0.6 },
  gain,
  lfo: { rateHz: 0.07, depth: 0.6, filterHz: hz * 0.45 },
});

/** The bed of every ambient mode. */
export const BEDS: Readonly<Record<AmbientMode, BedRecipe>> = {
  day: {
    mode: "day",
    layers: [roomTone(320, 0.05)],
    events: [{ kind: "bird", ratePerS: 1 / 11, gain: 0.03 }],
  },
  dusk: {
    mode: "dusk",
    layers: [roomTone(300, 0.05), wind(520, 0.028)],
    events: [],
  },
  night: {
    mode: "night",
    layers: [roomTone(200, 0.035), { kind: "hum", note: "C2", gain: 0.012 }],
    events: [{ kind: "cricket", ratePerS: 1 / 5, gain: 0.004 }],
  },
  rain: {
    mode: "rain",
    layers: [
      roomTone(220, 0.03),
      { kind: "noise", color: "pink", filter: { type: "lowpass", hz: 1200, q: 0.5 }, gain: 0.12 },
    ],
    events: [{ kind: "droplet", ratePerS: 6, gain: 0.05 }],
  },
  snow: {
    mode: "snow",
    layers: [roomTone(160, 0.04), wind(360, 0.016)],
    events: [],
  },
};
