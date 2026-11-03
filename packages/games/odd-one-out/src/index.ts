/**
 * @packageDocumentation
 * @sg/game-odd-one-out: Odd One Out (`docs/specs/odd-one-out.md`), the social-deduction game.
 * Pure logic, bot and scenarios; the stage and controller clients live under `./client`.
 */

export { GAME_ID, createOddOneOut, logic, manifest, optionSpecs } from "./logic/index.ts";
export type { OddOneOutModule, OooAction, OooOptions, OooState, OooView } from "./logic/index.ts";
export { bot, legalActions } from "./bot.ts";
