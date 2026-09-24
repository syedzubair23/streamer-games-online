/**
 * Deliberately broken fixtures for the engine's "expected to fail" tests (ROADMAP M0-04
 * Accept). Each one is the tictactoe module with exactly one contract violation.
 */
import type { GameModule, Step, ViewerKey } from "../../src/game-module.ts";
import {
  tictactoe,
  type TttAction,
  type TttOptions,
  type TttState,
  type TttView,
} from "./tictactoe/logic.ts";

type Ttt = GameModule<TttState, TttAction, TttOptions, TttView>;

/**
 * Leaky: every view carries both players' secret lines (the classic "copied the whole player
 * object into the view" bug). The secrecy fuzz must catch it.
 */
export const leakyTictactoe: GameModule<
  TttState,
  TttAction,
  TttOptions,
  TttView & { debug: TttState["players"] }
> = {
  ...tictactoe,
  view(state: TttState, viewer: ViewerKey) {
    return { ...tictactoe.view(state, viewer), debug: state.players };
  },
};

/**
 * Non-deterministic: a module-level counter (hidden global state, SPEC §9.3 rule 1) decides
 * who moves first, so the same seed plays out differently on every run.
 */
export function makeNondeterministicTictactoe(): Ttt {
  let games = 0;
  return {
    ...tictactoe,
    setup(ctx): Step<TttState> {
      const step = tictactoe.setup(ctx);
      games++;
      const flip = games % 2 === 0;
      if (!flip) return step;
      const [a, b] = step.state.players;
      return {
        ...step,
        state: {
          ...step.state,
          players: [
            { ...b, mark: 0 },
            { ...a, mark: 1 },
          ],
        },
      };
    },
  };
}
