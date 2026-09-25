/**
 * Pure planners for the stochastic ambience events: concrete frequencies and timings for one
 * event, from a seeded generator. Every pitched value is an exact C major pentatonic pitch.
 *
 * @module
 */
import type { Rng } from "@sg/shared";
import { noteFreq, stepFreq } from "../pentatonic.ts";
import { pentatonicRange } from "../sfx/plan.ts";

/** Seconds until the next arrival of a Poisson process with `ratePerS` (exponential gap). */
export function poissonGap(rng: Rng, ratePerS: number): number {
  return -Math.log(1 - rng.float()) / ratePerS;
}

/** A rain droplet "tik": a very short bandpassed noise burst (unpitched). */
export interface Droplet {
  bandHz: number;
  q: number;
  durMs: number;
  /** 0..1 scale of the bed's event gain. */
  level: number;
}

/** Plans one droplet. */
export function planDroplet(rng: Rng): Droplet {
  return {
    bandHz: 1800 + rng.float() * 2600,
    q: 4 + rng.float() * 6,
    durMs: 10 + rng.float() * 15,
    level: 0.35 + rng.float() * 0.65,
  };
}

/** One pitched blip of a chirp or phrase. */
export interface Blip {
  atMs: number;
  durMs: number;
  hz: number;
  toHz: number;
  level: number;
}

/** The cricket pitch: research's 4.5 kHz, quantised to the nearest pentatonic pitch (D8). */
export const CRICKET_HZ = noteFreq("D8");

/** Plans one far-off cricket chirp: 3–4 quick pulses on {@link CRICKET_HZ}. */
export function planCricket(rng: Rng): Blip[] {
  const pulses = 3 + rng.int(2);
  const out: Blip[] = [];
  for (let i = 0; i < pulses; i++)
    out.push({ atMs: i * 48, durMs: 26, hz: CRICKET_HZ, toHz: CRICKET_HZ, level: 1 - i * 0.12 });
  return out;
}

/** Bird notes are drawn from this pentatonic range (G6–E7). */
export const BIRD_NOTES = pentatonicRange("G6", "E7");

/** Plans one bird phrase (FM sine, within 2 s): 3–6 short notes gliding to a neighbour. */
export function planBird(rng: Rng): Blip[] {
  const count = 3 + rng.int(4);
  const out: Blip[] = [];
  let at = 0;
  for (let i = 0; i < count && at < 1800; i++) {
    const hz = rng.pick(BIRD_NOTES);
    const durMs = 60 + rng.float() * 110;
    out.push({
      atMs: at,
      durMs,
      hz,
      toHz: stepFreq(hz, rng.int(3) - 1),
      level: 0.6 + rng.float() * 0.4,
    });
    at += durMs + 30 + rng.float() * 180;
  }
  return out;
}
