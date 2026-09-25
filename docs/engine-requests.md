# Engine requests

Game builders do not edit engine code (`packages/{shared,engine,render,ui,audio}`, `apps/*`,
`tools/*`). When you need a change there, add a request below and stub it locally behind an
interface in your own package. The engine owner triages this file between waves (ROADMAP
"Ownership rules"). Any accepted engine change re-runs every done game's screenshots.

Rules:
- One request per `###` block. Newest at the bottom. Never delete a request; change its status.
- Keep each request 15 lines or fewer. Link paths instead of pasting code.
- Status is one of `open`, `accepted`, `rejected`, `done`. Only the engine owner changes it.

## Template

```markdown
### ER-<nnn> <short title>
- **From:** <item id> (<agent/owner>)
- **Package:** @sg/<package> (`<path>`)
- **Status:** open
- **Need:** what the game needs, in one or two sentences.
- **Why:** the spec rule or gate that requires it (e.g. `docs/specs/ludo.md` R7, DOD G8a).
- **Proposed API:** the smallest signature that would work.
- **Local stub:** where your interface/stub lives until this lands.
- **Resolution:** (engine owner) what was done, in which commit.
```

## Requests

### ER-001 tictactoe fixture controller: invalid ARIA grid
- **From:** M0-05 (harness builder)
- **Package:** @sg/engine (`packages/engine/test/fixtures/tictactoe/client.ts`)
- **Status:** open
- **Need:** the controller's board uses `role="grid"` on a plain div of buttons, with no `row`/`gridcell` children.
- **Why:** axe reports it as a critical `aria-required-children` finding, so `pnpm verify:game tictactoe` has G9 red (DOD G9: 0 serious or critical findings). The harness is right; the fixture is wrong.
- **Proposed API:** none; use `role="group"` with `aria-label="Board"` (or add rows and gridcells).
- **Local stub:** none needed; the gate reports it.
- **Resolution:**

### ER-002 `audienceMin` in the game context
- **From:** M3-01 (tune-in logic builder)
- **Package:** @sg/engine (`packages/engine/src/game-module.ts`, `runner.ts`)
- **Status:** open
- **Need:** games need the room's `audienceMin` to decide whether an audience vote counts.
- **Why:** `docs/specs/tune-in.md` R4, R6 and R10 ("if the audience total is at least `audienceMin`"); SPEC §4 "Minimum audience".
- **Proposed API:** `Ctx.audienceMin: number` (and on `SetupContext`), filled from `RoomConfig.audienceMin`.
- **Local stub:** `AUDIENCE_MIN = DEFAULT_ROOM_CONFIG.audienceMin` in `packages/games/tune-in/src/logic/module.ts`.
- **Resolution:**

### ER-003 Room content filter and moderation mode in the game context
- **From:** M3-01 (tune-in logic builder)
- **Package:** @sg/engine (`packages/engine/src/game-module.ts`, `runner.ts`)
- **Status:** open
- **Need:** a game that accepts player text (clues) needs the room's `contentFilter` (family/standard) and moderation mode to mask, flag or queue it.
- **Why:** SPEC §9.7 (profanity filter runs on clues; `reveal-review` queues user text); `docs/specs/tune-in.md` R5.
- **Proposed API:** `Ctx.room: { contentFilter: RoomConfig["contentFilter"]; moderation: RoomConfig["moderation"] }` (read-only).
- **Local stub:** tune-in applies the strictest behaviour: a clue flagged by `filterText(clue, "family")` is rejected with the private "try another" message (`src/logic/rules.ts` `checkClue`); no `moderate` effect yet.
- **Resolution:**

### ER-004 Mid-game joins (`onPlayerJoin`)
- **From:** M3-01 (tune-in logic builder)
- **Package:** @sg/engine (`packages/engine/src/runner.ts`, `game-module.ts`)
- **Status:** open
- **Need:** the runner's seats are fixed at setup, so a player who joins mid-game cannot be seated at the next turn boundary.
- **Why:** `docs/specs/tune-in.md` edge cases ("a player joins mid-game: they sit out until the next turn boundary, and in teams mode they are auto-assigned to the smaller team").
- **Proposed API:** `GameRunner.playerJoin(seat, now)` → optional `GameModule.onPlayerJoin?(state, seat, ctx)`; the runner adds the seat when the hook accepts it.
- **Local stub:** none possible; joiners stay audience until the next game (handoff "known limits").
- **Resolution:**
