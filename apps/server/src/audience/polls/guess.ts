/**
 * `guess` (SPEC §4): free text of at most {@link GUESS_MAX_LENGTH} characters, at most one
 * guess per {@link GUESS_COOLDOWN_MS} per member. Each guess is matched server-side against
 * the effect's secret `accept[]` after normalisation (`classifyGuess` in `@sg/shared`): an
 * exact match is correct and locks the member; Levenshtein ≤ 1 on a 5+ letter answer is only
 * "close" (a private `guess.close` cue to that member, never the answer). Broadcast: the count
 * of correct guessers. The game gets that count plus the first 3 correct names. Points go
 * 100 → 20 by the order of correct guesses, awarded at close.
 *
 * Neither the accepted answers nor anyone's guess text ever leaves this module.
 *
 * @module
 */
import { classifyGuess, type AudId, type PublicPollResult } from "@sg/shared";
import type { PollResult, PollSpec } from "@sg/engine";
import {
  BallotPoll,
  type InputOutcome,
  type Live,
  type PollEnv,
  type Voter,
  type You,
} from "./types.ts";

/** Free text ≤ 32 characters (SPEC §4). */
export const GUESS_MAX_LENGTH = 32;
/** At most 1 guess per 1.5 s per member (SPEC §4). */
export const GUESS_COOLDOWN_MS = 1_500;
/** `firstCorrect` lists this many names (SPEC §4). */
export const GUESS_FIRST_NAMES = 3;

/** Points for the `order`-th correct guess (0-based): 100, 90, 80 … down to 20. */
export function guessPoints(order: number): number {
  return Math.max(20, 100 - 10 * Math.max(0, Math.trunc(order)));
}

interface GuessRecord {
  correct: boolean;
  lastAt: number;
}

/** A `guess` poll. */
export class GuessPoll extends BallotPoll<GuessRecord> {
  readonly #accept: readonly string[];
  /** Correct guessers in order. */
  readonly #correct: { audId: AudId; name: string }[] = [];
  #scored = false;

  constructor(spec: PollSpec) {
    super(spec);
    this.#accept = spec.accept ?? [];
  }

  vote(voter: Voter, choice: string | number, env: PollEnv): InputOutcome {
    if (typeof choice !== "string") return { ok: false, reason: "invalid" };
    const len = Array.from(choice).length;
    if (len === 0 || len > GUESS_MAX_LENGTH) return { ok: false, reason: "invalid" };
    const prev = this.ballots.get(voter.audId);
    if (prev !== undefined) {
      if (prev.value.correct) return { ok: false, reason: "locked" };
      if (env.now - prev.value.lastAt < GUESS_COOLDOWN_MS) return { ok: false, reason: "cooldown" };
    }
    const verdict = classifyGuess(choice, this.#accept);
    this.record(voter, { correct: verdict === "correct", lastAt: env.now }, env.now);
    if (verdict === "correct") {
      this.#correct.push({ audId: voter.audId, name: voter.name });
      return { ok: true, changed: true, cue: { name: "guess.correct" } };
    }
    // A first guess changes the guesser count; a repeated wrong guess changes nothing public.
    return {
      ok: true,
      changed: prev === undefined,
      ...(verdict === "close" ? { cue: { name: "guess.close" } } : {}),
    };
  }

  /** The count of correct guessers; `total` is everyone who guessed. */
  override live(): Live {
    return { tallies: { correct: this.#correct.length }, total: this.ballots.size };
  }

  override result(): PollResult {
    const r: PollResult = {
      pollId: this.spec.pollId,
      kind: "guess",
      total: this.ballots.size,
      tallies: { correct: this.#correct.length },
      firstCorrect: this.#correct.slice(0, GUESS_FIRST_NAMES).map((c) => ({ ...c })),
    };
    if (this.spec.teamSplit === true) {
      const byTeam: Record<string, Record<string, number>> = {};
      for (const b of this.ballots.values())
        if (b.teamId !== undefined) {
          const t = (byTeam[b.teamId] ??= { correct: 0 });
          if (b.value.correct) t["correct"] = (t["correct"] ?? 0) + 1;
        }
      r.byTeam = byTeam;
    }
    return r;
  }

  override closedPublic(): PublicPollResult {
    return { ...this.result() };
  }

  override onClose(env: PollEnv): Map<AudId, You> {
    const you = new Map<AudId, You>();
    if (this.#scored) return you;
    this.#scored = true;
    this.#correct.forEach((c, i) => {
      const points = guessPoints(i);
      env.leaderboard.addPoints(c.audId, points, c.name);
      you.set(c.audId, { correct: true, points });
    });
    for (const id of this.ballots.keys())
      if (!you.has(id)) you.set(id, { correct: false, points: 0 });
    return you;
  }
}
