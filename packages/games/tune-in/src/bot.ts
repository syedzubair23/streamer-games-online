/**
 * `@sg/game-tune-in` bot entry (ROADMAP Mx-01 `src/bot.ts`). The implementation lives in
 * `logic/bot.ts` so the pure module can use it (logic may not import outside `logic/`).
 *
 * @module
 */
export { botAction, botClue, estimateFromClue, exampleSlot, BOT_CLUES } from "./logic/bot.ts";
