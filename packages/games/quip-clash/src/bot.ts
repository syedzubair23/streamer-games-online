/**
 * `@sg/game-quip-clash` bot entry (ROADMAP game template: `src/bot.ts`). The strategy lives in
 * `logic/bot.ts` so that the pure `logic` module can carry it (`GameModule.bot` is required and
 * `logic/**` may only import logic).
 *
 * @module
 */
export { bot, freshAnswer, legalActions } from "./logic/bot.ts";
