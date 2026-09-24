/**
 * @packageDocumentation
 * @sg/engine: the pure game runtime.
 *
 * - `game-module`: the `GameModule` API every game's logic implements (SPEC §9.3).
 * - `runner`: `GameRunner`, which drives a module: timers, scores, end, bot takeover,
 *   minimum audience window, pause/resume, memoised views, snapshots.
 * - `timing`: `createTiming` for `ctx.timing` (`input` / `pace`).
 * - `scenario`: the scenario contract (SPEC §14) and `resolveScenario`.
 *
 * Other entry points: `@sg/engine/client` (the client module API, SPEC §9.4; DOM + three
 * types) and `@sg/engine/testing` (runScript, the contract suite, the timed-bot sim and pacing
 * report, fake content).
 */

export * from "./game-module.ts";
export * from "./runner.ts";
export * from "./timing.ts";
export * from "./scenario.ts";
