/**
 * The poll kinds of SPEC §4, keyed by `PollSpec.kind`.
 *
 * @module
 */
import type { PollSpec } from "@sg/engine";
import { DialPoll } from "./dial.ts";
import { GuessPoll } from "./guess.ts";
import { PredictPoll } from "./predict.ts";
import { QuizPoll } from "./quiz.ts";
import { TapPoll } from "./tap.ts";
import type { PollKindState } from "./types.ts";
import { VotePoll } from "./vote.ts";

export * from "./types.ts";
export { DIAL_MAX, bandPoints, dialBin, DialPoll } from "./dial.ts";
export {
  GUESS_COOLDOWN_MS,
  GUESS_FIRST_NAMES,
  GUESS_MAX_LENGTH,
  guessPoints,
  GuessPoll,
} from "./guess.ts";
export { PredictPoll } from "./predict.ts";
export { QUIZ_POINTS, QUIZ_SPEED_BONUS, QuizPoll, speedBonus } from "./quiz.ts";
export { TAP_MAX_BATCH, TAP_MAX_PER_SEC, TapPoll } from "./tap.ts";
export { VotePoll } from "./vote.ts";

/** Creates the state machine for a poll's kind. */
export function createPoll(spec: PollSpec, openedAt: number): PollKindState {
  switch (spec.kind) {
    case "vote":
      return new VotePoll(spec);
    case "predict":
      return new PredictPoll(spec);
    case "quiz":
      return new QuizPoll(spec, openedAt);
    case "dial":
      return new DialPoll(spec);
    case "guess":
      return new GuessPoll(spec);
    case "tap":
      return new TapPoll(spec);
  }
}
