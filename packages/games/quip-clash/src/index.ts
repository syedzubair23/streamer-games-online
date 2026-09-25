/**
 * @packageDocumentation
 * @sg/game-quip-clash: Quip Clash (`docs/specs/quip-clash.md`), the style golden. Pure logic,
 * bot and scenarios; the stage and controller clients live under `./client`.
 */

export { GAME_ID, createQuipClash, logic, manifest, optionSpecs } from "./logic/index.ts";
export type { QcAction, QcOptions, QcState, QcView, QuipClashModule } from "./logic/index.ts";
export { bot, legalActions } from "./bot.ts";
