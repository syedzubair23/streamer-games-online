# Roadmap: v1 build plan

> Every item is small, can be built on its own, and can be verified. IDs are stable, so refer to them in `progress.json`, commits (`M1-03: …`) and handoffs.
> Rules: read `docs/SPEC.md` first. "Done" follows `docs/DOD.md`: **platform items** need the Platform DoD (P-gates) and **game items** need the Game DoD (G-gates).
> Each item lists: **Goal / Files / Depends / Parallel / Accept.** An item's `Accept` criteria are in addition to the DoD.

## Overview & critical path

```
M0 scaffold+harness ──► M1 core platform ──► M2 Quip Clash (STYLE GOLDEN) ──► M3..M9 games (parallel waves) ──► M10 polish/perf/overlay/launch
        │                      ▲                        ▲
        └── game LOGIC items (Mx-01) can start right after M0-04, in parallel with M1 ─┘
```

| Milestone | Content | Can start when |
|---|---|---|
| M0 | Monorepo, shared, engine, harness, CLAUDE.md, progress | now |
| M1 | Server, audience, moderation, UI kit, render kit, Cozy Table diorama, audio, client shell, bots | M0-02/M0-04 done (per item) |
| M2 | `quip-clash`, the **style golden** | logic after M0-04; client after M1-07 + M1-09 |
| M3 | `tune-in` | logic after M0-04; client after M2 is done (golden) |
| M4 | `trivia-night` | same as M3 |
| M5 | `doodle` | same as M3 |
| M6 | `odd-one-out` | same as M3 |
| M7 | `ludo` | same as M3 |
| M8 | `chess` | same as M3 |
| M9 | `marble-rally` | logic after M0-04; binary transport after M1-02; client after M2 |
| M10 | Overlay layouts, Twitch, SQLite, SW, DOM fallback, perf lab, drift guard, soak test | per item |

**Parallel waves after the golden:**
- Wave A: M3, M4, M5.
- Wave B: M6, M7, M8.
- Wave C: M9 plus M10.

Each wave runs at most 3–5 builders at a time, each with its own critic loop.

---

## M0: Scaffold & harness

### M0-01 Monorepo scaffold
- **Goal:** set up an empty, green monorepo with every package stubbed and every script wired.
- **Files:**
  - Root config: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` (strict, `moduleResolution: "bundler"`, `noUncheckedIndexedAccess`), `eslint.config.js` (typescript-eslint, eslint-plugin-boundaries, bans on `Math.random`/`Date` in `**/logic/**`, `import * as THREE`, raw `requestAnimationFrame` in games, colour/duration literals in `games/*/src/client/**`), `.prettierrc`, `vitest.workspace.ts`, `.size-limit.cjs`, `.gitignore` (`artifacts/` except `artifacts/critic/`).
  - Package stubs: `package.json` + `src/index.ts` for every package and app in SPEC §9.2.
- **Depends:** nothing.
- **Parallel:** none (this is the first item).
- **Accept:**
  - `pnpm i && pnpm typecheck && pnpm lint && pnpm test` pass.
  - A deliberate `Math.random()` inside `packages/games/x/src/logic/` fails lint (checked by a fixture test).
  - A game importing another game fails lint.
  - `git init` is done and the first commit is made.

### M0-02 @sg/shared foundations
- **Goal:** the types and utilities every package shares.
- **Files:** `packages/shared/src/{rng.ts, ids.ts, protocol.ts, room.ts, diff.ts, codec.ts, text.ts, content.ts, index.ts}` plus `test/*`.
- **Contents:**
  - `rng.ts`: sfc32 with `int(n)`, `float()`, `pick`, `shuffle`, `fork(label)` and `state()`/`from()`.
  - `diff.ts`: `diff(prev, next) → PatchOp[]` and `apply`.
  - `codec.ts`: JSON plus binary frame helpers (0x01, 0x02).
  - `text.ts`: `normalize` (lowercase, strip accents and punctuation, collapse spaces), `levenshtein`, and a `filterText` wrapper around `obscenity`.
  - `content.ts`: the pack zod schemas.
  - `protocol.ts` and `room.ts`: copied exactly from SPEC §7 and §9.6.
- **Depends:** M0-01.
- **Parallel:** M0-03.
- **Accept:**
  - RNG sequence snapshot test: the first 5 values for seed 42 are a fixed fixture.
  - `apply(prev, diff(prev, next))` deep-equals `next` over 10k random JSON pairs.
  - `levenshtein` is correct on a table of cases.
  - `filterText` masks a known bad word in family mode.

### M0-03 Agent house rules + progress tooling
- **Goal:** any agent can start a session cold in under 2 minutes.
- **Files:**
  - `CLAUDE.md`: 150 lines or fewer, adapted from research 05 §B.2 but using the pnpm package paths from SPEC §9.2.
  - `progress.json`: one entry per roadmap item ID, all set to `todo`.
  - `tools/harness/progress.ts`: `pnpm progress set <id> status=…`, `pnpm progress show <id>`, and a `render` command that writes `PROGRESS.md`. It rejects illegal transitions and rejects `done` unless `artifacts/verify/<id>.json` is green, plus a passing `artifacts/critic/<id>/round-*.json` for items with visuals.
  - `docs/engine-requests.md`: an empty template.
- **Depends:** M0-01.
- **Parallel:** M0-02.
- **Accept:** `pnpm progress set M0-03 status=done` is refused while there is no verify artifact. `PROGRESS.md` regenerates the same way every time.

### M0-04 @sg/engine: module API, GameRunner, testing kit
- **Goal:** a pure runtime for game modules, plus the contract tests every game must pass.
- **Files:**
  - `packages/engine/src/{game-module.ts, client-module.ts, runner.ts, timing.ts, scenario.ts}`, matching SPEC §9.3, §9.4 and §14 exactly.
  - `packages/engine/src/testing/{run-script.ts, contract.ts, sim.ts, fake-content.ts}`.
  - `packages/engine/test/fixtures/tictactoe/*`: a reference game used to test the engine.
- **Runner behaviour:**
  - Applies effects and keeps a timer table.
  - Aggregates `score` effects.
  - Checks `end`.
  - Takes over for a disconnected seat by calling `bot()`.
  - Deep-freezes state in dev (every step for `tickHz: 0`, every 60th step for `tickHz: 60`).
  - Computes views per distinct viewer key, with memoisation per step.
  - Enforces the **minimum audience window** (SPEC §4): an early phase close while a timed audience poll is open is deferred to `openedAt + streamDelay + 5 s`.
  - Pause freezes all timers (stores remaining ms) and resume re-arms them.
- **`sim.ts`** also provides the **timed bot model** and the **pacing report** used by DoD G14: a virtual clock, bots acting at 25–70% of each input window, 50 simulated audience bots, and a timeline of phases, open audience interactions and per-player input windows. It outputs `{ durationMs, audienceIdleMaxMs, playerIdleMaxMs, timeline }`.
- **`contract.ts`** exports `runContractSuite(module, {seeds, players})`. It covers:
  - determinism
  - serialize round-trip
  - secrecy fuzz: views must not contain values under the `secret`/`hidden` keys belonging to other viewers
  - termination under bots
  - `parseAction` garbage fuzz (1,000 random payloads, no throws)
  - `onAction` with illegal actions (state unchanged)
- **Depends:** M0-02.
- **Parallel:** M0-05 (stubbed UI), and every **Mx-01 logic item** once this is done.
- **Accept:** tictactoe passes the full contract suite. A deliberately leaky fixture fails the secrecy test, and so does a non-deterministic fixture (both are tests that are expected to fail). A fixture with a 60 s phase and no audience interaction fails the pacing report's audience-idle check (expected to fail). An early close 1 s after a poll opens is deferred to 8 s with `streamDelaySec = 3` (unit test).

### M0-05 Scenario route + Playwright harness
- **Goal:** render any game state in a deterministic way and capture evidence from it with no manual steps.
- **Files:**
  - `apps/client/src/dev/scenario.tsx`: the `/dev/scenario` route, per SPEC §14.
  - `tools/harness/{screenshots.spec.ts, clips.spec.ts, perf.spec.ts, a11y.spec.ts, check-scenarios.ts, stream-sim.ts, contact-sheet.ts, ab-pairs.ts, verify-game.ts, verify-item.ts}` and `playwright.config.ts`, with two projects:
    - `swiftshader`, for CI and determinism
    - `gpu`, using `--enable-gpu --use-angle=d3d11` on Windows or `--use-angle=gl` elsewhere, for the frame-time gate
- **What the harness does:**
  - `stream-sim` downscales 1080p shots to 720p and saves them as JPEG at quality 60.
  - `contact-sheet` produces one grid PNG per mode.
  - `ab-pairs` randomises A/B pairs and keeps the answer key hidden.
  - `verify-game <id>` runs every G-gate automation from DOD.md and writes `artifacts/verify/<id>.json`.
- **Depends:** M0-04. The route can render a placeholder stage until M1-07 exists; it is validated with the tictactoe fixture's minimal stage.
- **Parallel:** M1-01, M1-05, M1-06, M1-08.
- **Accept:**
  - `pnpm verify:game tictactoe` produces the screenshots, perf JSON, contact sheets and verify JSON.
  - Two consecutive runs produce pixel-identical PNGs (pixelmatch diff = 0 on swiftshader).
  - The route waits on `__SCENE_READY__` and never on a timeout.

### M0-06 Critic kit + reference board
- **Goal:** a calibrated, blind critic that is ready before any game UI exists.
- **Files:**
  - `docs/critic/RUBRIC.md`: copied from DOD.md §4.
  - `docs/critic/report.schema.json`: from DOD.md §5.
  - `docs/critic/CRITIC_PROMPT.md` and `docs/critic/BUILDER_PROMPT.md`: from DOD.md §6.
  - `docs/references/_style/`: 12–20 reference PNGs, sourced from press kits or official store screenshots of A Short Hike, Unpacking, Alba, Tiny Glade, Townscaper and Jackbox. Used for critic comparison only; never shipped. Add a `SOURCES.md` listing each image's URL.
  - `docs/references/<game-id>/`: 3–6 each.
  - `tools/harness/calibrate-critic.ts`.
- **Depends:** M0-01.
- **Parallel:** everything else in M0 and M1.
- **Accept:** the calibration run scores the reference images at 9–10 and a deliberately rough "grey default three.js" fixture at 4–6. If it doesn't, revise the rubric anchors and re-run.

---

## M1: Core platform

### M1-01 Server transport, sessions, codes, roles, reconnection
- **Goal:** players can join a room by code, and a player who reloads gets their seat back.
- **Files:** `apps/server/src/{transport/uws.ts, transport/ws.ts, transport/types.ts, session.ts, codes.ts, room-manager.ts, http.ts, config.ts, bin.ts, store/memory.ts}`.
- **Depends:** M0-02.
- **Parallel:** M1-05, M1-06, M1-08.
- **Accept** (vitest, using real `ws` clients against both transports):
  - create → hello → welcome works.
  - A wrong code returns `BAD_CODE`, and a full room puts the joiner in the audience.
  - A password is required when one is set.
  - Codes use only the 20-consonant alphabet, and a blocklisted code is never issued.
  - A reconnect within the grace period restores role and seat.
  - The join rate limit (40/min/IP by default, configurable) triggers at the configured value, 30 clients from one IP can all join (classroom case), and the 16 KB payload cap drops the connection.
  - The overlay key gives read-only access: an `act` from an overlay socket returns `NOT_ALLOWED`.

### M1-02 Room actor + GameRunner integration
- **Goal:** rooms run the playlist and games through the runner and fan views out efficiently.
- **Files:** `apps/server/src/{room.ts, fanout.ts, games.ts, scoreboard.ts, playlist.ts}`.
- **Behaviour:**
  - One buffer per viewer key, sent through uWS topics (`r:CODE:aud`, `r:CODE:stage`).
  - Patches carry a seq, with a full-view fallback when the patch is larger than 60% of the full view.
  - Steps are coalesced per event-loop turn.
  - Host commands, pause/resume, and `forceAdvance` all work.
  - Bots take over after `reconnectGraceSec`.
  - Night Champion placement scoring.
  - Snapshots are written every 20 actions or every 10 s.
  - Handles the `stream` effect (binary frames to `r:CODE:stage` / `r:CODE:aud`, which Marble Rally needs), the `streamEach` effect (per-socket binary frames, resolved by `audId`/`PlayerId` to sockets), and the `private` effect (sent as an `fx` message to one player only).
  - **Participants & bench** (SPEC §3.4): picks each game's participants from the seated players (sat-out-last-game first, then seeded random), benches the rest as audience, honours `bench` and `fillBots` host commands.
  - **Seat raffle** (`raffle` host command) and `seatPick`.
  - **Next-game audience vote** when `playlistMode = "audience-vote"` (3 unplayed candidates, 15 s, fallback to playlist order below `audienceMin`).
  - **BRB/pause**: deadlines frozen and restored exactly.
  - **Review-wait timeout**: a moderation item pending for 20 s resolves as rejected.
  - Sends the `host` view only to host-panel and moderator sockets; the Stage socket is subscribed to `stage` only.
- **Depends:** M1-01, M0-04.
- **Parallel:** M1-03 and M1-04 can start against the interfaces.
- **Accept:**
  - A room with the tictactoe fixture plays a full playlist of 2 games using 2 bot clients.
  - The Scoreboard shows placement points.
  - Killing a client's socket mid-turn leads to bot takeover after the grace period.
  - With 1 audience member and 1,000 audience members, the server calls `view()` for the audience the same number of times: once per step.
  - 9 seated players and a 4-seat game: exactly 4 participants, the 5 benched players are guaranteed seats in the next game with room, and benched players get no placement points.
  - `raffle 3` with a queue of 50 picks 3 distinct members, deterministic for a fixed seed.
  - The next-game vote picks the plurality candidate; with 2 voters (below `audienceMin`) the playlist order is used.
  - Pausing for 30 s and resuming leaves the remaining input time unchanged (±50 ms).
  - A Stage socket never receives a frame containing a `host`-view-only field (frame grep test).

### M1-03 AudienceAggregator
- **Goal:** every poll kind in SPEC §4, plus Seeds, play-along points, reactions and stream delay.
- **Files:** `apps/server/src/audience/{aggregator.ts, polls/*.ts, seeds.ts, leaderboard.ts, reactions.ts}`.
- **Depends:** M1-02.
- **Parallel:** M1-04.
- **Accept** (unit tests plus a bot test):
  - One vote per `audId`, which can be changed until close (a `quiz` vote locks on the first answer).
  - Tallies go out at no more than 4 Hz, and reactions every 500 ms.
  - A `guess` poll matches `accept[]` after normalisation, and the `accept` values never appear in any outgoing frame (the test greps serialized output).
  - A `dial` poll produces a 50-bin histogram.
  - `predict` pays out pari-mutuel, and a balance never drops below 100.
  - Below `audienceMin`, the flag says the vote doesn't count.
  - Stream delay is added to `closesAtMs` for `closeOn: "deadline"` polls; `closeOn: "event"` polls ignore it and discard inputs received after the close event.
  - A `hideLive` poll broadcasts only `total` until close (frame grep: no per-option tallies before `pollEnd`).
  - Audience sockets are limited to 5 msg/s.

### M1-04 Moderation & safety
- **Goal:** content filtering, the review queue, and kick/ban/mute.
- **Files:** `apps/server/src/{moderation.ts, bans.ts}` and the `modq` messages.
- **Depends:** M1-02.
- **Parallel:** M1-03.
- **Accept:**
  - Family mode masks bad text in names and answers.
  - With `reveal-review`, the `onModeration` callback is withheld until a moderator approves, and the stage view shows the item as `pending`.
  - A banned token or IP hash cannot rejoin.
  - A muted player's text actions return `MUTED`.

### M1-05 @sg/ui design system
- **Goal:** tokens and a Preact component kit that match SPEC §13 exactly.
- **Files:**
  - `packages/ui/src/{tokens.ts, tokens.css, theme.ts}`, where `theme.ts` handles mode switching with `@property` transitions over 2.5 s.
  - `components/*.tsx`: Button, Card, Chip, PlayerPlate, TimerRing, VoteBars, Toast, Sheet, Modal, Input, CodeBadge, QR, AudiencePanel, Countdown, RollingNumber.
  - `hud/layout.tsx`, which respects stream-safe zones.
  - `transitions/{iris.css, lamp-blink.ts}`.
  - `fonts.ts`: fontsource imports, latin subsets.
  - `icons.ts`.
  - `apps/client/src/dev/ui-gallery.tsx`: the `/dev/ui?mode=` route.
- **Depends:** M0-01.
- **Parallel:** M1-01, M1-06, M1-08.
- **Accept:**
  - A screenshot of the gallery in all 5 modes at 3 viewports passes axe contrast checks.
  - Every text pair has contrast of at least 4.5:1.
  - Tap targets are at least 44 px.
  - The UI chunk contributes 25 KB gz or less.
  - No literal colours appear outside `tokens.ts`.

### M1-06 @sg/render kit
- **Goal:** the renderer, the loop, quality tiers and the only material and texture factories.
- **Files:** `packages/render/src/{renderer.ts, loop.ts, quality.ts, bench.ts, springs.ts, tween.ts, dispose.ts, picking.ts, materials/{toon,matcap,lambert-vc,basic,sky,blob}.ts, textures/{noise,wood,felt,paper,cork,board,cards,dice,blob,matcap,ramp,grain}.ts, pieces/{lathe,rounded-box,extrude}.ts, perf-hud.ts}`.
- **Depends:** M0-01.
- **Parallel:** M1-01, M1-05, M1-08.
- **Accept:**
  - The loop renders 0 frames/s when idle with ambient off (Playwright test).
  - Dynamic resolution steps down and up with hysteresis (unit test using a fake frame feed).
  - All procedural textures generate in 150 ms or less under a 4× CPU throttle (perf spec).
  - `dispose.ts` returns `renderer.info.memory` to its baseline after a mount/unmount cycle.
  - Game code cannot construct any material directly: a lint rule bans `new Mesh*Material` outside `@sg/render`.

### M1-07 Cozy Table diorama, ambient modes, camera, FX
- **Goal:** the shared stage every game sits on, as described in research 03 §1, §4, §5 and §9.
- **Files:** `packages/render/src/{room/*, table.ts, mats.ts, ambient/{modes.ts, sky.ts, weather.ts, props.ts}, camera-rig.ts, fx/{confetti.ts, puff.ts, halos.ts, reactions.ts, blob-shadows.ts}, pieces/dice.ts}` and the `platform` scenarios (`room-establishing`, `room-play-empty-mat`, `dice-roll`, `confetti`).
- **Details:**
  - The room: back wall, window, shelf, plant, lamp, string lights, mug with steam, and a sleeping cat. Static geometry is merged, with vertex-colour AO.
  - 5 modes, with a 2.5 s lerp between them.
  - Weather: rain streaks, snow, fireflies and dust.
  - 4 camera states plus idle drift, portrait framing and `setViewOffset` for Stream Layout.
  - Pre-authored die roll that lands on a given face.
  - A confetti pool and a reactions sprite layer.
- **Depends:** M1-06, M0-05.
- **Parallel:** M1-09 (shell work can proceed against a stub stage).
- **Accept:**
  - The environment is at most 12 draws and 15k triangles on low.
  - The `platform` scenarios pass the visual critic (DOD §4) with ★ items at 8.5 or higher. This is a *pre-golden* check.
  - A mode switch triggers no shader recompiles: `renderer.info.programs` count is unchanged.
  - Reduce-motion disables drift, shake and confetti.

### M1-08 @sg/audio
- **Goal:** synthesized sound effects, ambience beds and a lofi loop, all stream-safe.
- **Files:** `packages/audio/src/{context.ts, buses.ts, pentatonic.ts, sfx/*.ts, ambience/*.ts, lofi.ts}` and the `/dev/audio` gallery.
- **Depends:** M0-01.
- **Parallel:** M1-01, M1-05, M1-06.
- **Accept:**
  - Each SFX recipe's parameters (oscillator type, envelope ms, base note) equal a fixture table transcribed from research 03 §8.1 (unit test on the recipe objects, not on audio output).
  - Every pitched sound is quantized to C major pentatonic (unit test on the frequencies).
  - The AudioContext suspends when the tab is hidden.
  - The package is 12 KB gz or less.
  - Music ducking works.

### M1-09 Client shell
- **Goal:** the complete flow — landing, join, host Stage, host panel, lobby, playlist, controllers, audience lite, intro, results, scoreboard (with next-game vote), BRB and end of night.
- **Files:** `apps/client/src/{main-stage.ts, main-controller.ts, router.ts, net/{client.ts, clock.ts, patch.ts}, routes/{landing.tsx, host-stage.tsx, host-panel.tsx, controller.tsx, audience-lite.tsx, overlay.tsx}, shell/{stage-host.ts, controller-host.tsx, intro-card.tsx, results.tsx, scoreboard.tsx, next-game-vote.tsx, raffle.tsx, brb.tsx, night-champion.tsx, host-dock.tsx, options-form.tsx, playlist-editor.tsx, stream-deck.ts, reconnect-pill.tsx, board2d/*}, games.ts}`.
- **Details:**
  - **Two Vite entry points:** `stage` (with three) for `/host/:code` and `/overlay/:code`; `controller` (no three) for `/:code` and `/host/:code/panel`.
  - `board2d/` is the shared SVG board kit (square grid + cross track) used by the Chess and Ludo controllers, the Chess audience panel, and the no-WebGL Stage fallback.
  - The overlay `full` layout only (the other layouts come in M10-01).
  - The next game's chunk is prefetched while Results is showing (all 3 candidates in audience-vote mode).
  - `games.ts` is the lazy import map.
- **Depends:** M1-02, M1-03, M1-05, M1-07 (a stub stage is fine for early work), M1-08.
- **Parallel:** M1-10.
- **Accept:**
  - Playwright end-to-end: the host creates a room; 3 player pages and 2 audience pages join; the tictactoe playlist runs to the Night Champion screen; one player reloads mid-game and resumes.
  - The audience lite route **and the player controller route** load no three.js (network assertion).
  - The Stage shell is 180 KB gz or less; the controller shell is 70 KB gz or less.
  - The lobby is interactive in under 2.5 s on Slow 4G with a 4× CPU throttle; the phone join screen in under 2.0 s with a 6× CPU throttle.
  - The host panel pop-out approves a pending item and the Stage un-blurs it; the Stage page's DOM never contains the pending text (DOM grep).
  - The platform scenarios `lobby-empty`, `lobby-full-8`, `scoreboard`, `next-game-vote`, `raffle`, `brb`, `night-champion`, `audience-poll-vote` and `audience-predict` are registered.

### M1-10 Bot swarm & load gate
- **Goal:** prove the platform can handle the audience scale target.
- **Files:** `tools/bots/src/{client.ts, swarm.ts, report.ts}`.
- **Depends:** M1-03.
- **Parallel:** M1-09.
- **Accept:**
  - `pnpm bots --create --game tictactoe --players 8 --audience 5000 --duration 120` on one local process reports p99 vote→tally latency of 250 ms or less and p99 action→view of 50 ms or less, with 0 errors, and average server egress ≤ 300 KB/s (SPEC §10 egress budget).
  - The report is written to `artifacts/perf/load-M1.json`.

---

## Game milestones (M2–M9): the standard item template

Every game `<id>` has the items below. **Follow `docs/specs/<id>.md` exactly.**

| Item | Goal | Files | Depends | Parallel |
|---|---|---|---|---|
| **Mx-01 Logic** | Pure rules, options, views, legalActions, bot, and scenario builders for the state side | `packages/games/<id>/src/logic/**`, `src/bot.ts`, `src/scenarios.ts` (the state builders), `test/{logic,contract,sim}.test.ts` | M0-04 | Every other Mx-01, and all of M1 |
| **Mx-02 Content** | The packs listed in the game spec: original, validated, filtered | `content/packs/<kind>/*.json`, `packages/games/<id>/src/content/*` | M0-02 | Anything |
| **Mx-03 Stage** | 3D and HUD stage client per the spec's visual section | `packages/games/<id>/src/client/stage.ts` (+ helpers) | Mx-01, M1-07, M1-09, and **M2 done** (except for M2 itself) | Other games' Mx-03 |
| **Mx-04 Controller** | Phone controller (and a custom audience panel if the spec calls for one) | `src/client/controller.tsx`, `src/client/audience.tsx` | Mx-01, M1-05, M1-09 | Mx-03 |
| **Mx-05 Verify & critic** | All G-gates green, critic loop until pass or blocked | `artifacts/**`, the spec's "Builder notes" section | Mx-01..04 | Other games' Mx-05 |

Acceptance for every game item comes from **DOD.md §2** (the G-gates), plus the test list in the game spec. Specific extras are listed below.

### M2 `quip-clash` (STYLE GOLDEN)
- **M2-01..05** as in the template. M2-02: 400 prompts rated "all" and 150 rated "teen".
- **M2-06 Golden promotion:** the passing screenshots (★ items ≥ 9) are copied to `docs/references/_style/golden/`. The critic re-runs the M1 platform scenarios against the golden, and they must pass.
- Waves A–C start only after M2-06.

### M3 `tune-in`
- M3-01..05. M3-02: 200 spectrum cards.
- The audience dial heatmap must render 5,000 bot guesses in one draw call, as a single texture or instanced strip.

### M4 `trivia-night`
- M4-01 covers Classic mode. **M4-01b** covers Bluff mode logic (cut-first: may slip to the next wave without blocking M4).
- M4-02: 960 multiple-choice items plus 200 bluff items. Every item needs a `source` URL. **Every** item (not a sample) is fact-checked by a second agent that did not write it, recording `{id, verdict, checkedAgainst}` in `artifacts/content/trivia-factcheck.json`; any item marked wrong or unverifiable is fixed or dropped. Then a third agent re-checks a 10% random sample, and 0 errors are allowed there; any error means the whole batch is re-checked. Items about records, "current" holders, prices or populations are banned unless they carry `validUntil`.

### M5 `doodle`
- M5-01 covers Guess mode logic. **M5-01b** covers Telephone mode logic (cut-first: may slip to the next wave without blocking M5).
- **M5-06 Stroke pipeline:** RDP simplify, quantize, batches every 100 ms, playback into a `CanvasTexture` (texture uploads ≤ 30/s on mid/high, ≤ 15/s on low), and phone drawing input at 60 Hz with pointer coalescing. Accept: a recorded 600-point drawing replays on the Stage pixel-identically (swiftshader) to the phone canvas at the same resolution.
- M5-02: 1,200 default words plus 300 kids words.

### M6 `odd-one-out`
- M6-01..05. M6-02: 30 categories × 12 secrets, plus 150 Undercover pairs.

### M7 `ludo`
- M7-01..05. The controller uses the shared `board2d` SVG cross-track board (rotated so the player's base is at the bottom), with tap-to-select and snap-to-nearest legal token; the `requestBoard()` 3D board is an opt-in toggle.

### M8 `chess`
- M8-01 covers vote modes first (**Streamer vs Chat** is the headline stream mode) plus duel play with chess.js. **M8-01b** covers Team vs Team plus the guess-the-move play-along.
- The controller shows the shared `board2d` SVG board on phone (oriented to the player's colour), with tap-tap and drag; the 3D board is an opt-in toggle.

### M9 `marble-rally`
- **M9-00 Physics solver:** a deterministic fixed-point 2D circle vs segment/arc solver in `packages/games/marble-rally/src/logic/physics/*`. Unit tests check determinism across 3 runs, energy sanity, and 500 marbles stepping at 60 Hz in 4 ms or less per step on the dev machine.
- **M9-00b Tracks:** 3 tracks (`pencil-drop`, `cup-cascade`, `book-stack-switchback`) as JSON segment lists, plus the preview renderer.
- M9-01..05. M9-03 must render 500 marbles in 1 instanced draw on high and cap at 150 rendered on low (the rest become a dot `Points` layer).
- M9-05 extra: a bot-swarm run with 5,000 audience (500 enrolled, all nudging) keeps server egress ≤ 1.5 MB/s averaged over a race and the 60 Hz tick p99 ≤ 8 ms (report in `artifacts/perf/marble-load.json`).

---

## M10: Polish, performance, overlay, launch

| ID | Goal | Files | Depends | Parallel | Accept |
|---|---|---|---|---|---|
| **M10-01** Overlay layouts | `corner`, `scoreboard` and `poll` layouts: DOM only, transparent background, 1920×1080 design canvas | `apps/client/src/routes/overlay.tsx`, `packages/ui/src/overlay/*` | M1-09 | all | Each layout passes the critic. `full` holds 60 fps in the gpu project at 1080p. A transparent layout loads no three.js. |
| **M10-02** Twitch chat plugin | Anonymous IRC read: `!1`–`!4`, `!a`–`!d`, `!guess`, `!play` go into the aggregator | `apps/server/src/plugins/twitch.ts`, `ChatSource` interface | M1-03 | all | Mock IRC server test: chat votes merge into the tally with `tw:` ids. Off unless `TWITCH_CHANNEL` is set. |
| **M10-03** SqliteStore + crash restore | Snapshots and results in SQLite; rooms are restored on boot | `apps/server/src/store/sqlite.ts` | M1-02 | all | Kill the server mid-Ludo, restart it, and clients reconnect to the same state. |
| **M10-04** Public room browser | `/api/rooms` and a browse page | server `http.ts`, client `routes/browse.tsx` | M1-09 | all | Private rooms are never listed. |
| **M10-05** Service worker + prefetch polish | vite-plugin-pwa caches the shell, fonts and played games | client config | M1-09 | all | A warm-cache game switch takes 400 ms or less. |
| **M10-06** DOM/SVG Stage fallback | The **Stage** runs without WebGL2: Ludo and Chess reuse their `board2d` controllers' SVG boards scaled up; party games render their DOM HUD over a static CSS room illustration | `packages/games/{ludo,chess}/src/client/fallback.tsx`, shell detection | M7, M8 | all | Playwright with WebGL disabled hosts a full Quick Ludo game and a full Quip Clash game on the Stage. |
| **M10-07** Perf lab pass | Every game on the gpu project at 4× CPU and low tier; bundle audit; 15-minute soak with no leaks | `artifacts/perf/*` | all games | M10-08 | All budgets in SPEC §10 are green. Report committed. |
| **M10-08** Accessibility sweep | Keyboard play on the Stage (host) and on Chess and Ludo controllers; reduced motion; colour-blind simulation of every game's contact sheet | tests | all games | M10-07 | axe reports 0 serious findings. Deuteranopia and protanopia simulated sheets are reviewed by the critic with item 11 ≥ 8.5. |
| **M10-09** Drift guard re-critic | Fresh critic on every done game's golden shots against `_style/golden` | `artifacts/critic/drift/*` | all games | none | Every game still passes. Any game that fails goes back to `fixing`. |
| **M10-10** Launch soak | Bots run 8 players + 2,000 audience through a playlist of all 8 games, twice, with the Stage on the gpu project | `artifacts/perf/launch-soak.json` | all | none | 0 errors, no crashes, memory growth under 50 MB on the server, p99 latencies within budget, egress within the SPEC §10 budget, and the playlist runs in `audience-vote` mode with at least one bench/raffle cycle. |
| **M10-11** Docs | `README.md` (self-host in one command), `docs/HOSTING.md`, and a `docs/engine-api.md` generated from TSDoc | docs | all | all | A fresh clone reaches `pnpm start` with a room playable on the LAN in under 5 minutes. |

---

## Ownership rules
- **Engine owner** (one agent at a time) is the only one who edits `packages/{shared,engine,render,ui,audio}`, `apps/*` and `tools/*`.
- **Game builders** edit only `packages/games/<id>/**`, `content/packs/<their kinds>/**` and their spec's "Builder notes". Requests go to `docs/engine-requests.md`.
- **Engine requests are triaged between waves.** Any engine change re-runs the screenshots of every done game and pixel-diffs them. If more than 2% of pixels change, the affected game goes back to the critic.
