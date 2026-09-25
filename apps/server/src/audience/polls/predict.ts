/**
 * `predict` (SPEC §4): each member backs one option with a fixed stake (100 Seeds by default),
 * changeable until close. Broadcast: tallies per option, from which clients show the implied
 * odds (`impliedOdds` in `../seeds.ts`). On `audience.resolve { correct }` the stakes pay out
 * pari-mutuel; a balance never drops below the Seeds floor (100). A resolve without a valid
 * `correct` refunds every stake.
 *
 * A stake is only what the member can actually lose: at most their balance above the floor
 * ({@link stakeable}), checked when they first back an option and again at resolve (another
 * poll may have settled in between). A member at the floor still votes (the tally counts
 * them) but stakes 0, so the pool that pays the winners holds only Seeds the losers really
 * lose and a resolve never creates Seeds.
 *
 * @module
 */
import type { AudId, PublicPollResult } from "@sg/shared";
import type { PollSpec } from "@sg/engine";
import { parimutuel, stakeable, type Stake } from "../seeds.ts";
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
    if (!this.#stakes.has(voter.audId))
      this.#stakes.set(
        voter.audId,
        stakeable(env.leaderboard.seeds, voter.audId, env.predictStake),
      );
    env.leaderboard.see(voter.audId, voter.name);
    return { ok: true, changed: this.record(voter, choice, env.now) };
  }

  /** Each member's option and stake as placed. */
  stakes(): Map<AudId, Stake> {
    const out = new Map<AudId, Stake>();
    for (const [id, b] of this.ballots)
      out.set(id, { option: b.value, amount: this.#stakes.get(id) ?? 0 });
    return out;
  }

  /** The stakes that settle now: each capped at what the member can still lose. */
  #settling(env: PollEnv): Map<AudId, Stake> {
    const out = new Map<AudId, Stake>();
    for (const [id, s] of this.stakes())
      out.set(id, { option: s.option, amount: stakeable(env.leaderboard.seeds, id, s.amount) });
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
    for (const [id, delta] of parimutuel(this.#settling(env), winner)) {
      const mine: You = { seeds: env.leaderboard.seeds.apply(id, delta) };
      if (winner !== null) mine.correct = this.ballots.get(id)?.value === winner;
      you.set(id, mine);
    }
    return { result, you };
  }
}
