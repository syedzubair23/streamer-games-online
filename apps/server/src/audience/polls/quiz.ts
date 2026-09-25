/**
 * `quiz` (SPEC §4): each member picks one option and the first answer locks. Broadcast: the
 * answered count only, and no distribution until the game resolves it (the `pollEnd` at close
 * carries empty tallies). On `audience.resolve { correct }` a correct answer scores
 * {@link QUIZ_POINTS} play-along points, plus up to {@link QUIZ_SPEED_BONUS} for speed when
 * the poll has `speedBonus` (linear in the time left of the window when the answer arrived).
 *
 * @module
 */
import type { AudId, PublicPollResult } from "@sg/shared";
import type { PollSpec } from "@sg/engine";
import {
  BallotPoll,
  type InputOutcome,
  type Live,
  type PollEnv,
  type ResolveEffect,
  type Voter,
  type You,
} from "./types.ts";

/** Points for a correct quiz answer (SPEC §4). */
export const QUIZ_POINTS = 100;
/** The largest speed bonus (SPEC §4). */
export const QUIZ_SPEED_BONUS = 50;

/** The speed bonus for an answer at `at` in the window `[openedAt, closesAt]`. */
export function speedBonus(at: number, openedAt: number, closesAt: number): number {
  const window = closesAt - openedAt;
  if (!(window > 0)) return 0;
  const left = Math.min(1, Math.max(0, (closesAt - at) / window));
  return Math.round(QUIZ_SPEED_BONUS * left);
}

/** A `quiz` poll. */
export class QuizPoll extends BallotPoll<string> {
  readonly #openedAt: number;
  #resolved = false;

  constructor(spec: PollSpec, openedAt: number) {
    super(spec);
    this.#openedAt = openedAt;
  }

  vote(voter: Voter, choice: string | number, env: PollEnv): InputOutcome {
    if (!this.isOption(choice)) return { ok: false, reason: "invalid" };
    if (this.ballots.has(voter.audId)) return { ok: false, reason: "locked" };
    this.record(voter, choice, env.now);
    return { ok: true, changed: true };
  }

  /** Answered count only: no distribution before resolve. */
  override live(): Live {
    return { tallies: {}, total: this.ballots.size };
  }

  override closedPublic(): PublicPollResult {
    const { pollId, kind, total } = this.result();
    return { pollId, kind, total, tallies: {} };
  }

  override resolve(
    effect: ResolveEffect,
    env: PollEnv,
  ): { result: PublicPollResult; you: Map<AudId, You> } {
    const you = new Map<AudId, You>();
    if (effect.correct === undefined || !this.isOption(effect.correct))
      return { result: this.closedPublic(), you };
    const result: PublicPollResult = { ...this.result(), correct: effect.correct };
    if (this.#resolved) return { result, you };
    this.#resolved = true;
    for (const [id, b] of this.ballots) {
      const correct = b.value === effect.correct;
      const bonus =
        this.spec.speedBonus === true ? speedBonus(b.at, this.#openedAt, this.spec.closesAtMs) : 0;
      const points = correct ? QUIZ_POINTS + bonus : 0;
      if (points > 0) env.leaderboard.addPoints(id, points, b.name);
      you.set(id, { correct, points });
    }
    return { result, you };
  }
}
