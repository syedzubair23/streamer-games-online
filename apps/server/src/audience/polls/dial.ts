/**
 * `dial` (SPEC §4): each member sets an integer 0–1000, changeable until close. Broadcast: a
 * {@link DIAL_BINS}-bin histogram; the game gets the histogram and the mean. On
 * `audience.resolve { target, bands }` each member scores the points of the tightest band
 * their value falls in (`|value − target| ≤ within`).
 *
 * @module
 */
import type { AudId, PublicPollResult } from "@sg/shared";
import type { PollResult, PollSpec } from "@sg/engine";
import { DIAL_BINS } from "../../room.ts";
import {
  BallotPoll,
  type Ballot,
  type InputOutcome,
  type PollEnv,
  type ResolveEffect,
  type Voter,
  type You,
} from "./types.ts";

/** The dial range (SPEC §4). */
export const DIAL_MAX = 1000;

/** The histogram bin (0..49) of a dial value (0..1000; each bin spans ~20 values). */
export function dialBin(value: number): number {
  return Math.min(DIAL_BINS - 1, Math.floor((value * DIAL_BINS) / (DIAL_MAX + 1)));
}

/** Points for a dial value: the tightest band that contains it, or 0. */
export function bandPoints(
  value: number,
  target: number,
  bands: readonly { within: number; points: number }[],
): number {
  const d = Math.abs(value - target);
  let best: { within: number; points: number } | null = null;
  for (const b of bands) if (d <= b.within && (best === null || b.within < best.within)) best = b;
  return best === null ? 0 : Math.max(0, Math.trunc(best.points));
}

/** A `dial` poll. */
export class DialPoll extends BallotPoll<number> {
  #resolved = false;

  constructor(spec: PollSpec) {
    super(spec);
  }

  vote(voter: Voter, choice: string | number, env: PollEnv): InputOutcome {
    if (typeof choice !== "number" || !Number.isInteger(choice) || choice < 0 || choice > DIAL_MAX)
      return { ok: false, reason: "invalid" };
    return { ok: true, changed: this.record(voter, choice, env.now) };
  }

  protected override keyOf(b: Ballot<number>): string {
    return String(dialBin(b.value));
  }

  protected override baseKeys(): string[] {
    return Array.from({ length: DIAL_BINS }, (_, i) => String(i));
  }

  override result(): PollResult {
    const r = super.result();
    if (this.ballots.size > 0) {
      let sum = 0;
      for (const b of this.ballots.values()) sum += b.value;
      r.mean = sum / this.ballots.size;
    }
    return r;
  }

  override resolve(
    effect: ResolveEffect,
    env: PollEnv,
  ): { result: PublicPollResult; you: Map<AudId, You> } {
    const you = new Map<AudId, You>();
    const result: PublicPollResult = { ...this.result() };
    if (this.#resolved || effect.target === undefined) return { result, you };
    this.#resolved = true;
    const bands = effect.bands ?? [];
    for (const [id, b] of this.ballots) {
      const points = bandPoints(b.value, effect.target, bands);
      if (points > 0) env.leaderboard.addPoints(id, points, b.name);
      you.set(id, { correct: points > 0, points });
    }
    return { result, you };
  }
}
