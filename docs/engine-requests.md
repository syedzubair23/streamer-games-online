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

### ER-005 Audience result flag, leaderboard and stake in the protocol
- **From:** M1-03 (AudienceAggregator builder)
- **Package:** @sg/shared (`packages/shared/src/protocol.ts`, `room.ts`), @sg/engine (`game-module.ts`)
- **Status:** open
- **Need:** typed fields for what the aggregator already sends or keeps: `counted: boolean` on `PollResult` / `PublicPollResult`; the audience top 5 on `RoomSnapshot` plus each member's own rank; the host-configurable `predict` stake on `RoomConfig`.
- **Why:** SPEC §4 "Minimum audience" (the flag), §5 "Audience leaderboard" (Scoreboard top 5, own rank on the phone), §4 `predict` ("100 Seeds, host-configurable").
- **Proposed API:** `PollResult.counted?: boolean` (same on `PublicPollResult`); `RoomSnapshot.audienceTop?: { audId; name; score; place }[]` and `Me.audienceRank?: number`; `RoomConfig.predictStake: number` (default 100, 10..1000).
- **Local stub:** `apps/server/src/audience/aggregator.ts` sends `counted` as an extra field (`AudiencePollResult`); `Leaderboard.top(5)` / `rowOf(id)` hold the ranking; `AggregatorOptions.predictStake` holds the stake.
- **Resolution:**

### ER-006 Room settings in SetupContext (moderation, content filter, audienceMin)
- **From:** M2-01 (quip-clash builder)
- **Package:** @sg/engine (`packages/engine/src/game-module.ts`, `runner.ts`)
- **Status:** open
- **Need:** game logic must know `RoomConfig.moderation`, `contentFilter` and `audienceMin`; `SetupContext` carries none of them.
- **Why:** `docs/specs/quip-clash.md` R3 (`filterText` at the room's level), R7 (`poll.total ≥ audienceMin`), R13 (`moderation = reveal-review`); Doodle needs the same. Superset of ER-002 and ER-003 (tune-in); one `ctx.room` would close all three.
- **Proposed API:** `SetupContext.room: Pick<RoomConfig, "contentFilter" | "moderation" | "audienceMin">`, filled by `GameRunner` from a new `RunnerOptions.room` (default `DEFAULT_ROOM_CONFIG`).
- **Local stub:** `packages/games/quip-clash/src/logic/room.ts` reads an optional `ctx.room`; `createQuipClash(room)` pins the settings meanwhile.
- **Resolution:**

### ER-007 Client scenario-route test assumes quip-clash has no logic
- **From:** M2-01 (quip-clash builder)
- **Package:** @sg/client (`apps/client/test/scenario-route.test.ts`, "explains which roadmap item a game is waiting for")
- **Status:** open
- **Need:** the test expects `loadScenarioGame("quip-clash")` to reject with "no logic yet"; M2-01 ships that logic, so `pnpm test` goes red once M2-01 merges (and the same happens for any other game later).
- **Why:** DOD P3/G-gates need a green `pnpm test`; the assertion depends on build progress, not on behaviour.
- **Proposed API:** none; keep the same assertion without a real game: `expect(() => assembleGame("chess", {}, {}, null)).toThrow(/no logic yet.*Mx-01/)` (an empty logic module, independent of build progress).
- **Local stub:** none possible (engine-owned test). Blocks merging M2-01 until applied.
- **Resolution:**

### ER-008 Secrecy check flags two owners holding the same text
- **From:** M2-01 (quip-clash builder)
- **Package:** @sg/engine (`packages/engine/src/testing/contract.ts`, `findLeaks`)
- **Status:** open
- **Need:** a hidden string owned by B is reported as leaked to A when A's own hidden value is the same text (A sees only its own answer). Quip Clash R3 lets more than 3 Last Quip authors use Safety Quip on one prompt with 3 lines, so equal texts are legal.
- **Why:** the secrecy fuzz and `findLeaks` cannot tell a shared text from a leak; the quip-clash bot and `legalActions` avoid reused lines only to keep the check meaningful.
- **Proposed API:** none; in `findLeaks`, skip a string secret for a viewer when the same value is also a secret that viewer owns.
- **Local stub:** `packages/games/quip-clash/src/logic/bot.ts` offers Safety only while an unused line is left; the rule itself (and its tests) allows reuse.
- **Resolution:**

### ER-010 Host custom word lists as packs (`customWords`)
- **From:** M5-01 (doodle logic builder)
- **Package:** @sg/shared (`packages/shared/src/content.ts`), @sg/server (content library), client options form
- **Status:** open
- **Need:** a convention for how a host's pasted word list reaches the game. Doodle's `customWords` (off/mix/only) must tell custom words (no tier) from stock packs among `options.packs`.
- **Why:** `docs/specs/doodle.md` "Host options" (`customWords`: "stored as a pack; custom words have no tier, so the tier vote is skipped"); SPEC §12 (host custom packs).
- **Proposed API:** store the list with `parseWordList` as a `doodle-words` pack whose id starts with `custom` (e.g. `custom-<room>`), items `{ w, d: 1 }` (the game ignores `d`), exposed through `ContentAccess` and added to the playlist item's `packs`.
- **Local stub:** `isCustomPack(id)` (`packages/games/doodle/src/logic/words.ts`) treats `custom*` pack ids as host lists.
- **Resolution:**

### ER-011 Timestamp on the first correct audience guess
- **From:** M5-01 (doodle logic builder)
- **Package:** @sg/engine (`game-module.ts` `PollResult.firstCorrect`), @sg/server (aggregator)
- **Status:** open
- **Need:** the game time (or server ms) of each `firstCorrect` entry, so Doodle can decide whether the first correct chatter beat the first correct player.
- **Why:** `docs/specs/doodle.md` "Audience hooks" ("Chat vs Players" race chip).
- **Proposed API:** `firstCorrect?: { audId; name; atMs?: number }[]` (server receive time; the runner translates by its pause offset like `closesAtMs`).
- **Local stub:** `onAudienceResult` reads an optional numeric `atMs` on the first entry; without it the chip is `beat: null` (unknown) unless no player guessed (chat wins) or no chatter did (chat loses). `packages/games/doodle/src/logic/game.ts`.
- **Resolution:**

### ER-012 Seated host flag (and the room's content filter) in SetupContext
- **From:** M6-01 (odd-one-out logic builder)
- **Package:** @sg/engine (`packages/engine/src/game-module.ts`, `runner.ts`)
- **Status:** open
- **Need:** game logic must know whether the host also holds a player seat, so the host-panel view can drop the secret; and the room's `contentFilter` for clues (same need as ER-006).
- **Why:** `docs/specs/odd-one-out.md` R11, Views table ("host panel (host not seated)") and edge case "The host is seated: the host dock shows 'You are playing — secrets hidden'"; R3 (`filterText` at the room level).
- **Proposed API:** `SetupContext.room.hostSeated: boolean` next to ER-006's `room` fields, filled by the room from whether the host member holds one of the game's seats.
- **Local stub:** `packages/games/odd-one-out/src/logic/room.ts` reads an optional `ctx.room.hostSeated` / `ctx.room.contentFilter`; `createOddOneOut({ hostSeated, contentFilter })` pins them. Default: not seated (secret shown on the host panel), `standard` filter.
- **Resolution:**

### ER-013 Full test run executes every game's tests twice
- **From:** M6-01 (odd-one-out logic builder)
- **Package:** root `vitest.workspace.ts`
- **Status:** resolved
- **Need:** each game's test files should run once in `pnpm test` and verify's P3.
- **Why:** the P3 report lists every `packages/games/*/test/*` file twice; `packages/*` appears to match the `packages/games` directory as a project on top of `packages/games/*`. The doubled load makes the slow suites time out at the default worker count: unrelated tests in marble-rally, quip-clash, apps/server and tools/harness failed that way, plus marble-rally's T11 performance bound.
- **Proposed API:** none; exclude `packages/games` from the `packages/*` glob.
- **Local stub:** none. Run P3 with `VITEST_MAX_WORKERS=4` until this lands; the odd-one-out contract and sim suites carry long explicit timeouts.
- **Resolution:** `vitest.workspace.ts` now matches `packages/!(games)`, so each game runs once. The odd-one-out timeouts can come down in a later item.
