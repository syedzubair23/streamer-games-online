/**
 * Server-safe logic entry for `@sg/game-trivia-night/logic` (SPEC §9.2): pure rules, views and
 * bot. Pure and deterministic: randomness and time come only from `ctx`.
 *
 * `logic` is the game module the server, the harness and the tests load.
 *
 * @module
 */
import { triviaNight } from "./module.ts";

export {
  triviaNight,
  GAME_ID,
  manifest,
  optionSpecs,
  parseAction,
  finalRanking,
  AUDIENCE_MIN,
} from "./module.ts";
export * from "./types.ts";
export * from "./rules.ts";
export * from "./state.ts";
export { drawQuestions, targetDifficulty, takeBest, type Draw, type DrawInput } from "./draw.ts";
export { FALLBACK_QUESTIONS } from "./fallback.ts";
export { botAction, botChoice, BOT_ACCURACY, BOT_SHOWDOWN_ACCURACY } from "./bot.ts";
export { viewFor } from "./views.ts";

/** The game module (the harness reads this export). */
export const logic = triviaNight;
