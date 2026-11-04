/**
 * @packageDocumentation
 * @sg/game-doodle: Doodle (`docs/specs/doodle.md`), the drawing and guessing party game.
 *
 * - `./logic`: the pure game module (`logic` / `createDoodle`), rules, views and bot.
 * - `./scenarios`: the scenario registry for `/dev/scenario` (SPEC §14).
 * - `./client`: the Stage and controller (M5-03, M5-04).
 */

export { GAME_ID, createDoodle, logic, manifest, optionSpecs } from "./logic/index.ts";
export type {
  DoodleAction,
  DoodleModule,
  DoodleOptions,
  DoodleState,
  DoodleView,
} from "./logic/index.ts";
export { bot, legalActions } from "./bot.ts";
