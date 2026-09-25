/**
 * `predict` (SPEC §4): each member backs one option with a fixed stake (100 Seeds by default,
 * never more than their balance), changeable until close. Broadcast: tallies per option,
 * from which clients show the implied odds (`impliedOdds` in `../seeds.ts`). On
 * `audience.resolve { correct }` the stakes pay out pari-mutuel; a balance never drops below
 * the Seeds floor (100). A resolve without a valid `correct` refunds every stake.
 *
 * @module
 */
import type { AudId, PublicPollResult } from "@sg/shared";
import type { PollSpec } from "@sg/engine";
import { parimutuel, type Stake } from "../seeds.ts";
import {
  BallotPoll,
  type InputOutcome,
  type PollEnv,
  type ResolveEffect,
  type Voter,
  type You,
} from "./types.ts";

/** A `predict` poll. */
export class PredictPoll extends BallotPoll<string> {
  readonly #stakes = new Map<AudId, number>();
  #resolved = false;

  constructor(spec: PollSpec) {
    super(spec);
  }

  vote(voter: Voter, choice: string | number, env: PollEnv): InputOutcome {
    if (!this.isOption(choice)) return { ok: false, reason: "invalid" };
    // The stake is fixed when the member first backs an option; moving it keeps the amount.
    if (!this.#stakes.has(voter.audId)) {
      const balance = env.leaderboard.seeds.balance(voter.audId);
      this.#stakes.set(voter.audId, Math.max(0, Math.min(env.predictStake, balance)));
    }
    env.leaderboard.see(voter.audId, voter.name);
    return { ok: true, changed: this.record(voter, choice, env.now) };
  }

  /** Each member's option and stake. */
  stakes(): Map<AudId, Stake> {
    const out = new Map<AudId, Stake>();
    for (const [id, b] of this.ballots)
      out.set(id, { option: b.value, amount: this.#stakes.get(id) ?? 0 });
    return out;
  }

  override resolve(
    effect: ResolveEffect,
    env: PollEnv,
  ): { result: PublicPollResult; you: Map<AudId, You> } {
    const result: PublicPollResult = { ...this.result() };
    const you = new Map<AudId, You>();
    const winner =
      effect.correct !== undefined && this.isOption(effect.correct) ? effect.correct : null;
    if (winner !== null) result.correct = winner;
    if (this.#resolved) return { result, you };
    this.#resolved = true;
    for (const [id, delta] of parimutuel(this.stakes(), winner)) {
      const mine: You = { seeds: env.leaderboard.seeds.apply(id, delta) };
      if (winner !== null) mine.correct = this.ballots.get(id)?.value === winner;
      you.set(id, mine);
    }
    return { result, you };
  }
}
