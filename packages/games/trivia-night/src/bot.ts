/**
 * `@sg/game-trivia-night` bot entry (ROADMAP Mx-01 `src/bot.ts`). The implementation lives in
 * `logic/bot.ts` so the pure module can use it (logic may not import outside `logic/`).
 *
 * @module
 */
export { botAction, botChoice, BOT_ACCURACY, BOT_SHOWDOWN_ACCURACY } from "./logic/bot.ts";
