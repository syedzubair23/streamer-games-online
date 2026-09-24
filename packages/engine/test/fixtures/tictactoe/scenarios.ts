/**
 * Scenarios for the tictactoe fixture (SPEC §14). They build states by driving the real
 * module (setup, then moves through `onAction`), so every scenario is a state the game can
 * actually reach. Used by the M0-05 harness to validate `/dev/scenario` before any real game.
 */
import { createRng, type PlayerId } from "@sg/shared";
import { EMPTY_CONTENT, defaultOptions, type Seat } from "../../../src/game-module.ts";
import type { ScenarioCtx, ScenarioRegistry } from "../../../src/scenario.ts";
import { createTiming } from "../../../src/timing.ts";
import { tictactoe, type TttOptions, type TttState } from "./logic.ts";

/** Scenario clock origin (server ms); deadlines are relative to it. */
export const SCENARIO_NOW = 1_000_000;

/** The two fixture seats. */
export const SCENARIO_SEATS: readonly Seat[] = Object.freeze([
  { id: "p1", name: "Maple", seat: 0, colorSlot: 0 },
  { id: "p2", name: "Juniper", seat: 1, colorSlot: 1 },
]);

/**
 * Sets up a game from `ctx.seed` and plays `cells` in order (alternating marks). The turn
 * phase starts right after the intro; each move lands 2 s after the previous one.
 */
export function playTo(ctx: Pick<ScenarioCtx, "seed">, cells: readonly number[]): TttState {
  const rng = createRng(ctx.seed);
  const timing = createTiming({ timerScale: 1, streamDelaySec: 3 });
  const options = defaultOptions(tictactoe.optionSpecs) as unknown as TttOptions;
  let now = SCENARIO_NOW;
  let state = tictactoe.setup({
    players: SCENARIO_SEATS.map((s) => ({ ...s })),
    teams: [],
    options,
    rng,
    now,
    timing,
    content: EMPTY_CONTENT,
    audienceCount: 0,
  }).state;
  now += 3_000;
  const base = { rng, timing, audienceCount: 0 };
  state = tictactoe.onTimer?.(state, "intro", { ...base, now }).state ?? state;
  for (const cell of cells) {
    now += 2_000;
    const actor: PlayerId = state.players[state.turn].id;
    const next = tictactoe.onAction(
      state,
      { type: "move", cell },
      { ...base, now, actor: { id: actor, role: "player" } },
    );
    if (next.state === state) throw new Error(`tictactoe scenario: illegal move ${cell}`);
    state = next.state;
  }
  return state;
}

/** The fixture's scenario registry. */
export const tictactoeScenarios: ScenarioRegistry<TttState> = {
  intro: {
    id: "intro",
    description: "Game start: empty board, intro card, round predict poll open",
    build: (ctx) => {
      const rng = createRng(ctx.seed);
      const state = tictactoe.setup({
        players: SCENARIO_SEATS.map((s) => ({ ...s })),
        teams: [],
        options: defaultOptions(tictactoe.optionSpecs) as unknown as TttOptions,
        rng,
        now: SCENARIO_NOW,
        timing: createTiming({ timerScale: 1, streamDelaySec: 3 }),
        content: EMPTY_CONTENT,
        audienceCount: 0,
      }).state;
      return { state };
    },
  },
  midgame: {
    id: "midgame",
    description: "Four marks down, X to move, chat's pick poll open",
    build: (ctx) => ({ state: playTo(ctx, [4, 0, 2, 6]), viewer: { role: "player", id: "p1" } }),
    anim: { name: "place", durationMs: 320 },
  },
  win: {
    id: "win",
    description: "X completes the top row; secret lines revealed",
    build: (ctx) => ({
      state: playTo(ctx, [0, 3, 1, 4, 2]),
      fx: [{ name: "win", data: { line: "row-top" } }],
    }),
    anim: { name: "win", durationMs: 2000 },
  },
  draw: {
    id: "draw",
    description: "Full board, no line: a draw",
    build: (ctx) => ({ state: playTo(ctx, [0, 1, 2, 4, 3, 5, 7, 6, 8]) }),
  },
};
