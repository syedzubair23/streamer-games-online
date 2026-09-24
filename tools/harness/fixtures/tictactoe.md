# tictactoe: harness fixture spec

The engine's reference game (`packages/engine/test/fixtures/tictactoe/`, ROADMAP M0-04). It is
not a launch game: this file exists so `pnpm verify:game tictactoe` exercises the same spec-driven
harness path as a real game (ROADMAP M0-05). Rules live in the fixture's `logic.ts` header; its
gate tests are the engine suite plus `tools/harness/test/fixture-tictactoe.test.ts`.

## Scenarios
| id | roles | description | what the critic should see | anim |
|---|---|---|---|---|
| intro | stage, audience | Game start: empty board, intro card, round predict poll open | Empty 3×3 board on the mat, title chip | — |
| midgame | stage, player, audience | Four marks down, next mark to move, chat's pick poll open | Two X and two O pieces, whose move it is | `place` 320 ms |
| win | stage, player | X completes the top row; secret lines revealed | The winning line in focus, the winner named | `win` 2000 ms |
| draw | stage | Full board, no line: a draw | Nine pieces, "A draw!" | — |

**Perf script:** `place`, then `win`.

## Builder notes
Fixture only: no content packs, no numbered rules; not judged by the critic.
