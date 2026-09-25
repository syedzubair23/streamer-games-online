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

### ER-002 Room settings in SetupContext (moderation, content filter, audienceMin)
- **From:** M2-01 (quip-clash builder)
- **Package:** @sg/engine (`packages/engine/src/game-module.ts`, `runner.ts`)
- **Status:** open
- **Need:** game logic must know `RoomConfig.moderation`, `contentFilter` and `audienceMin`; `SetupContext` carries none of them.
- **Why:** `docs/specs/quip-clash.md` R3 (`filterText` at the room's level), R7 (`poll.total ≥ audienceMin`), R13 (`moderation = reveal-review`); Doodle needs the same.
- **Proposed API:** `SetupContext.room: Pick<RoomConfig, "contentFilter" | "moderation" | "audienceMin">`, filled by `GameRunner` from a new `RunnerOptions.room` (default `DEFAULT_ROOM_CONFIG`).
- **Local stub:** `packages/games/quip-clash/src/logic/room.ts` reads an optional `ctx.room`; `createQuipClash(room)` pins the settings meanwhile.
- **Resolution:**

### ER-003 Client scenario-route test assumes quip-clash has no logic
- **From:** M2-01 (quip-clash builder)
- **Package:** @sg/client (`apps/client/test/scenario-route.test.ts`, "explains which roadmap item a game is waiting for")
- **Status:** open
- **Need:** the test expects `loadScenarioGame("quip-clash")` to reject with "no logic yet"; M2-01 ships that logic, so `pnpm test` goes red once M2-01 merges (and the same happens for any other game later).
- **Why:** DOD P3/G-gates need a green `pnpm test`; the assertion depends on build progress, not on behaviour.
- **Proposed API:** none; keep the same assertion without a real game: `expect(() => assembleGame("tune-in", {}, {}, null)).toThrow(/no logic yet.*Mx-01/)`.
- **Local stub:** none possible (engine-owned test). Blocks merging M2-01 until applied.
- **Resolution:**
