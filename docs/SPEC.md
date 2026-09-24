# Streamer Games Online: Product & Technical Spec (v1)

> Status: **authoritative**. Builder agents follow this document exactly. Where it conflicts with `docs/research/*`, this document wins (§15 lists the decisions and why). Anything this doc leaves out follows the research docs.
> Companion docs: `docs/ROADMAP.md` (what to build and in what order), `docs/DOD.md` (when a thing counts as done), `docs/specs/<game-id>.md` (one contract per game).
> Date: 2026-09-24.

---

## 1. Vision

The platform is a **cozy party-games room that runs in the browser.** A streamer opens it and shows it on stream. Viewers join from their phones with a 4-letter code, either as **players** or as the **audience**, and a night of short, funny, easy-to-read games plays out on a warm, lamp-lit wooden table.

Product pillars, in priority order:
1. **Everyone has a job.** Players play. The audience votes, predicts, plays along, guesses and bets. Nobody waits more than about 30 s with nothing to do.
2. **Readable on a phone watching a 720p stream.** Whose turn it is, what just happened and who is winning must be clear within 1 second.
3. **Runs on anything.** That means a school Chromebook, a 2019 Android phone, and a streamer's PC running OBS at the same time. The platform draws a frame only when something changes, and there is no post-processing.
4. **One style.** Every game uses the "Cozy Table" style: soft clay and wood toys on a wooden table in a small room, with 5 ambient modes. It should feel as polished as a AAA cozy game.
5. **Only games people actually play.** v1 has **8 games**, and each one is in the set because it is a proven stream or party hit (see §6).

Non-goals for v1: accounts, a persistent economy, real-time action netcode, voice chat, webcams, native apps, a WebGPU renderer, a Twitch Extension, and localization (English only; all strings still go through one `strings.ts` table per package so v2 can translate).

**Pacing pillar, made measurable.** Pillar 1 is enforced by DoD gate G14 (DOD.md §2): at default options, a simulated game must land inside its spec's session length, the audience must never go more than **30 s** without an open interaction (poll, guess, enrolment, direct action or `tap` meter), and a connected player must never go more than **45 s** without an input to make or a reveal about their own content. Each game spec lists its audience job **per phase** so the gap can be checked.

---

## 2. Roles & surfaces

| Role | Device / route | Sees | Can do |
|---|---|---|---|
| **Host** (streamer) | Desktop `/host/:code` (the **Stage**) | The 3D stage (built from the `stage` view) plus a host dock that can be hidden. **The Stage window only ever receives the `stage` view.** | Everything: playlist, options, start/next/pause/skip, kick/ban, promote, teams, seat raffle, ambient mode, reveal code, BRB |
| **Host panel** | Desktop pop-out `/host/:code/panel` (a second window the streamer does **not** capture) or any moderator device | The `host` view: moderation previews, pending text, per-game host info | Approve/reject, and every host command |
| **Moderator** | Phone or desktop `/:code` (moderator panel) | The `moderator` view plus the moderation queue | Approve or reject content, mute, rename, kick, pause |
| **Player** | Phone `/:code` (the **Controller**, DOM-only, no three.js) | Their private `player` view | Game actions |
| **Audience** | Phone `/:code` (audience controller, DOM-only "lite" by default) | The shared `audience` view | Vote, predict, play along, guess, react, join the next-round queue, and send direct actions in Marble Rally |
| **Overlay** | OBS Browser Source `/overlay/:code?key=…&layout=…` | The `stage` view | Nothing; read-only |

Rules:
- **The Stage never shows private info, and never shows unmoderated user content.** Moderation previews (pending answers, drawings awaiting review) and any host-only information are rendered only in the host panel pop-out or on moderator devices, because the Stage window is assumed to be captured by OBS at all times, dock included. The dock shows counts only ("2 pending — open panel").
- If the host wants to play, they join as a player from a second device or tab at `/:code`. The Stage warns about this once.
- Only 2 surfaces render the three.js scene: the Stage and the overlay `full` layout. **Every controller is DOM-only by default**, including Ludo and Chess, which use a 2D SVG board (the same component as the Chess audience panel and the no-WebGL fallback). A "3D board" toggle on those two controllers lazy-loads the stage renderer at low tier through `requestBoard()`; it is off by default.
- **Audience lite:** the audience controller has no three.js. A "Show board" toggle loads the stage renderer at low tier and is **off by default**.

---

## 3. Room & lobby flow

1. The host opens `/`, picks "Host a room", sets a display name, and is sent to `/host/ABCD`. The code uses 4 letters from `BCDFGHJKLMNPQRSTVWXZ`, has no vowels, and is checked against a blocklist.
2. **Lobby:** the camera is in the Establishing shot. The Stage shows the room code (large, with a QR code), player plates as they join, the audience count, and the playlist. `hideCode` blurs the code and QR until the host reveals them.
3. **Joining:** a viewer opens `/:code` and enters a name. A profanity filter runs, and the name is capped at 16 characters. If a player seat is free and `lateJoin` allows it, the viewer takes it; otherwise they join the audience. Players can move to the audience at any time, and audience members can ask to "join next round" (the **queue**).
   - **Seat raffle** (big streams): the host presses "Raffle N seats" (`HostCommand raffle`). The server picks N members uniformly at random (seeded room RNG) from the queue, or from the whole audience if the queue is empty, and seats them at the next game boundary. The Stage plays a short raffle-wheel moment with the winners' names. `RoomConfig.seatPick = "fifo" | "raffle"` decides how free seats are filled from the queue automatically.
4. **Seats vs game capacity.** The room can hold more seated players (`maxPlayers`, up to 12) than the next game allows (Ludo 4, Chess duel 2). At game start the platform picks participants: first players who sat out the previous game, then a seeded random draw. Everyone else is **benched** for that game: they get the audience role and controller, keep their Night Champion total, and are guaranteed a seat in the next game that has room. The host sees "4 of 9 will play" in the dock and can hand-pick instead. If seated players < the game's `minPlayers`, the host is offered "Fill with bots" (practice) or "Skip game".
5. **Playlist:** the host adds games, and each game's options form is generated from its `optionSpecs`. `RoomConfig.playlistMode`:
   - `fixed`: games run in playlist order.
   - `audience-vote` (**default**): at each Scoreboard interstitial the audience votes (`vote` poll, 15 s) on the next game from 3 not-yet-played playlist entries; below `audienceMin`, the next entry in order runs. This is the single strongest between-games audience hook, and it costs nothing to build.

   Presets:
   - **Quick Stream Set:** Quip Clash, Tune In, Doodle (Guess), Marble Rally.
   - **Chat Only** (the streamer is the only seated player; for streamers whose chat will not install anything beyond a web page): Trivia Night (streamer solo, chat on its own leaderboard), Chess (Streamer vs Chat), Marble Rally.
   - **Board Night:** Ludo, then Chess (Streamer vs Chat).
   - **Family Night:** content filter set to family, spicy packs off, Quip Clash, Doodle (Guess), Tune In, Trivia Night.

   Presets are stored in `localStorage` and can be exported as JSON.
6. **Game loop:** an intro card with 3 steps (skippable, 6 s with the timer on), then the game, then Results (the winner moment), then a Scoreboard interstitial (the Night Champion standings, plus the next-game vote), then the next game. The next game's code chunk is prefetched while Results is showing (for `audience-vote`, all 3 candidates are prefetched; each is ≤ 60 KB).
7. **Pause / BRB:** `pause` freezes every deadline (remaining time is stored and restored on `resume`), closes nothing, and shows a cozy "Be right back" card on the Stage (the cat wakes up and stretches). Audience reactions keep working during BRB.
8. **End of night:** a Night Champion podium, audience MVPs (top predictor, top play-along player), and highlights.

Idle-proof rules for every game:
- A disconnected player's seat is held for `reconnectGraceSec` (60 s by default). While they are away, **the game module's bot plays their turns** (for party games, the bot submits a "safety" answer from the content pack).
- An eliminated player moves to the audience role and keeps their score.
- A late joiner goes to the audience first and is seated at the next round boundary.

---

## 4. Audience system (platform-owned; games plug in)

Games never touch individual audience votes. They emit effects (§9.3), the platform's `AudienceAggregator` collects the inputs, and the game receives the aggregate result. Audience members get a room-local identity (`audId`) and two balances: **Seeds**, the prediction currency (starts at 1000 and never goes below 100), and **Play-along points**, which feed the audience leaderboard.

| Poll kind | Audience input | What is broadcast (≤ 4 Hz) | What the game gets | Platform-side scoring |
|---|---|---|---|---|
| `vote` | one option (can be changed until close) | tallies per option | `PollResult` tallies (+ per team) | none |
| `predict` | one option + fixed stake (100 Seeds, host-configurable) | tallies + implied odds | tallies | pari-mutuel payout when the game emits `audience.resolve` |
| `quiz` | one option (first answer locks) | answered count only (no distribution until resolve) | tallies after resolve | correct: 100 pts + speed bonus up to 50 (optional) |
| `dial` | an integer 0–1000 | 50-bin histogram | histogram + mean | band points via `resolve.target` and `bands` |
| `guess` | free text ≤ 32 chars, max 1 per 1.5 s | count of correct guessers | count correct + first 3 correct names | matched server-side against the effect's secret `accept[]` (normalized, Levenshtein ≤ 1 for words of 5+ letters counts as "close", not correct). Points 100→20 by order of correct guesses |
| `tap` | taps (max 5/s, counted) | total taps | total taps | none (cosmetic meters) |

Other platform-owned audience features:
- **Reactions:** 6 fixed emotes (heart, laugh, wow, clap, fire, sad). They are aggregated every 500 ms, and the Stage draws at most 30 floating sprites at once.
- **Direct audience actions** (`manifest.audience.direct = true`; only Marble Rally uses this): enrolment plus per-viewer actions, rate-limited, delivered to `onAudienceEnroll` and `onAudienceAction`.
- **Stream delay:** `RoomConfig.streamDelaySec` (0–8, default 3) is added to every **timed** audience poll window and to every player input window (through `ctx.timing.input`). The Stage shows a soft "closing…" state instead of a hard cut.
  - **Minimum audience window:** when a phase with an open audience poll ends *early* (everyone voted, everyone ready), the platform delays the close until at least `streamDelaySec + 5 s` after the poll opened. Games do not implement this themselves; the runner holds the early-close effect. This fixes the "audience sees the answers on stream after the poll already closed" failure.
  - **Event-closed polls** (Chess guess-the-move, which closes the instant the move is made) are exempt: audience phones receive the view in real time (they are not delayed like the stream), and any audience input with a server receive time after the closing event is discarded.
- **Hidden-live polls:** `PollSpec.hideLive = true` broadcasts only the answered count until close, then the full distribution (used by Tune In so the team cannot copy chat's heatmap).
- **Minimum audience:** an audience vote affects scoring only when at least `audienceMin` members voted (default 5). Below that, the vote is shown but does not count.
- **Audience idle rule:** every game phase that lasts longer than 30 s must have at least one open audience interaction. Game specs declare the audience job per phase; G14 checks it.
- **Audience purple** (`#B58AF0`) is used for every audience-driven thing on screen, and for nothing else.
- **Mode vote:** between games the audience can vote on the next ambient mode (host toggle).
- **Twitch chat** (optional plugin, M10-02): `!1`–`!4`, `!a`–`!d`, `!guess <word>` and `!play` go into the same aggregator with `audId = "tw:<userId>"`.

---

## 5. Teams, scoring, leaderboards

- **Teams live at room level.** `teams.mode` is one of `none | host | auto | self`, with 2, 3 or 4 teams. The default team colours are Tomato, Sky, Sunflower and Mint. A game's `teamSupport` is one of `none | optional | required`. Audience members can be split into teams too, and their votes then come back per team in `PollResult.byTeam`.
- **Night Champion** is the session scoreboard. Each finished game's `GameResult.ranking` becomes placement points **10 / 7 / 5 / 3 / 2 / 1**, and every lower place gets 1. The host can switch to `raw` scoring. Ties share the higher placement.
- **Audience leaderboard:** play-along points plus Seeds won, shown on the Scoreboard interstitial (top 5) and on each audience member's phone (their own rank).
- **Persistent leaderboards** are available only with `SqliteStore` and a Twitch-linked identity (M10-03). They are off by default.
- **Benched players and bots** earn no placement points for a game they did not play. Bot-filled seats never appear in the Night Champion standings.
- A game whose `GameResult.ranking` is empty (Marble Rally with no seated players, Chess Streamer vs Chat when the streamer loses) leaves Night Champion unchanged.

---

## 6. Launch games (FINAL, 8)

Curated by engagement: proven stream or party hits, learnable in 30 s, fun to watch, short rounds, and a real job for the audience. **Nothing else ships in v1.**

| # | id | Name | Based on (mechanic only) | Players | Session | Audience job | Build order |
|---|---|---|---|---|---|---|---|
| 1 | `quip-clash` | **Quip Clash** | Quiplash | 3–8 | 12–15 min | Votes on every matchup (weighted bloc), predicts each round's winner while players write, Audience Favourite | G1 (**style golden**) |
| 2 | `tune-in` | **Tune In** | Wavelength | 2–12 (2 teams or FFA) | 10–15 min | Picks the spectrum card, bets on the team's result while the clue is written, places its own dial (heatmap revealed at lock) | G2 |
| 3 | `trivia-night` | **Trivia Night** (Classic + Bluff) | Kahoot / Trivia Murder Party / Fibbage | 1–10 | ~10 min | Plays every question on its own leaderboard, predicts the Showdown, one lifeline | G3 |
| 4 | `doodle` | **Doodle** (Guess default; Telephone opt-in) | skribbl.io / Gartic Phone | Guess 3–12, Telephone 4–10 | 8–13 min | Guesses every drawing (own leaderboard), votes the difficulty tier ("make it HARD"), bets on Chain of the Night, votes funniest step | G4 |
| 5 | `odd-one-out` | **Odd One Out** | Spyfall / Chameleon | 4–10 | 10–14 min (3 rounds) | Knows the secret, bets on the imposter, sus meter | G5 |
| 6 | `ludo` | **Ludo** (Quick Ludo default) | Ludo | 2–4 (2v2 teams) | 8–12 min | 2 Blessing die votes, "who finishes first" prediction, capture hype meter | G6 |
| 7 | `chess` | **Chess** (Streamer vs Chat is the headline mode) | Chess | 1 (vs Chat), 2 (duel), or 2 teams | 10–25 min, hard-capped | Votes on moves, guess-the-move play-along | G7 |
| 8 | `marble-rally` | **Marble Rally** | Marbles on Stream | the audience (≤ 500 marbles) + featured players | 2–3 min per race | *Is* the game: enrol once, nudge, bet | G8 |

Ludo and Chess are in because the product owner asked for them; they are the two weakest *audience* games in the set, so both are redesigned for streaming (Quick Ludo with audience blessings; Chess led by Streamer vs Chat) and neither is in the Quick Stream Set. If either misses its G14 pacing gate, it ships behind a "Board games" toggle rather than slipping the launch.

**Build-order risk:** Doodle Telephone and Trivia Bluff are sub-modes with their own logic items (M5-01b, M4-01b). They are **cut-first**: if Wave A runs late, they move to the next wave and the base mode ships alone.

Next wave (post-v1, not to be built now): Team Words (Codenames-like), Pin the Globe, Mini Golf, Chat Wordle, Crazy Eights, Duel Arcade.

Cut, with the reasons: Among Us-likes (real-time plus voice), Werewolf (elimination leaves players idle), Fall Guys-likes (too much compute), Pool, Bowling, Darts and Battleship (dull to watch), Charades (needs webcams).

**Legal:** original names, original prompts, questions, cards and art only. Never copy Jackbox, Codenames or Wavelength text or trade dress.

---

## 7. Host customization

`RoomConfig` (in `packages/shared/src/room.ts`):

```ts
export type AmbientMode = "day" | "dusk" | "night" | "rain" | "snow"; // "dusk" is labelled "Golden Hour"; default
export interface RoomConfig {
  visibility: "private" | "public";
  password?: string;
  maxPlayers: number;               // seated players in the room, 1..12; each game takes up to its own max (§3 step 4)
  maxAudience: number;              // default 10_000
  lateJoin: "audience" | "queue" | "deny";
  seatPick: "fifo" | "raffle";      // how free seats are filled from the queue at game boundaries
  playlistMode: "fixed" | "audience-vote";  // default audience-vote (§3 step 5)
  antiSnipe: boolean;               // default true: audience sessions sharing an IP hash with a seated player get the restricted view.
                                    // Turn OFF for classrooms/LAN parties where everyone shares one NAT IP (otherwise nobody sees secrets).
  contentFilter: "family" | "standard";   // family also filters names, disables spicy packs
  moderation: "off" | "reveal-review";    // reveal-review: user text/drawings wait for host/mod approval before stage reveal
  hideCode: boolean;
  timerScale: 0 | 0.75 | 1 | 1.5 | 2;  // 0 = no input timers (host advances); 0.75 = "Snappy" for experienced groups
  streamDelaySec: number;           // 0..8, default 3
  audienceMin: number;              // default 5
  reconnectGraceSec: number;        // default 60
  teams: { mode: "none" | "host" | "auto" | "self"; count: 2 | 3 | 4 };
  scoring: "placement" | "raw";
  theme: { ambient: AmbientMode; autoCycleMin: 0 | 10 | 20 | 30; audienceModeVote: boolean };
  streamLayout: { enabled: boolean; webcam: "br" | "bl" | "tr" | "tl" | "none" };  // keeps zones clear via camera view offset
  audio: { music: number; sfx: number; ambience: number; streamerSafe: boolean };  // 0..1
  quality: "auto" | "battery" | "balanced" | "pretty";
  playlist: PlaylistItem[];
}
export interface PlaylistItem { gameId: GameId; options: Record<string, unknown>; label?: string }
export type GameId = "quip-clash" | "tune-in" | "trivia-night" | "doodle" | "odd-one-out" | "ludo" | "chess" | "marble-rally";
```

Host stream deck:
- Keyboard shortcuts: `Space` for start/next, `P` for pause/BRB, `C` to reveal the code, `1`–`5` to set the ambient mode, `H` to hide the dock, `M` to open the host panel pop-out, `R` to raffle seats.
- Big buttons: Start, Next, Pause/BRB, Skip, Reveal code, Raffle seats, and an ambient mode picker.
- Everything on the stream deck is also reachable from the host panel pop-out, so a single-monitor streamer can keep the Stage window clean.

---

## 8. Ambient modes

There are 5 modes: `day`, `dusk` (Golden Hour, the default), `night`, `rain` and `snow`. A mode changes **light, sky, weather, fog, UI surface tint and the ambience audio bed**, and never changes gameplay or player colours. Switching modes lerps every token over **2.5 s**, with a 400 ms curtain slide on the window.
- The host can auto-cycle modes every 10, 20 or 30 minutes, and the audience can vote on the next mode.
- `night` is the only mode with a dark UI.
- `snow` is seasonal. It is **required to render correctly**, but the visual critic judges only 4 modes (day, dusk, night, rain) and spot-checks snow once per game.

The full token tables are in §13.

---

## 9. Tech stack & architecture

### 9.1 Exact versions (pin with a caret on minor unless noted; `pnpm-lock.yaml` committed)

| Area | Package | Version |
|---|---|---|
| Runtime | Node.js | **22 LTS (≥ 22.12)**; `engines.node: ">=22.12 <25"` |
| Package manager | pnpm (via corepack) | `packageManager: "pnpm@12.4.1"` |
| Language | typescript | **6.0.3** (exact; typescript-eslint requires < 6.1; TS 7 native is not used in v1) |
| Bundler (client) | vite | ^8.3.1 |
| UI (DOM) | preact + @preact/signals + @preact/preset-vite | ^10.29.8, ^2.11.2, ^2.10.6 |
| 3D | three + @types/three | **0.186.1 exact** + 0.186.0 (upgrade deliberately, once a quarter) |
| Server transport | uWebSockets.js | `github:uNetworking/uWebSockets.js#v20.71.0` |
| Transport fallback / bots | ws + @types/ws | ^8.21.3, ^8.18.1 |
| Server build / dev | esbuild, tsx | ^0.28.2, ^4.23.15 |
| Validation | zod | ^4.6.5 (server-side `parseAction` and config; **not** imported by client chunks except the host options form) |
| Chess rules | chess.js | ^1.4.0 |
| Profanity filter | obscenity | ^0.4.6 |
| QR | qrcode-generator | ^2.0.4 |
| Storage (optional) | better-sqlite3 | ^13.0.3 |
| Service worker | vite-plugin-pwa | ^1.3.0 |
| Fonts (self-hosted) | @fontsource-variable/fredoka, @fontsource-variable/nunito, @fontsource/caveat | ^5.3.0 (latin + latin-ext only) |
| Icons | lucide | ^1.48.0 (named imports only) |
| Unit tests | vitest + @vitest/coverage-v8 | ^5.0.1 |
| E2E / screenshots / perf | @playwright/test, @axe-core/playwright | ^1.63.0, ^4.13.0 |
| Image tooling (harness) | sharp, pixelmatch, pngjs | ^0.35.4, ^7.2.0, ^7.0.0 |
| Lint / format | eslint, typescript-eslint, eslint-plugin-boundaries, prettier | ^10.11.0, ^8.70.1, ^7.2.0, ^3.9.9 |
| Bundle budgets | size-limit | ^14.0.0 |
| Dev orchestration | concurrently | ^10.0.5 |

**Banned in v1:**
- Frameworks and libraries: React, Colyseus, Socket.IO, PartyKit.
- Physics engines: cannon-es, matter.js and Rapier. Marble Rally uses our own 2D solver.
- Three.js features: `EffectComposer`, `MeshStandardMaterial`, `MeshPhysicalMaterial`, point-light shadows, and `import * as THREE`.
- Rendering and assets: WebGPU renderer, KTX2/basis (textures are procedural, see §13.6), and Google Fonts CDN at runtime.

### 9.2 Monorepo layout (pnpm workspaces)

```
streamer-games-online/
├─ CLAUDE.md                     # agent house rules (M0-03)
├─ progress.json / PROGRESS.md   # status source of truth / generated table
├─ package.json  pnpm-workspace.yaml  tsconfig.base.json  vitest.workspace.ts  eslint.config.js  playwright.config.ts  .size-limit.cjs
├─ docs/ SPEC.md ROADMAP.md DOD.md specs/<id>.md research/ references/_style/golden/ references/<id>/ engine-requests.md critic/RUBRIC.md critic/report.schema.json
├─ packages/
│  ├─ shared/     @sg/shared   protocol.ts, room.ts, ids, rng.ts (sfc32), diff.ts, codec (json + binary frames), text.ts (normalize, levenshtein, filter wrapper), content schema
│  ├─ engine/     @sg/engine   game-module.ts, client-module.ts, runner.ts (GameRunner, pure), timing.ts, testing/ (runScript, contract suite, sim runner, scenario types)
│  ├─ render/     @sg/render   renderer.ts, loop.ts, quality.ts, camera-rig.ts, springs.ts, tween.ts, materials/*, textures/* (procedural), room/ (diorama), table.ts, mats.ts, pieces/ (lathe, rounded box, dice), fx/ (confetti, puff, blob-shadows, reactions, halos), ambient/ (modes, sky, weather), picking.ts, dispose.ts
│  ├─ ui/         @sg/ui       tokens.ts + tokens.css, Preact components (Button, Card, Chip, PlayerPlate, TimerRing, VoteBars, Toast, Sheet, Modal, Input, CodeBadge, QR), HUD layout, transitions (Lamp Blink, Iris), icons
│  ├─ audio/      @sg/audio    synth sfx, pentatonic quantizer, ambience beds, generative lofi, buses/ducking
│  └─ games/<id>/ @sg/game-<id>
│       src/logic/        pure rules (index.ts exports `logic: GameModule`)
│       src/bot.ts        bot policy (used by runner takeover + sims)
│       src/content/      pack loaders (server-only)
│       src/client/       stage.ts, controller.tsx, audience.tsx? (optional), assets.ts
│       src/scenarios.ts  ScenarioRegistry
│       src/index.ts      manifest re-export
│       test/             logic.test.ts, sim.test.ts, contract.test.ts
│       package.json exports: "./logic" (server-safe), "./client" (browser), "./scenarios"
├─ content/packs/<kind>/<pack-id>.json     # word lists, prompts, questions, spectrum cards (server-read only)
├─ apps/
│  ├─ server/     @sg/server   transport/(uws, ws), session.ts, room-manager.ts, room.ts (actor), audience-aggregator.ts, moderation.ts, store/(memory, sqlite), http.ts, games.ts (registry), plugins/twitch.ts, bin.ts
│  └─ client/     @sg/client   Vite app: routes / , /host/:code, /host/:code/panel, /:code, /overlay/:code, /dev/scenario ; shell/ (net client, clock sync, stage host, controller host, audience lite, host panel), games.ts (lazy registry). Two entry points: `stage` (with three) and `controller` (without)
└─ tools/
   ├─ bots/       @sg/bots     headless swarm: N players, M audience
   └─ harness/    @sg/harness  verify-game.ts, screenshots.spec.ts, clips.spec.ts, perf.spec.ts, contact-sheet.ts, ab-pairs.ts, stream-sim.ts, progress.ts, check-scenarios.ts
```

Dependency rules, enforced by eslint-plugin-boundaries and a chunk-graph check:
- `games/*` may import `@sg/shared` and `@sg/engine`. `client/**` in a game may additionally import `@sg/render`, `@sg/ui`, `@sg/audio` and `three`.
- `logic/**` may never import three, the DOM, `@sg/render`, `@sg/ui` or `@sg/audio`.
- **No game imports another game.**
- `apps/server` never imports any `client` entry.

Scripts (root `package.json`):
- Development and build: `dev` (server via tsx watch plus Vite, with `/ws` proxied), `build`, `start` (a single port serves the client's `dist` and `/ws`), `preview`.
- Checks: `typecheck`, `lint`, `test`, `size`.
- Game gates and harness: `verify:game <id>`, `verify:item <id>`, `shots <id>`, `perf:game <id>`, `critic:prep <id>`.
- Tools: `bots`, `progress`.

Dev and self-host need no external services. The default port is `8787`.

### 9.3 Game module API (logic; `packages/engine/src/game-module.ts`)

```ts
import type { Rng, PlayerId, TeamId, AudId, GameId } from "@sg/shared";

export interface GameManifest {
  id: GameId; name: string; version: string;          // semver; stored in snapshots
  minPlayers: number; maxPlayers: number;
  teamSupport: "none" | "optional" | "required";
  audience: { vote?: true; predict?: true; quiz?: true; dial?: true; guess?: true; tap?: true; direct?: true; joinQueue?: true };
  tickHz: 0 | 10 | 20 | 60;                            // 0 = timer/event driven. Only marble-rally uses 60 (server sim).
  renderMode: "on-demand" | "continuous";              // client loop hint; only marble-rally is continuous (during race)
  estMinutes: [number, number];
  tags: string[];
  contentRating: "all" | "teen";
  howToPlay: [string, string, string];                  // 3 steps, ≤ 60 chars each
}

export type OptionSpec =
  | { kind: "int"; key: string; label: string; min: number; max: number; step?: number; default: number }
  | { kind: "bool"; key: string; label: string; default: boolean }
  | { kind: "enum"; key: string; label: string; choices: { value: string; label: string }[]; default: string }
  | { kind: "seconds"; key: string; label: string; min: number; max: number; default: number }
  | { kind: "pack"; key: string; label: string; packKind: PackKind; multi: boolean; default: string[] };

export interface Timing {
  /** Player/audience input window: base × timerScale + streamDelay. Returns null when timerScale = 0 (no timer). */
  input(baseMs: number): number | null;
  /** Pacing (reveals, animations, readouts): base only, never scaled, never null. */
  pace(baseMs: number): number;
}

export interface Seat { id: PlayerId; name: string; seat: number; teamId?: TeamId; colorSlot: number /*0..7*/ }

export interface SetupContext<O> {
  players: Seat[]; teams: { id: TeamId; name: string; colorSlot: number }[];
  options: O; rng: Rng; now: number; timing: Timing;
  content: ContentAccess;          // server-only pack access (sync, pre-loaded); returns [] in client scenarios unless fixture given
  audienceCount: number;
}
export interface Ctx { rng: Rng; now: number; timing: Timing; audienceCount: number }
export interface ActionCtx extends Ctx { actor: { id: PlayerId; role: "player" | "host" | "moderator"; teamId?: TeamId } }

export interface Step<S> { state: S; effects?: Effect[] }

export type Effect =
  | { type: "timer.set"; id: string; atMs: number }
  | { type: "timer.clear"; id: string }
  | { type: "audience.open"; poll: PollSpec }
  | { type: "audience.close"; pollId: string }
  | { type: "audience.resolve"; pollId: string; correct?: string; target?: number; bands?: { within: number; points: number }[] }
  | { type: "audience.enroll"; open: boolean; closesAtMs?: number; cap?: number }
  | { type: "score"; deltas: Record<string, number> }            // PlayerId | TeamId -> points (in-game running score)
  | { type: "fx"; name: string; data?: unknown }                 // cosmetic cue: sfx, confetti, camera
  | { type: "moderate"; itemId: string; kind: "text" | "drawing"; ownerId: PlayerId | AudId; preview: string }
  | { type: "stream"; channel: "stage" | "aud"; frame: Uint8Array }   // binary side-channel (marble-rally only), published as-is to a topic
  | { type: "streamEach"; frames: { to: AudId | PlayerId; frame: Uint8Array }[] }  // tiny per-socket binary frames (marble-rally 0x03 "your rank"); never used for > 1 Hz
  | { type: "private"; to: PlayerId; name: string; data?: unknown }   // one-off private cue to one player (e.g. "close guess!") — not part of the view
  | { type: "audience.award"; points: Record<AudId, number> }         // direct play-along points (marble-rally race results)
  | { type: "end"; result: GameResult };

export interface PollSpec {
  pollId: string; kind: "vote" | "predict" | "quiz" | "dial" | "guess" | "tap";
  prompt: string; options?: { id: string; label: string }[];
  closesAtMs: number;
  accept?: string[];               // guess only — server-side secret, never broadcast
  speedBonus?: boolean;            // quiz only
  teamSplit?: boolean;
  hideLive?: boolean;              // broadcast answered-count only until close (§4)
  closeOn?: "deadline" | "event";  // "event": closed by the game via audience.close; exempt from stream delay (§4)
}
export interface PollResult {
  pollId: string; kind: PollSpec["kind"]; total: number;
  tallies: Record<string, number>;           // optionId -> count; dial: bin index -> count; tap: {taps}
  byTeam?: Record<TeamId, Record<string, number>>;
  mean?: number;                             // dial
  firstCorrect?: { audId: AudId; name: string }[]; // guess
}
export interface GameResult {
  ranking: { id: PlayerId | TeamId; score: number; place: number }[];
  highlights?: { label: string; playerId?: PlayerId; audId?: AudId }[];
}

export type ViewerKey =
  | { role: "player"; id: PlayerId }
  | { role: "audience"; restricted?: boolean }  // ONE shared view for all audience; `restricted` = second shared view for audience sessions whose IP hash matches a seated player (games strip secrets there)
  | { role: "stage" }        // safe to broadcast; used by host Stage and overlay
  | { role: "host" }         // stage + host-only info (moderation previews, pending counts); never player secrets. Delivered ONLY to the host panel pop-out, never to the Stage window (§2)
  | { role: "moderator" };

export interface GameModule<S, A, O, V> {
  manifest: GameManifest;
  optionSpecs: OptionSpec[];
  parseAction(raw: unknown): A | null;                         // never throws
  setup(ctx: SetupContext<O>): Step<S>;
  onAction(state: S, action: A, ctx: ActionCtx): Step<S>;      // illegal -> { state } unchanged + fx "illegal"
  onTimer?(state: S, timerId: string, ctx: Ctx): Step<S>;
  onTick?(state: S, dtMs: number, ctx: Ctx): Step<S>;
  onAudienceResult?(state: S, r: PollResult, ctx: Ctx): Step<S>;
  onAudienceEnroll?(state: S, entrants: { audId: AudId; name: string; skin: number }[], ctx: Ctx): Step<S>;
  onAudienceAction?(state: S, audId: AudId, action: unknown, ctx: Ctx): Step<S>;
  onModeration?(state: S, itemId: string, approved: boolean, ctx: Ctx): Step<S>;
  onPlayerLeave?(state: S, id: PlayerId, ctx: Ctx): Step<S>;
  onPlayerRejoin?(state: S, id: PlayerId, ctx: Ctx): Step<S>;
  onHostCommand?(state: S, cmd: { c: "forceAdvance" } | { c: "skipItem"; itemId: string }, ctx: Ctx): Step<S>;
  view(state: S, viewer: ViewerKey): V;                        // SECURITY BOUNDARY
  legalActions(state: S, player: PlayerId): A[];               // may return a representative sample for text games
  bot(state: S, player: PlayerId, rng: Rng): A | null;         // REQUIRED: takeover + sims
  serialize(state: S): string;
  deserialize(data: string): S;
}
```

Module rules (lint and contract tests enforce these; breaking one fails the DoD):
1. Game logic must not use `Math.random`, `Date`, timers, I/O, globals or `structuredClone` of anything outside `state`. Randomness comes from `ctx.rng`, time from `ctx.now`, and durations from `ctx.timing`.
2. State is plain JSON: no classes, Maps or Sets. It is treated as immutable (a dev-mode deep-freeze guard checks this on every step for `tickHz: 0` games, and on every 60th step for `tickHz: 60`, so Marble Rally's 60 Hz sim is not dominated by freezing).
3. Every view includes `phase: string` and `deadline: number | null` (server ms). Clients convert `deadline` to local time using the clock offset from `pong`.
4. **Secrets:** any state field holding hidden information must be under a key named `secret` or `hidden`, or listed in `export const secretPaths: string[]` (JSONPath-lite, e.g. `"chains[*].steps"`) from the game's `logic/index.ts`. A contract fuzz test asserts that no `view()` for another viewer contains those values (string values of length ≥ 3 are searched for verbatim in the serialized view; numbers are checked by path).
5. Content (answers, correct options, secret words) stays on the server. It reaches clients only through `view()` and only once it is revealed.
6. `onAction` never throws. Bad input returns the state unchanged.

### 9.4 Client module API (`packages/engine/src/client-module.ts`)

```ts
export interface GameClientModule<V, A> {
  id: GameId;
  mat: MatKind;                                   // "wood-board" | "inlay" | "paper" | "cork" | "felt" | "pegboard"
  stage(ctx: StageContext): StageInstance<V>;     // 3D objects + stage HUD (DOM), consumes stage|host view
  controller(ctx: ControllerContext<A>): ControllerInstance<V>;    // phone UI for players (Preact, DOM/SVG); may call ctx.requestBoard() ONLY behind the opt-in "3D board" toggle (lazy-loads three)
  audience?(ctx: ControllerContext<never>): ControllerInstance<V>; // optional custom audience panel; default = generic poll UI
}
export interface StageContext {
  scene: import("three").Group;                   // game root; shell owns Scene, room, table, lights
  camera: CameraRig;                              // setState("establishing"|"play"|"focus"|"top"), focusOn(vec3)
  hud: HTMLElement;                               // DOM layer for Preact
  theme: ThemeApi;                                // tokens, current mode, onModeChange
  quality: QualityTier;                           // "low" | "mid" | "high"
  loop: { invalidate(): void; beginAnim(): () => void };  // games NEVER call requestAnimationFrame
  tween: TweenApi; springs: SpringPresets;
  fx: FxApi;                                      // confetti(color[]), puff(pos, color), halo, reactions
  mats: MatApi;                                   // setMat(kind, canvasPainter)
  materials: MaterialFactories;                   // makeToon, makeMatcap, makeLambertVC, makeBasic — ONLY source of materials
  textures: ProceduralTextures;
  sfx: (name: SfxName, opts?: { pitchStep?: number }) => void;
  pick: PickApi;                                  // analytic plane picking + instanced raycast
  reducedMotion: boolean;
}
export interface StageInstance<V> {
  update(view: V, prev: V | null): void;          // diff-driven animation
  onFx?(e: { name: string; data?: unknown }): void;
  seek?(anim: string, t: number): void;           // scenario t-scrub (0..1) for screenshots
  frame?(dtMs: number): void;
  resize?(w: number, h: number): void;
  dispose(): void;                                // MUST free everything it created
}
export interface ControllerContext<A> {
  root: HTMLElement; theme: ThemeApi; send(action: A): Promise<{ ok: boolean; err?: string }>;
  sfx: StageContext["sfx"]; haptic(ms: number): void; requestBoard(): Promise<StageContext>; me: { id: string; colorSlot: number };
}
export interface ControllerInstance<V> { update(view: V, prev: V | null): void; dispose(): void }
```

The shell owns all of the following, and games only add to `ctx.scene` and `ctx.hud`:
- the renderer, the one render loop, the room, the table and lights
- ambient modes and the camera rig
- transitions (Lamp Blink, Iris), the intro card, Results and the Scoreboard
- the reactions layer, the audience panel and the timer HUD

### 9.5 Server

- **One process is one server.** Each room is a single-threaded actor with an input queue, and `GameRunner` applies the module's reducer and effects.
  - Turn-based rooms use no ticks.
  - Every N = 20 actions or every 10 s, the room writes a snapshot to the Store (for `tickHz > 0` games, and for audience-driven actions, only the 10 s rule applies, so 500 Marble Rally nudges don't trigger 25 snapshots). `MemoryStore` is the default; `SqliteStore` is used when `STORE=sqlite`.
- **uWS topics:** `r:CODE:aud` (the shared audience buffer), `r:CODE:stage` (stage, overlay and marble frames), plus direct sends for player and host views. Each distinct viewer key gets **one pre-serialized buffer per step**, and multiple steps in one event-loop turn are coalesced into one message.
- **Rate limits and caps:**
  - Players: 20 msg/s. Audience: 5 msg/s. (Game-level limits, such as Marble Rally's one nudge per checkpoint section, are enforced by the game and silently drop extras.)
  - Connections: 64 per IP. Join attempts: 40 per minute per IP. Both are configurable in `server.config.json` (`perIpConnections`, `perIpJoinsPerMin`); the defaults are sized so a school Chromebook lab or a dorm behind one NAT IP can join (the previous 20/10 would lock out a classroom).
  - `maxPayloadLength`: 16 KB. A Doodle stroke batch is at most 4 KB.
- **Reconnection:** each session has a `sessionToken` (128-bit) stored in `localStorage` under `sg:<code>`. The server holds the seat through the grace period. The client reconnects with backoff from 0.5 s up to 8 s with jitter, and shows a soft "reconnecting…" pill.
- **Heartbeat:** an app-level ping every 10 s, and uWS `idleTimeout` of 30 s.
- **Rooms are cleaned up** 10 minutes after they empty. A room code is released 30 minutes after the room ends, and a `roomEpoch` counter invalidates old tokens.
- **Config:** `server.config.json` sets maxRooms (default 200), allowed games, the default content filter, the public listing switch, the admin key and the port.

### 9.6 Network protocol (`packages/shared/src/protocol.ts`)

Each client opens one WebSocket at `/ws`. JSON text frames carry control messages and views. **Binary frames are used only by Marble Rally**. `PROTOCOL_VERSION = 1`.

```ts
export type C2S =
  | { t: "hello"; v: 1; code: string; token?: string; name?: string; want: "player" | "audience" | "overlay" | "moderator"; overlayKey?: string; password?: string }
  | { t: "create"; v: 1; name: string; config?: Partial<RoomConfig> }
  | { t: "act"; id: number; a: unknown }                                   // player game action, acked
  | { t: "aud"; pollId: string; choice: string | number }                   // vote/predict/quiz option id, dial int, guess text
  | { t: "tap"; pollId: string; n: number }                                 // batched taps, n ≤ 10
  | { t: "audAct"; a: unknown }                                             // direct audience action (marble-rally)
  | { t: "enroll"; skin: number }                                           // join an open audience enrolment (marble-rally), skin 0..47
  | { t: "react"; e: ReactionId }
  | { t: "queue"; join: boolean }                                          // audience asks for next-round seat
  | { t: "host"; cmd: HostCommand }
  | { t: "mod"; cmd: ModCommand }
  | { t: "resync"; lastSeq: number }
  | { t: "bg"; on: boolean }                                               // tab hidden: drop cosmetic traffic
  | { t: "ping"; ts: number };

export type HostCommand =
  | { c: "config"; patch: Partial<RoomConfig> } | { c: "playlist.set"; items: PlaylistItem[] }
  | { c: "start" } | { c: "next" } | { c: "pause" } | { c: "resume" } | { c: "endGame" } | { c: "forceAdvance" }
  | { c: "kick"; id: string; ban?: boolean } | { c: "promote"; id: string; role: "moderator" | "player" | "audience" }
  | { c: "team.assign"; id: string; teamId: string | null } | { c: "revealCode"; on: boolean }
  | { c: "ambient"; mode: AmbientMode } | { c: "transferHost"; id: string }
  | { c: "raffle"; n: number } | { c: "bench"; ids: string[] }       // seat raffle (§3.3); hand-pick participants for the next game (§3.4)
  | { c: "fillBots"; on: boolean };                                   // practice: fill empty seats up to minPlayers with bots
export type ModCommand =
  | { c: "approve"; itemId: string } | { c: "reject"; itemId: string }
  | { c: "mute"; id: string; minutes: number } | { c: "rename"; id: string; name: string };

export type S2C =
  | { t: "welcome"; v: 1; token: string; you: Me; room: RoomSnapshot; serverNow: number }
  | { t: "room"; seq: number; room: RoomSnapshot }                         // members, playlist, scoreboard, config (public parts)
  | { t: "view"; seq: number; game: GameId; full: unknown }
  | { t: "patch"; seq: number; ops: PatchOp[] }                            // if patch > 60% of full size, server sends full
  | { t: "fx"; events: { name: string; data?: unknown }[] }
  | { t: "poll"; poll: PublicPoll }                                        // PollSpec minus `accept`
  | { t: "tally"; pollId: string; tallies: Record<string, number>; total: number }  // ≤ 4 Hz
  | { t: "pollEnd"; pollId: string; result: PublicPollResult; you?: { correct?: boolean; points?: number; seeds?: number } }
  | { t: "reactions"; counts: Partial<Record<ReactionId, number>> }        // every 500 ms
  | { t: "modq"; items: ModItem[] }                                        // host + moderators only
  | { t: "ack"; id: number; ok: boolean; err?: string }
  | { t: "error"; code: ErrorCode; msg: string }
  | { t: "pong"; ts: number; serverNow: number };
export type PatchOp = { op: "set"; path: (string | number)[]; value: unknown } | { op: "del"; path: (string | number)[] };
export type ErrorCode = "BAD_CODE" | "ROOM_FULL" | "BANNED" | "BAD_PASSWORD" | "RATE_LIMIT" | "ILLEGAL" | "VERSION" | "NOT_ALLOWED" | "MUTED";
```

Binary frames (Marble Rally), little-endian. Byte 0 is the frame type:
- `0x01` **race snapshot** on the stage topic at 10 Hz:
  - `u8 type, u16 seq, u32 raceMs, u16 count`, then per marble `u16 id, i16 x, i16 y`.
  - **Quantization:** `x`/`y` = the solver's fixed-point position (1/16 world unit) **divided by 32**, i.e. 2 world units per step. The 4096×8192 world therefore spans 0–2048 × 0–4096 and fits `i16` (the earlier "1/16 unit in i16" wording overflowed at 32,767 and is void).
  - The server sends only marbles whose quantized position changed by 1 step or more.
  - Every 2 s it sends a full keyframe, marked by the top bit of `count` (so `count` ≤ 32,767).
- `0x02` **ranking**, **stage topic only**, at 2 Hz: `u8 type, u16 seq, u16 n, u16 ids[n]`, in current race order (the stage needs the full order to choose which marbles to render as meshes vs dots).
- `0x03` **your rank**, sent per enrolled socket via the `streamEach` effect at 1 Hz: `u8 type, u16 rank, u16 n, u8 checkpoint, u8 flags` (7 bytes; flags bit0 = DNF, bit1 = finished). Audience phones never receive the 1 KB full ranking: at 5,000 viewers × 2 Hz that alone would be ~10 MB/s of egress, versus ~35 KB/s for `0x03`. The audience top-10 comes in the JSON view.

The client detects a `seq` gap, sends `resync`, and receives a full view.

### 9.7 Security & moderation (must-haves)

- The server decides every outcome and does every roll and shuffle with a seeded RNG. The session decides roles; a client message never can. First-to-answer order uses server receive time only.
- Hidden information never leaves the server (§9.3 rule 4, plus the contract fuzz test).
- **Profanity filter:** `obscenity` with the English dataset plus our blocklist. It runs on names, answers, guesses, prompts and clues.
  - **Family mode** masks matches (`****`), and a player can resubmit their own text.
  - **Standard mode** flags and blurs on the Stage until the host clicks to reveal.
- **`reveal-review` moderation:** user-generated text or drawings go to the queue. The Stage shows a blurred card with "awaiting host" until the host or a moderator approves **in the host panel pop-out or on a moderator device** (never in the captured Stage window). The Doodle audience gallery is off by default.
- **Review-wait timeout:** if an item is still pending after 20 s, the game proceeds as if it were rejected (safety replacement / "drawing hidden"), so an absent moderator can never stall a stream.
- **Kick/ban** is keyed by token, a hash of the IP, and the Twitch id if present.
- **Overlay key:** a separate 96-bit key. Overlay sockets can only read.

---

## 10. Performance budgets (hard; CI-enforced where marked)

| Tier | Detection | DPR cap | Draw calls (CI) | Triangles (CI) | Shader programs (CI) | GPU textures | Ambient FPS | MSAA | Shadows |
|---|---|---|---|---|---|---|---|---|---|
| **low** | `hardwareConcurrency ≤ 4` OR `deviceMemory ≤ 4` OR boot bench median > 8 ms | 1.25 | **≤ 60** | **≤ 50k** | **≤ 10** | ≤ 24 MB | 30 | off | blob |
| **mid** | default | 1.5 | ≤ 100 | ≤ 100k | ≤ 12 | ≤ 48 MB | 30 | on | blob |
| **high** | desktop, ≥ 8 cores, bench < 3 ms, or `?obs=1` / Stage "pretty" | 2.0 | ≤ 150 | ≤ 150k | ≤ 14 | ≤ 64 MB | 60 | on | blob + one 1024² map, updated only when a piece moves |

- **Shared environment** (room, table, sky, weather, halos): at most **12 draw calls and 15k triangles on low**, so a game's own content gets **at most 48 draws and 35k triangles on low**.
- **Frame time:** p95 ≤ 33.3 ms on low tier with the CPU throttled 4× (on the GPU runner), and ≤ 16.7 ms on high on desktop. A still board renders **0 frames per second** when ambient is off.
- **Dynamic resolution:** scale between 0.5× and 1.0× of the DPR cap. Step down by 0.1 after one bad window (p90 > 1.15 × target) and up by 0.05 after three good windows, at most once per second. It is disabled in overlay and `?obs=1` mode, which run at a fixed 1080p60.
- **Render loop:** one loop owned by the platform, rendering on demand. When the tab is hidden, the loop stops, the AudioContext suspends, and the client sends `bg`.
- **Allocation:** zero allocations per frame, using scratch vectors and pools.
- **Materials:** the factories are the only source of materials. `onBeforeCompile` is allowed **only inside** `@sg/render/materials`. The renderer calls `renderer.compile()` during the Iris load.
- **Bundles** (gzip, measured by size-limit in CI):

  | Chunk | Budget |
  |---|---|
  | Stage shell (router, net, Preact, UI kit, three core, render kit, audio) — Stage and overlay `full` only | ≤ 180 KB |
  | Controller shell (router, net, Preact, UI kit, audio sfx subset) — player phones, **no three.js** | ≤ 70 KB |
  | Each game's `stage` chunk | ≤ 60 KB (Marble Rally ≤ 70 KB) |
  | Each game's `controller` chunk | ≤ 25 KB (Ludo/Chess 2D SVG board included) |
  | Audience lite route | ≤ 60 KB total, with **no three.js** |
  | Opt-in 3D board (three core + render kit, lazy) | loaded only on toggle; not counted in the phone first-load budget |

- **Load times** (Slow 4G, 4× CPU, cold cache):
  - lobby interactive in under 2.5 s (Stage)
  - phone join screen interactive in under 2.0 s after scanning the QR (controller shell), on a 6× CPU throttle
  - first game playable within 3 s of pressing Start
  - switching games with the shell already loaded in under 1.2 s
- **Server:** one vCPU holds 200 turn-based rooms of 8 players, or one room with a 5,000-member audience plus Marble Rally at 500 marbles. For the vote-to-tally path, p99 action→view latency must be ≤ 50 ms at the server (measured by the bot swarm).
- **Egress budget** (measured by the bot swarm, M1-10 and M10-10): a 5,000-member audience room averages ≤ 1.5 MB/s outbound during Marble Rally races and ≤ 300 KB/s during turn-based games. Tallies are coalesced to ≤ 4 Hz per poll, and the shared audience view is one pre-serialized buffer per step.
- **Phones:** the player controller and audience lite never load three.js by default. A controller must hold 60 fps scrolling/tapping on a 2019 Android phone (Moto G7 class, emulated as 412×915 with 6× CPU throttle in the gpu project) and must not keep a rAF loop running while idle.

---

## 11. Game-specific stage surfaces (the same table, a different mat)

| Game | Mat on the table | Hero props |
|---|---|---|
| quip-clash | Cork board, with an open-mic "mini stage" at the back of the table | Two paper answer cards on wooden stands, heart jars for votes, a tiny spotlight |
| tune-in | Felt | Vintage radio dial (half disc), a wooden shutter, fireflies showing the audience heatmap |
| trivia-night | Cork board | Index-card question, 4 coloured books as answer tiles, a candle timer, a kettle for the Showdown |
| doodle | Paper sketchbook on a small easel | Pencil and eraser props; the drawing is a `CanvasTexture` on the paper |
| odd-one-out | Felt | Lantern centrepiece ("campfire"), plush animal figures around the table, clue words as rising paper lanterns |
| ludo | Painted wood board (garden theme) | Lathe pawns (felt-gnome style), a chunky wooden die |
| chess | Two-tone wood inlay | Clay-matcap pieces, a capture tray, a flip-dial clock, a teapot prop |
| marble-rally | Upright wooden pegboard marble run leaning against the window (2D physics, shown in 3D) | Glass marbles in one `InstancedMesh`, pencil ramps, paper-cup funnels, a finish flag |

---

## 12. Content packs (`content/packs/<kind>/<id>.json`)

The server reads packs; clients never receive a whole pack.

```ts
export type PackKind = "quip-prompts" | "trivia-mc" | "trivia-bluff" | "spectrum" | "doodle-words" | "ooo-categories" | "ooo-pairs";
export interface Pack<T> { id: string; kind: PackKind; name: string; lang: "en"; rating: "all" | "teen"; version: number; items: T[] }
// item shapes are defined per game spec. Host custom packs: paste newline list or upload JSON/CSV (validated with zod, ≤ 2,000 items, filtered).
```

Minimum launch content: every item is original, and every trivia item carries `source` and `validUntil?`.

| Pack kind | Minimum items at launch |
|---|---|
| quip-prompts | 400 rated "all" plus 150 rated "teen" |
| trivia-mc | **960** (8 categories × 3 difficulties × 40), every item fact-checked (see M4-02) |
| trivia-bluff | 200 |
| spectrum | 200 cards |
| doodle-words | 1,200 default (easy/med/hard) plus 300 kids |
| ooo-categories | 30 categories × 12 secrets |
| ooo-pairs | 150 Undercover pairs |

Quality beats quantity: 960 verified trivia items is ~80 games of 12 questions with no repeats per session, which is plenty for v1, while 1,500 agent-written items with URL "sources" is a factual-error liability on stream. Every writing pack also passes a **quality sample gate** (G11): a fresh reviewer agent rates a random 5% sample (min 20 items) for clarity, originality and (for prompts) comedic potential on a 1–5 scale; mean ≥ 3.8 and no item ≤ 2, or the batch is revised.

---

## 13. Art tokens summary ("Cozy Table")

The source is `docs/research/03-art-direction.md`, implemented in `@sg/ui/tokens.ts` and `@sg/render/ambient/modes.ts`. **No colour, radius, duration or easing literal may appear in game code.**

### 13.1 Principles (tie-breakers)
1. **Soft, not flat.** Nothing pure `#000` or `#FFF`, and shadows are tinted.
2. **Toy-real.** Everything is painted wood, felt, clay or paper, with chunky bevels.
3. **Readable on a 720p stream.** Critical text is at least 22 px at 1080p.
4. **Calm world, lively moments.** Ambient loops last 4–14 s; events last 120–400 ms.

### 13.2 Ambient mode tokens

| token | day | dusk (Golden Hour, default) | night | rain | snow |
|---|---|---|---|---|---|
| sky-top | #9FD3F2 | #F6A58B | #1C2140 | #7D8FA6 | #C9D8EC |
| sky-bottom | #FDEBD3 | #FFE1A8 | #3D3A6B | #B8C3CF | #F4F1F6 |
| hemi-sky / ground | #DDEEFF / #E9C9A3 | #FFD2B0 / #B7797A | #5A5F9E / #2A2338 | #B9C8D8 / #6D6470 | #E6EEFA / #C7B3B8 |
| key (intensity) | #FFF4E0 (2.2) | #FFC98A (2.6, 18° low) | #FFC98A lamp (2.4, upper-right) | #E8EEF5 (1.3) | #F7F3FF (1.8) |
| fill-i | 1.1 | 0.8 | 0.45 | 1.0 | 1.2 |
| fog | #F6E7D6 | #F4C9A6 | #262544 | #A9B3BF | #E9ECF4 |
| wall / wood / felt | #F3E6D3 / #C98E5B / #5FA89A | #F0D2B6 / #B87445 / #4F9488 | #3A3553 / #8A5A3E / #3D7A74 | #D8D6DA / #A57A5C / #56908C | #EFE9EE / #B7835F / #5E9A96 |
| shadow | #6B4F6E @28% | #7A3F5C @32% | #120E24 @45% | #3A3F55 @34% | #56507A @26% |
| glow | #FFE7B0 (0.1) | #FFC26B (0.5) | #FFB45E (1.0) | #FFD08F (0.7) | #FFD9A0 (0.6) |
| ui-bg | #FFF8EF | #FFF3E4 | #1F1D33 | #F2F1F4 | #FAF8FC |
| ui-surface | #FFFFFF @86% | #FFF9F1 @88% | #2C2946 @88% | #FFFFFF @84% | #FFFFFF @88% |
| ui-ink / muted | #3B2F3A / #8A7A86 | #3D2A33 / #8F7078 | #F5EDE3 / #A89EBC | #2F3342 / #7B8093 | #34324A / #8886A0 |
| ui-line | #EADBC8 | #F0D3B8 | #403B5E | #D9DBE3 | #E2DEEA |
| accent | #FF8A65 | #F2705A | #FFB36B | #6FA8DC | #E77FA0 |

`ui-surface` pure white is allowed only because it is translucent over the scene.

### 13.3 Identity colours (fixed in every mode, always paired with a glyph)
- P1 Tomato `#F26B5B` / deep `#B8382C`, circle
- P2 Sky `#5BA8F2` / `#2A6DB3`, triangle
- P3 Sunflower `#F5C04A` / `#A87A10`, square
- P4 Mint `#5CC79A` / `#23845C`, diamond
- P5 Lilac `#A98BE8` / `#6A4DB8`, star
- P6 Peach `#FF9F6E` / `#C0602F`, plus
- P7 Teal `#3FB8C4` / `#1D7782`, pentagon
- P8 Rose `#EE86B9` / `#B0457C`, heart

Semantic colours:
- success `#6CC08B`
- warning `#F5B94A`
- danger `#EC6A6A`
- info `#6FA8DC`
- **audience `#B58AF0`** (reserved)

Each has ink variants as in research 03 §2.4.

Game-specific fixed tokens:
- `chess-light` `#F1E6D2` and `chess-dark` `#7FA88E` (the chess piece tints)
- `paper` `#FBF5EA` (Doodle paper and eraser)
- `glass` `#DDEBF2` (the Marble Rally glass tint, mixed with the identity colour)

### 13.4 Type, shape and motion
- **Fonts:**
  - Fredoka 500–700 for display
  - Nunito 500–800 for UI, with `tabular-nums` for numbers
  - Caveat 600 as an accent, at most once per screen
- **Type scale:** hero `clamp(2.5rem,6vw,4.5rem)`, h1 2rem, h2 1.5rem, body 1rem, label 0.875rem, small 0.75rem. Small is never used for gameplay information.
- **Shape:**
  - Radius: sm 10, md 16, lg 24, xl 32, pill.
  - Spacing on a 4-pt grid: 4, 8, 12, 16, 24, 32, 48.
  - Buttons are 48 px tall with a 3 px darker base border.
- **Easing:**
  - out-soft `cubic-bezier(.22,1,.36,1)` 240 ms
  - in-soft `(.55,0,.78,.4)` 160 ms
  - inout `(.65,0,.35,1)` 400–700 ms
  - back `(.34,1.56,.64,1)` 320 ms
- **Springs** (stiffness/damping): snappy 520/34, bouncy 380/18, gentle 170/26, wobbly 240/12, camera 120/22.
- **Camera states:**
  - establishing: 35° elevation, 35° FOV
  - play: about 55° elevation, 30° FOV
  - focus: 15–25% closer, 28° FOV
  - top: 88° elevation, 20° FOV

  The camera always glides and never cuts during play. Idle drift is ±1.5° yaw on a 14 s loop. Portrait uses 65° elevation. Stream Layout is applied with `setViewOffset`.

### 13.5 Lighting and materials
- **Renderer:** WebGL2 `WebGLRenderer`, `alpha:false`, `powerPreference:"default"`, `NeutralToneMapping` at exposure 1.0, sRGB output.
- **Lights:** only two: a Hemisphere light and one Directional key light from the upper-left (the night lamp comes from the upper-right). Lamps and string lights are faked with emissive colour plus additive halos.
- **Materials:** Toon with a 3-step ramp `[140,205,255]` for pieces, Matcap (a procedural clay matcap, warm and cool variants blended per mode) for chess and clay objects, Lambert with vertex-colour AO for the room and table, and Basic for sky, halos, confetti and shadows. Pieces get a rim "toy glow" of `pow(1-N·V,3)*0.35` on mid and high.
- **Post effects:** none in WebGL. Vignette and grain are CSS layers over the canvas, and the grain is static on low tier.

### 13.6 Procedural assets
Everything below is generated at boot in under 150 ms on a Chromebook and cached in IndexedDB. **v1 ships no model files and no image files.**
- **Textures:** wood, felt, paper, cork, board art, card faces, dice atlas, blob shadow, matcaps, toon ramp and grain.
- **Geometry:** lathe, rounded-box and extrude shapes.

### 13.7 Audio
- **Synthesis:** all sounds are made in WebAudio and quantized to C major pentatonic. The core set is pop, tick, tok, card, chime, success, fail, capture, win and vote (audience).
- **Beds and music:** ambience beds for each mode and a generative lofi loop at 72–84 BPM.
- **Mixing:** the master chain goes through a 7 kHz lowpass and a gentle compressor. Music ducks 4 dB during reveals.
- **Stream safety:** the UI shows "Stream-safe audio ✓". Nothing is licensed, so there is nothing to strike.

---

## 14. Dev harness contract (summary; details in DOD.md)

- **Scenario route:** `/dev/scenario?game=&state=&mode=&seed=&quality=&vp=&role=&t=&freeze=1&hud=1`. It is available in dev and preview builds and is excluded from production builds.
  - The route calls `scenarios[state].build({seed, rng, role, …})` to get a state, runs `view(state, viewerKey(role))`, and mounts the stage (`role=stage|host`) or the controller (`role=player|audience`) **with no network**.
  - It then seeks `t`, freezes, and sets `window.__SCENE_READY__ = true` and `window.__SCENE_INFO__ = {drawCalls, tris, programs, textures, geometries}`.
- **Scenario API:**

  ```ts
  export interface ScenarioCtx { seed: number; rng: Rng; players: number; role: "stage"|"host"|"player"|"audience" }
  export interface Scenario<S> { id: string; description: string; build(ctx: ScenarioCtx): { state: S; viewer?: ViewerKey; fx?: {name:string;data?:unknown}[] }; anim?: { name: string; durationMs: number } }
  export type ScenarioRegistry<S> = Record<string, Scenario<S>>;
  ```
- **Status:** `progress.json` is the source of truth. `PROGRESS.md` is generated from it, and `tools/harness/progress.ts` enforces the status lifecycle `todo → building → verifying → critic → fixing → … → done`, with `blocked` reachable from any state.

---

## 15. Conflicts resolved (decision log)

| Topic | Research said | Decision |
|---|---|---|
| Node version | Node 22 (platform) | **Node 22 LTS ≥ 22.12** (installed locally, supported by uWS, Vite 8 and better-sqlite3). Node 24 is allowed but not required. |
| TypeScript | unspecified | **6.0.3 exact**. TS 7 (the native port) breaks typescript-eslint's peer range (< 6.1). |
| Renderer | WebGL vs WebGPU | **WebGLRenderer (WebGL2)**. A DOM/SVG fallback covers turn-based games if WebGL2 is missing. |
| Tone mapping | ACES (art) vs None (perf) | **NeutralToneMapping**: close to free per pixel and keeps identity hues accurate. The golden game (G1) tunes intensities. |
| Low-tier budget | 40 draws / 25k tris (art), 60 / 50k (perf), 150 / 80k (harness) | **60 / 50k is the hard CI gate**. 12 / 15k is reserved for the environment. The art doc's 40 / 25k is a *target* for games. |
| Game JS budget | 60 KB (perf) vs 120 KB (harness) | **Stage chunk 60 KB, controller chunk 25 KB**, Marble Rally stage 70 KB. |
| Textures | KTX2 (perf) vs procedural (art) | **Procedural canvas textures in v1.** No KTX2 or transcoder in the shell. |
| Post-processing | 1 pass on high (perf) vs CSS only (art) | **CSS only**, on every tier. |
| onBeforeCompile | avoid (perf) vs used for rim/tint (art) | Allowed **only inside `@sg/render/materials` factories**. |
| Ambient modes | 4 (platform) vs 5 (art) | **5** (`day, dusk, night, rain, snow`). Critic matrix uses the 4 core modes; snow gets a spot check. |
| Repo layout | `src/core…` (harness) vs pnpm packages (platform) | **pnpm packages** (§9.2). Harness paths are remapped in DOD.md. |
| Critic pass bar | avg ≥ 8, none < 6 (art) vs every item ≥ 8.5 (harness) | **Per group: mean ≥ 8.5, no item < 7.5, ★ hard-gate items ≥ 8.5.** Stricter for the style golden (★ ≥ 9). See DOD.md. |
| Marble physics | 3D sphere solver / Rapier (catalog) vs 2D custom (perf) | **Upright pegboard track with a custom 2D fixed-point deterministic solver on the server**, sending binary snapshots. It looks 3D and simulates in 2D. |
| Views | `overlay` view key | Renamed **`stage`**: the Stage and the overlay use the same safe view. |
| Host playing | host tab might show secrets | **The Stage never shows secrets.** A host who plays joins from a second device. |
| Stockfish eval bar | optional | **Cut from v1** (bundle size and CPU cost). |
| Audience-written prompts (Quip Clash) | suggested | **Cut from v1**, because it adds moderation load. |
| Moderation previews | host dock | **Host panel pop-out only.** The Stage window is always assumed captured; showing pending text in its dock would put unmoderated content on stream. |
| Phone 3D boards (Ludo, Chess) | 3D `requestBoard()` | **2D SVG by default**, 3D opt-in. Keeps three.js (~120 KB gz) off every phone and makes the M10-06 fallback the default path rather than a late extra. |
| Doodle audience | audience sees the word *and* guesses it (contradiction) | Audience **does not** see the word; it votes the difficulty tier and plays the guess poll. |
| Marble binary positions | "1/16 unit as i16" (overflows) | fixed/32 → 2-unit steps; full ranking to stage only; per-socket 7-byte rank frame for phones. |
| Next game | fixed playlist | **Audience votes the next game** by default (`playlistMode`). |
| Critic merge | per-item MIN of 2 critics | **★ items: min; other items: mean.** Pure-min merging of two noisy LLM critics over ~14 groups makes the bar statistically unreachable and pushes every game to `blocked`. |
| DOM UI framework | unspecified | **Preact + signals** (about 5 KB). React is banned. |
| Timers | runner scales timers | **`ctx.timing.input()` / `pace()`.** The game stores the actual deadline, so views stay correct. `timerScale 0` → `null` → the host advances. |
