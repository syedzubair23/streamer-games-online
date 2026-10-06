/**
 * The Trivia Night bot (seat takeover and sims): answers like a decent pub-quiz player. It is
 * right with a probability that falls with the difficulty, otherwise it picks a plausible wrong
 * option; a lifeline recipient never picks a removed option.
 *
 * @module
 */
import type { PlayerId, Rng } from "@sg/shared";
import { canAnswer } from "./state.ts";
import type { TnAction, TnState } from "./types.ts";

/** Chance the bot knows the answer, by difficulty (1 easy … 3 hard). */
export const BOT_ACCURACY: Readonly<Record<1 | 2 | 3, number>> = { 1: 0.8, 2: 0.6, 3: 0.4 };
/** Chance the bot knows a showdown question (medium). */
export const BOT_SHOWDOWN_ACCURACY = 0.6;

const CHOICES = [0, 1, 2, 3] as const;

/** A choice that is right with probability `accuracy`, never one of `removed`. */
export function botChoice(
  correct: number,
  accuracy: number,
  removed: readonly number[],
  rng: Rng,
): 0 | 1 | 2 | 3 {
  const allowed = CHOICES.filter((c) => !removed.includes(c));
  const right = allowed.find((c) => c === correct);
  if (right !== undefined && rng.bool(accuracy)) return right;
  const wrong = allowed.filter((c) => c !== correct);
  return wrong.length > 0 ? rng.pick(wrong) : (right ?? 0);
}

/** The bot's action for `player`, or null when it has nothing to do. */
export function botAction(state: TnState, player: PlayerId, rng: Rng): TnAction | null {
  if (!canAnswer(state, player, null)) return null;
  if (state.phase === "showdown-answer") {
    const correct = state.hidden.showdownCorrect ?? 0;
    return { type: "answer", choice: botChoice(correct, BOT_SHOWDOWN_ACCURACY, [], rng) };
  }
  const correct = state.hidden.correct ?? 0;
  const removed = state.hidden.lifelineRemoved;
  const mine =
    removed !== undefined && removed.player === player && state.lifeline.question === state.index
      ? removed.remove
      : [];
  const accuracy = BOT_ACCURACY[state.current?.difficulty ?? 2];
  return { type: "answer", choice: botChoice(correct, accuracy, mine, rng) };
}
