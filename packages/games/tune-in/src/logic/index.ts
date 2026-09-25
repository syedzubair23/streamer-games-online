/**
 * Server-safe logic entry for `@sg/game-tune-in/logic` (SPEC §9.2): pure rules, views and bot.
 * Pure and deterministic: randomness and time come only from `ctx`.
 *
 * `logic` is the game module the server, the harness and the tests load.
 *
 * @module
 */
import { tuneIn } from "./module.ts";

export {
  tuneIn,
  GAME_ID,
  manifest,
  optionSpecs,
  parseAction,
  resolveMode,
  finalRanking,
  AUDIENCE_MIN,
} from "./module.ts";
export * from "./types.ts";
export * from "./rules.ts";
export * from "./state.ts";
export { FALLBACK_CARDS, DECK_SIZE, buildDeck, drawPair, sameCard } from "./cards.ts";
export { botAction, botClue, estimateFromClue, exampleSlot, BOT_CLUES } from "./bot.ts";
export { viewFor } from "./views.ts";

/** The game module (the harness reads this export). */
export const logic = tuneIn;
