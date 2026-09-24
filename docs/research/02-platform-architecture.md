# 02 — Platform Architecture

> Status: research / recommendation. Opinionated by design. Where I cite, the URL is inline.
> Scope: realtime server, room model, roles, the game module API, protocol, audience scaling, host customization, overlay, Twitch (optional), repo layout, testing.

## TL;DR (the decisions)

| Concern | Decision |
|---|---|
| Server runtime | **Node 22 LTS + TypeScript**, single process per "server" |
| Transport | **uWebSockets.js** behind a thin `Transport` interface; `ws` adapter as fallback (same interface) |
| Framework | **No Colyseus / PartyKit / Socket.IO.** Our own ~1.5k LOC room layer (rationale below) |
| Game model | **Server-authoritative, pure reducer** modules: `setup → onAction → tick → view(role)` |
| Sync | Per-role **view snapshots + JSON diff**, versioned (`seq`), full resync on gap |
| Wire format | JSON (debuggable, zero deps). MessagePack optional later behind the codec interface |
| Join | Jackbox-style **4-letter room codes**, no account needed |
| Audience | Topic pub/sub fan-out; audience inputs **aggregated server-side**, tallies broadcast at 4 Hz |
| Storage | In-memory by default; **SQLite (better-sqlite3 / node:sqlite)** optional for leaderboards |
| Overlay | `/overlay/:code?key=…` read-only view, transparent background, OBS Browser Source |
| Twitch | Optional plugin; anonymous IRC-over-WebSocket read for `!vote` style chat; no OAuth required for read |
| Repo | pnpm workspaces: `packages/shared`, `packages/engine`, `packages/games/*`, `apps/server`, `apps/client`, `tools/bots` |
| Testing | vitest on pure game reducers; seeded RNG; headless bot swarm (`tools/bots`) against a real server |

---

## 1. Realtime stack choice

### Options considered

| Option | Pros | Cons for *us* |
|---|---|---|
| **Colyseus** (MIT, v0.18 Aug 2026, [docs](https://docs.colyseus.io/), [repo](https://github.com/colyseus/colyseus)) | Mature rooms, matchmaking, reconnection, schema delta sync, uWS transport available ([uwebsockets-transport](https://github.com/pixels-online/uwebsockets-transport)) | State lives in mutable `@Schema` classes with decorators — fights our "game logic = pure functions" requirement and per-role hidden info (cards, secret words) becomes filter plumbing. Heavier client SDK. Its best features (prediction/lag compensation, Cloud) target action games we are *not* making. |
| **PartyKit / PartyServer** (Cloudflare Durable Objects) | Great edge fan-out, one object per room | Cloudflare-shaped; breaks "self-host with zero external services" and "separate servers" run by hosts on their own box. |
| **Socket.IO** | Rooms, reconnection, fallbacks | ~Heavier protocol, long-poll fallback we don't need, per-socket overhead; room broadcast is fine but uWS pub/sub is far cheaper at thousands of audience sockets. |
| **Raw `ws`** | Simple, pure JS | Higher memory/CPU per socket than uWS; no native topic pub/sub. |
| **uWebSockets.js + own room layer** | Lowest CPU/RAM per connection, native `publish(topic)` fan-out (ideal for audience), HTTP + WS on one port, trivial to self-host | We write rooms/reconnect/codes ourselves (small, well-understood problem for turn-based games) |

### Recommendation
**uWebSockets.js + our own room layer**, with a `Transport` interface so `ws` can be swapped in (e.g. for platforms where the uWS prebuilt binary is unavailable, or for tests). Our games are turn-based / light-realtime (≤20 Hz), our hard problems are *hidden-information views, audience aggregation, and a clean plugin API* — none of which a framework solves for us better than 1–2k lines of focused code. The 2026 consensus for browser multiplayer is "WebSockets + authoritative server, framework optional" ([Cinevva guide](https://app.cinevva.com/guides/multiplayer-browser-game)); we take the authoritative part and skip the framework lock-in.

Revisit trigger: if we ever add a genuinely twitchy action game needing client prediction, evaluate Colyseus 0.18 for *that game only* — the module API below does not preclude it.

---

## 2. Process & room model

```
            ┌───────────────────── apps/server (one Node process = one "server") ──────────────────┐
 players ──►│ Transport(uWS) ─► Session (auth token, role, roomCode) ─► RoomManager ─► Room         │
 audience ─►│                                                               │    ├─ Lobby/Playlist │
 overlay  ─►│                                                               │    ├─ GameRunner ◄── game module (pure)
 twitch  ──►│ TwitchBridge (optional) ─────────────────────────────────────►│    ├─ AudienceAggregator
            │ HTTP: /health /api/rooms /overlay assets                      │    └─ Scoreboard     │
            │ Store: MemoryStore | SqliteStore (leaderboards, room snapshots)                      │
            └──────────────────────────────────────────────────────────────────────────────────────┘
```

- **Room = single-threaded actor.** All inputs for a room go through one queue; the room's state is only mutated by the `GameRunner` applying a module's pure reducer. No locks, deterministic replay.
- **Capacity target per process** (low-end VPS, 1 vCPU): ~200 active rooms of 8 players, or a handful of rooms with 5k audience each. Turn-based rooms idle at ~0 CPU (no tick unless module asks).
- **Tick is opt-in.** `tickHz: 0` for turn-based (Chess, Ludo, drawing-guess rounds use timers instead). Light realtime games declare `tickHz` ≤ 20. Timers are scheduled events, not polling.
- **Horizontal scale (later):** rooms are sticky to a process; a tiny router maps `roomCode → process` (in-memory for single node; Redis only if/when multi-node). The room code prefix can encode the shard. Not needed for v1.

### "Separate servers" — three deployment modes, one binary
1. **Local / self-host**: `pnpm start` → server + static client on one port. Anyone on LAN or via tunnel joins. Zero external services.
2. **Private room** (on any server): room created with `visibility: "private"` — join by code only, optional password, optional "approve joins".
3. **Public room**: `visibility: "public"` — listed in `/api/rooms` lobby browser with game, player count, language, content rating.

A server config file (`server.config.json`) sets: max rooms, allowed games, default content filter, whether public listing is enabled, admin key. A streamer running their own server is simply mode 1 on a VPS.

---

## 3. Room codes & joining (Jackbox-style)

- **4 uppercase letters**, alphabet excluding ambiguous/offensive-prone letters: `BCDFGHJKLMNPQRSTVWXZ` (no vowels ⇒ no accidental words; 20⁴ = 160,000 codes — plenty per server). Check against a small blocklist anyway.
- Code is released 30 min after room ends; reused codes get a new `roomEpoch` so stale reconnect tokens fail.
- Join URL: `https://host/ABCD` (QR code shown on the host screen/overlay).
- **Streamer safety** (mirrors Jackbox's streamer features: hide room code, max players, password, Twitch-login requirement, moderation, extended timers — [Jackbox PP8 streaming features](https://www.jackboxgames.com/blog/streaming-moderation-accessibility-features-jackbox-party-pack-eight)):
  - "Hide code" toggle blurs the code on the overlay until host reveals it (stream sniping protection).
  - Max players; late join → audience automatically (Jackbox pattern of letting latecomers participate as audience, [Jackbox audience](https://www.jackboxgames.com/blog/how-audience-play-along-differs-in-each-jackbox-game)).
  - Optional password; optional "require Twitch login" (only when Twitch plugin configured).
  - Rate-limit join attempts per IP (code brute-force protection): 10/min.

---

## 4. Roles, teams, identity

```ts
type Role = "host" | "player" | "audience" | "moderator" | "overlay";
```

| Role | Can | Notes |
|---|---|---|
| **host** (broadcaster) | Everything: playlist, rules, start/skip/pause, kick/ban, promote, theme/ambient mode | Exactly one; host token transferable. Host may *also* be a player (`hostPlays: true`). |
| **moderator** | Kick/mute, approve/reject user content (drawings, answers, names), pause | Promoted by host. Content moderation queue (Jackbox has remote moderation — we mirror it). |
| **player** | Send game actions | Seat index, optional team. Cap per game module (`minPlayers/maxPlayers`). |
| **audience** | Vote / predict / react / "join next round" queue | Never receives hidden info beyond what's on stream. Inputs are *aggregated*, never individually applied. |
| **overlay** | Read-only, "on-stream" view | Auth via overlay key in URL (separate from host token so leaking the OBS URL doesn't give control). |

- **Identity**: anonymous by default. First join → server issues `sessionToken` (random 128-bit, stored in `localStorage` per room code) + display name + avatar. Optional Twitch login binds `twitchId` for bans/leaderboards across rooms.
- **Names**: profanity filter + length cap; moderators can force-rename.
- **Teams**: room-level concept, not per game. `teams: { id, name, color, memberIds }[]`. Modes: `none | host-assigned | auto-balance | self-pick`. Games declare `teamSupport: "none" | "optional" | "required"`. Audience can be split into teams too ("Chat Red vs Chat Blue") — their votes aggregate into team tallies.

---

## 5. The game module API (core of the platform)

Every game is a self-contained package `packages/games/<id>` exporting a **pure logic module** (runs on server *and* in tests) and a **client view module** (three.js/DOM, runs in browser). Logic never imports three.js; client view never mutates state.

### 5.1 Logic module interface

```ts
// packages/engine/src/game-module.ts
import type { Rng, PlayerId, TeamId, Role } from "@sg/shared";

export interface GameManifest {
  id: string;                    // "ludo", "chess", "draw-guess"
  name: string;
  version: string;               // semver; replays/snapshots store it
  minPlayers: number;
  maxPlayers: number;
  teamSupport: "none" | "optional" | "required";
  audience: AudienceSupport;     // what audience can do in this game
  tickHz: 0 | 5 | 10 | 20;       // 0 = event/timer driven only
  estMinutes: [number, number];  // shown in playlist UI
  tags: string[];                // "board", "drawing", "trivia", "social-deduction"
  contentRating: "all" | "teen";
}

export interface AudienceSupport {
  vote?: boolean;        // choose among options the game presents
  predict?: boolean;     // bet points on an outcome
  react?: boolean;       // emoji reactions (always cosmetic)
  joinQueue?: boolean;   // can be pulled in as player between rounds
}

/** Options schema drives the host customization UI automatically. */
export type OptionSpec =
  | { kind: "int"; key: string; label: string; min: number; max: number; step?: number; default: number }
  | { kind: "bool"; key: string; label: string; default: boolean }
  | { kind: "enum"; key: string; label: string; choices: { value: string; label: string }[]; default: string }
  | { kind: "seconds"; key: string; label: string; min: number; max: number; default: number } // timers
  | { kind: "wordpack"; key: string; label: string; default: string };

export interface SetupContext<O> {
  players: { id: PlayerId; name: string; teamId?: TeamId; seat: number }[];
  teams: { id: TeamId; name: string }[];
  options: O;                    // validated against optionSpecs
  rng: Rng;                      // seeded; the ONLY source of randomness
  now: number;                   // injected clock (ms)
}

export interface ActionContext {
  rng: Rng;
  now: number;
  actor: { id: PlayerId; role: Role; teamId?: TeamId };
}

/** Result of every reducer call. Pure: returns new state + side-effect requests. */
export interface Step<S> {
  state: S;
  effects?: Effect[];
}

export type Effect =
  | { type: "timer.set"; id: string; atMs: number }        // runner calls onTimer(id) later
  | { type: "timer.clear"; id: string }
  | { type: "audience.openPoll"; pollId: string; options: { id: string; label: string }[]; closesAtMs: number; kind: "vote" | "predict" }
  | { type: "audience.closePoll"; pollId: string }
  | { type: "score"; deltas: Record<PlayerId | TeamId, number> }  // feeds room scoreboard/leaderboards
  | { type: "event"; name: string; data?: unknown }                // cosmetic: sfx, confetti, camera cue
  | { type: "moderate"; itemId: string; kind: "text" | "drawing"; ownerId: PlayerId } // enqueue for mods
  | { type: "end"; result: GameResult };

export interface GameResult {
  ranking: { id: PlayerId | TeamId; score: number; place: number }[];
  highlights?: { label: string; playerId?: PlayerId }[]; // "Best Drawing", "MVP"
}

export type ViewerKey =
  | { role: "player"; id: PlayerId }
  | { role: "audience" }           // one shared view for ALL audience -> cheap fan-out
  | { role: "overlay" }            // what is safe to show on stream
  | { role: "host" }
  | { role: "moderator" };

export interface GameModule<S, A, O = Record<string, unknown>, V = unknown> {
  manifest: GameManifest;
  optionSpecs: OptionSpec[];
  /** Validate & parse untrusted client payload. Return null => rejected. (zod/valibot or hand-rolled) */
  parseAction(raw: unknown): A | null;

  setup(ctx: SetupContext<O>): Step<S>;
  /** Must reject illegal moves by returning { state } unchanged + optional "event" error. Never throws for bad input. */
  onAction(state: S, action: A, ctx: ActionContext): Step<S>;
  onTimer?(state: S, timerId: string, ctx: Omit<ActionContext, "actor">): Step<S>;
  onTick?(state: S, dtMs: number, ctx: Omit<ActionContext, "actor">): Step<S>;
  /** Aggregated audience result delivered when a poll closes (never individual votes). */
  onAudienceResult?(state: S, result: PollResult, ctx: Omit<ActionContext, "actor">): Step<S>;
  onPlayerLeave?(state: S, id: PlayerId, ctx: Omit<ActionContext, "actor">): Step<S>;  // skip turn / bot takeover
  onPlayerRejoin?(state: S, id: PlayerId, ctx: Omit<ActionContext, "actor">): Step<S>;

  /** Projection per viewer. MUST strip hidden info (hands, secret words, other players' answers). */
  view(state: S, viewer: ViewerKey): V;

  /** Legal action hints for UI + bots (optional but required for bot support). */
  legalActions?(state: S, player: PlayerId): A[];

  serialize(state: S): string;        // for snapshots/crash recovery/replays
  deserialize(data: string): S;
}

export interface PollResult {
  pollId: string;
  kind: "vote" | "predict";
  tallies: Record<string, number>;    // optionId -> count (or weighted points)
  total: number;
  byTeam?: Record<TeamId, Record<string, number>>;
}
```

**Rules for module authors (enforced by lint + tests):**
1. No `Math.random`, `Date.now`, I/O, globals — only `ctx.rng` / `ctx.now`. Ensures deterministic replay and vitest-friendly logic.
2. State is plain JSON-serializable data (no classes, Maps → records). Treat immutable (use structural sharing or `structuredClone` in dev-mode guard).
3. `view()` is the security boundary. A contract test in `packages/engine/testing` fuzzes random games and asserts no `view(player X)` contains fields tagged secret for player Y.
4. Timers expressed as effects → host "extended timers ×1.5/×2 / no timer" is applied by the runner uniformly (accessibility, like Jackbox extended timers).

### 5.2 Client view module interface

```ts
// packages/engine/src/client-module.ts
export interface GameClientModule<V, A> {
  id: string;
  /** Lazy-loaded chunk: import(`@sg/game-${id}/client`) — keeps initial bundle small */
  mount(ctx: ClientMountContext<A>): GameClientInstance<V>;
}

export interface ClientMountContext<A> {
  scene: import("three").Scene;         // shared cozy scene provided by the shell
  camera: import("three").PerspectiveCamera;
  ui: HTMLElement;                      // DOM layer for text/buttons (crisp, accessible, cheap)
  theme: ThemeTokens;                   // palette + ambient mode (day/dusk/night/rain)
  quality: "low" | "med" | "high";      // device tier from shell's perf probe
  role: "player" | "audience" | "overlay" | "host" | "moderator";
  send(action: A): void;                // fire action to server (optimistic UI optional)
  sfx(name: string): void;
  assets: AssetLoader;                  // shared cache (KTX2/basis textures, glTF, shared materials)
}

export interface GameClientInstance<V> {
  update(view: V, prev: V | null): void; // called on every new view (diff-driven animations)
  onEvent?(e: { name: string; data?: unknown }): void; // confetti, camera cues
  frame?(dtMs: number): void;             // render loop hook (shell owns the loop)
  resize?(w: number, h: number): void;
  dispose(): void;                        // MUST free geometries/materials/textures
}
```

The shell (apps/client) owns renderer, render loop (with frame-skipping when idle/tab hidden), ambient modes, transitions between games, and the DOM UI kit. Games only add objects to a provided scene — this is how we keep **one consistent visual style**.

### 5.3 Registration

```ts
// packages/games/ludo/src/index.ts
export const logic: GameModule<LudoState, LudoAction, LudoOptions, LudoView> = { ... };
// packages/games/ludo/src/client.ts
export const client: GameClientModule<LudoView, LudoAction> = { ... };
```
`apps/server/src/games.ts` imports an explicit list of logic modules (curated catalog — see game-selection doc); the client builds a lazy import map from the same list. Adding a game = new package + one line in each registry.

---

## 6. Network protocol

One WebSocket per client at `wss://host/ws`. JSON messages, discriminated by `t`. Every server→client state message carries a monotonically increasing `seq` per (room, viewerKey).

```ts
// packages/shared/src/protocol.ts
export const PROTOCOL_VERSION = 1;

// ---------- Client -> Server ----------
export type C2S =
  | { t: "hello"; v: number; token?: string; code: string; name?: string; want: "player" | "audience" | "overlay"; overlayKey?: string; password?: string }
  | { t: "create"; v: number; name: string; config?: Partial<RoomConfig> }                       // becomes host
  | { t: "act"; id: number; a: unknown }                                                        // game action; id for ack
  | { t: "vote"; pollId: string; option: string; weight?: number }                              // audience/predict
  | { t: "react"; emoji: string }                                                               // throttled, aggregated
  | { t: "host"; cmd: HostCommand }
  | { t: "mod"; cmd: ModCommand }
  | { t: "resync"; lastSeq: number }
  | { t: "ping"; ts: number };

export type HostCommand =
  | { c: "config"; patch: Partial<RoomConfig> }
  | { c: "playlist.set"; items: PlaylistItem[] }
  | { c: "start" } | { c: "next" } | { c: "pause" } | { c: "resume" } | { c: "endGame" }
  | { c: "kick"; id: string; ban?: boolean }
  | { c: "promote"; id: string; role: "moderator" | "player" | "audience" }
  | { c: "team.assign"; id: string; teamId: string | null }
  | { c: "revealCode"; on: boolean }
  | { c: "ambient"; mode: "day" | "dusk" | "night" | "rain" }
  | { c: "transferHost"; id: string };

export type ModCommand =
  | { c: "approve"; itemId: string } | { c: "reject"; itemId: string }
  | { c: "mute"; id: string; minutes: number } | { c: "rename"; id: string; name: string };

// ---------- Server -> Client ----------
export type S2C =
  | { t: "welcome"; v: number; token: string; you: { id: string; role: Role; name: string; teamId?: string }; room: RoomSnapshot }
  | { t: "room"; seq: number; room: RoomSnapshot }                     // lobby/playlist/members/scoreboard
  | { t: "view"; seq: number; game: string; full: unknown }            // full view (on join/resync/game start)
  | { t: "patch"; seq: number; ops: JsonPatchOp[] }                    // diff vs previous view
  | { t: "fx"; events: { name: string; data?: unknown }[] }            // cosmetic effects
  | { t: "poll"; pollId: string; kind: "vote" | "predict"; options: { id: string; label: string }[]; closesAt: number }
  | { t: "tally"; pollId: string; tallies: Record<string, number>; total: number } // throttled 4 Hz
  | { t: "reactions"; counts: Record<string, number> }                // aggregated every 500 ms
  | { t: "ack"; id: number; ok: boolean; err?: string }
  | { t: "error"; code: ErrorCode; msg: string }
  | { t: "pong"; ts: number; serverNow: number };                     // clock sync for timers

export type JsonPatchOp =
  | { op: "set"; path: (string | number)[]; value: unknown }
  | { op: "del"; path: (string | number)[] };

export type ErrorCode = "BAD_CODE" | "ROOM_FULL" | "BANNED" | "BAD_PASSWORD" | "RATE_LIMIT" | "ILLEGAL" | "VERSION" | "NOT_ALLOWED";
```

### Sync strategy
- After each reducer step, the runner recomputes `view()` only for **distinct viewer keys** (N players + 1 audience + 1 overlay + host + mods). Audience of 5,000 costs one `view()` call and one serialized buffer.
- Diff previous vs new view (small structural differ in `packages/shared`); if patch JSON > 60% of full size, send `full`. Views are small (Ludo/Chess < 2 KB) so this is cheap.
- Client detects `seq` gap → sends `resync` → server replies `view full`. No complex reliability layer needed (TCP is ordered; gaps only happen across reconnects).
- Timers: server sends absolute `closesAt` in server time; clients correct with `pong.serverNow` offset. No per-second countdown messages.
- Light realtime games (tickHz 10–20): same pipeline; client interpolates between views. Keep entities few.

---

## 7. Reconnection

- `sessionToken` in `localStorage` keyed by room code → on reload, `hello{token}` restores identity, role, seat, team, score.
- Player disconnect: seat held for `reconnectGraceSec` (default 60; host-configurable). Module's `onPlayerLeave` decides: pause turn timer, auto-skip, or **bot takeover** using `legalActions` (Ludo/Chess keep moving — critical on stream; nobody waits for a phone that died).
- Client auto-reconnects with exponential backoff (0.5s → 8s, jitter) and shows a soft "reconnecting…" pill, not a modal.
- Heartbeat: uWS `idleTimeout: 30s` + app ping every 10s (mobile browsers kill background sockets; phones locking is the #1 disconnect cause in party games).
- **Server crash/restart**: every room snapshot (`serialize` + room meta) is written to the store every N actions / 10 s. MemoryStore loses it (fine for dev); SqliteStore restores rooms on boot so a stream can survive a redeploy.

---

## 8. Audience at scale (hundreds → thousands)

Jackbox supports up to 10,000 audience members per room ([Jackboxpedia: Audience](https://jackbox.wiki/wiki/Audience), [GamerHorizon](https://gamerhorizon.blog/how-many-people-can-play-jackbox-games)) — that's our bar.

- **Fan-out via uWS topics**: each room has topics `r:ABCD:aud`, `r:ABCD:ovl`. One `publish()` sends the same pre-serialized buffer to all subscribers in native code — no JS loop over sockets.
- **Aggregation, never individual application**: votes go into `AudienceAggregator` (`Map<pollId, Map<voterId, option>>` for one-vote-per-person + change-your-vote), tallies broadcast at most **4 Hz**, reactions summed and flushed every **500 ms**. The game only sees `onAudienceResult` when the poll closes.
- **Input throttling**: audience socket rate limit (e.g. 5 msgs/s token bucket, drop excess silently); reactions capped per user per window.
- **Lightweight audience client**: audience view uses the DOM-only "lite" mode by default (no three.js scene load on phones in a 5k audience) with optional "show board" toggle.
- **Predictions**: audience members get a room-local point balance ("seeds"), bet on outcomes; leaderboard of top predictors — high engagement, zero impact on fairness.
- **Weighted team votes**: "Chat decides" moments: tally → percentage → game converts to one move. Players are never overridden by a single viewer.
- Single-process ceiling: with uWS a single process comfortably holds tens of thousands of idle sockets; the bottleneck is per-message JSON parse of votes — mitigated by 4 Hz batching and short vote payloads.

---

## 9. Leaderboards & scoring

- **Room scoreboard** (session-long across the playlist): sum of `score` effects, normalized per game (each game's `GameResult.ranking` maps to placement points, e.g. 10/7/5/3/1) so a 40-minute Chess game doesn't dwarf a 3-minute round. Host can toggle "raw" vs "placement" scoring.
- **Team scoreboard** same mechanism.
- **Audience predictor leaderboard** per room.
- **Global/server leaderboards** (optional, SqliteStore only): only for identified users (Twitch-linked) to avoid anonymous farming; per game Elo/Glicko for 1v1 (Chess), wins/placement for party games; weekly reset view.

```ts
export interface Store {
  saveRoomSnapshot(code: string, snap: string): Promise<void>;
  loadRoomSnapshots(): Promise<{ code: string; snap: string }[]>;
  recordResult(r: { gameId: string; roomCode: string; at: number; ranking: GameResult["ranking"]; identities: Record<string, string /*twitchId*/> }): Promise<void>;
  topPlayers(gameId: string | "all", period: "week" | "all", limit: number): Promise<{ name: string; score: number }[]>;
}
// impls: MemoryStore (default), SqliteStore (node:sqlite or better-sqlite3; single file, zero config)
```

---

## 10. Host customization

```ts
export interface RoomConfig {
  visibility: "private" | "public";
  password?: string;
  maxPlayers: number;
  maxAudience: number;           // default 10_000
  lateJoin: "audience" | "queue" | "deny";
  requireTwitch: boolean;
  contentFilter: "family" | "standard";
  hideCode: boolean;
  timerScale: 0 | 1 | 1.5 | 2;   // 0 = no timers (where module supports)
  reconnectGraceSec: number;
  teams: { mode: "none" | "host" | "auto" | "self"; count: 2 | 3 | 4 };
  scoring: "placement" | "raw";
  theme: { ambient: "day" | "dusk" | "night" | "rain"; accent?: string; autoCycle?: boolean };
  audio: { music: number; sfx: number };
  playlist: PlaylistItem[];
}

export interface PlaylistItem {
  gameId: string;
  options: Record<string, unknown>;  // validated against module optionSpecs
  rounds?: number;
  label?: string;                    // "Warm-up", "Finale"
}
```
- Host UI auto-generates settings forms from `optionSpecs`. Presets ("Quick 20-min stream set", "Family night") are saved to `localStorage` and exportable as JSON (shareable preset codes).
- Playlist flow: lobby → game intro card (rules in ≤3 bullets, skip-able) → game → results → scoreboard interstitial → next. Host can reorder/skip live.
- Host "stream deck": big buttons for Start / Next / Pause / Reveal code / Ambient mode; keyboard shortcuts.

---

## 11. Stream overlay (OBS Browser Source)

- URL: `https://host/overlay/ABCD?key=<overlayKey>&layout=full|corner|scoreboard|poll`.
- Transparent background (`body{background:transparent}` in overlay mode), 1920×1080 design canvas, scales to source size.
- Shows only `view(state, {role:"overlay"})` — safe to broadcast (never hands/secrets), room code respecting `hideCode`, QR join code, live audience tallies, reactions rain, scoreboard.
- Layouts are separate so streamers can add e.g. a "poll" source over their camera and a "scoreboard" source elsewhere.
- Rendering budget: overlay must run at 60 fps in OBS's CEF alongside a game capture — use `quality: "med"`, cap pixel ratio 1, pause render when nothing animates.
- Host can also just screen-capture the host tab; overlay is the polished option.

---

## 12. Twitch integration (strictly optional)

- Implemented as a server plugin `apps/server/src/plugins/twitch.ts`, disabled unless `TWITCH_CHANNEL` configured. Platform works 100% without it.
- **Read chat anonymously** over IRC-WebSocket `wss://irc-ws.chat.twitch.tv` with a `justinfanNNNN` nick — no OAuth, no app registration ([dank-twitch-irc](https://github.com/robotty/dank-twitch-irc), [Twitch IRC concepts](https://dev.twitch.tv/docs/chat/irc/)). Chat `!1`, `!2`, `!vote red` map into the same `AudienceAggregator` (voterId = `tw:<userId>`), so chat and web-audience votes merge in one tally.
- **Authenticated features** (optional, later): Twitch login for `requireTwitch` / bans / global leaderboards via OAuth; EventSub for channel points or sending chat — Twitch recommends EventSub for chat bots now ([IRC migration guide](https://dev.twitch.tv/docs/chat/irc-migration/)) but EventSub has no anonymous mode ([Twitch forum](https://discuss.dev.twitch.com/t/i-want-to-use-eventsub-for-3rd-party-chat-client-but-does-it-support-anonymous-users/59801)), so anonymous IRC stays the zero-config default.
- A Twitch Extension (like Jackbox Audience Kit, [support article](https://support.jackboxgames.com/hc/en-us/articles/15794775761047-How-do-I-use-the-Audience-Kit-extension-for-Twitch)) is a v2+ idea; not in scope.
- Keep the plugin interface generic (`ChatSource`) so YouTube/Kick can be added later.

---

## 13. Anti-cheat & abuse (basics that matter for party games)

1. **Authoritative server**: clients send intents; module validates against state (`parseAction` + legality in `onAction`). Dice/shuffles use server seeded RNG only.
2. **Hidden info never leaves the server** except to its owner (`view()` projection + contract tests).
3. **Rate limits**: per-socket token bucket (players 20 msg/s, audience 5 msg/s), per-IP connection cap (e.g. 20), join-attempt limit for code brute force.
4. **Message size cap** (uWS `maxPayloadLength` 16 KB; drawings streamed as simplified stroke arrays, capped points).
5. **One vote per identity per poll**; audience sockets per IP limited (soft) to damp vote-stuffing; Twitch-linked votes can be weighted/required by host.
6. **Content**: profanity filter on names/text answers (word list, family mode), moderation queue for user content shown on stream, host/mod kick/ban (ban by token + IP hash + twitchId).
7. **Timing**: server timestamps decide "first to answer"; client timestamps ignored.
8. **No trust in client role**: role comes from server session, never from message.

---

## 14. Monorepo layout (pnpm workspaces)

```
streamer-games-online/
├─ pnpm-workspace.yaml          # packages/*, packages/games/*, apps/*, tools/*
├─ package.json                 # scripts: dev, build, test, bots, lint
├─ tsconfig.base.json           # strict, "moduleResolution": "bundler", project refs
├─ vitest.workspace.ts
├─ packages/
│  ├─ shared/                   # @sg/shared: protocol.ts, types, RoomConfig, diff/patch, seeded RNG (sfc32/mulberry32), codec
│  ├─ engine/                   # @sg/engine: GameModule & GameClientModule interfaces, GameRunner (pure, no I/O),
│  │                            #   testing/ (contract tests: determinism, view-secrecy fuzz, serialize round-trip)
│  ├─ ui/                       # @sg/ui: shared three.js shell pieces, theme tokens, ambient modes, DOM UI kit
│  └─ games/
│     ├─ ludo/  { src/logic.ts, src/client.ts, src/index.ts, test/logic.test.ts }
│     ├─ chess/
│     └─ draw-guess/ ...        # curated list only (see game catalog research)
├─ apps/
│  ├─ server/                   # @sg/server: uWS transport, RoomManager, Room actor, AudienceAggregator,
│  │                            #   stores (memory, sqlite), plugins/twitch, http (health, rooms, static client)
│  └─ client/                   # @sg/client: Vite + three.js; routes: / (join), /host, /:code (play), /overlay/:code
└─ tools/
   └─ bots/                     # headless bot client + swarm runner (N players, M audience)
```

- `packages/games/*` depend on `@sg/engine` + `@sg/shared` (+ `three` as **peer** dependency for client entry only). Package `exports`: `"./logic"` (server-safe) and `"./client"` (browser).
- Server bundles with `tsup`/`esbuild` to a single `dist/server.js`; production `pnpm start` serves `apps/client/dist` statically from the same port — a streamer self-hosting runs one command.
- Dev: `pnpm dev` → server (tsx watch) + Vite with `/ws` proxied. No Docker, no Redis, no DB required.

---

## 15. Testability

### Pure reducer tests (vitest)
```ts
import { runScript } from "@sg/engine/testing";
import { logic as ludo } from "@sg/game-ludo/logic";

test("rolling a 6 releases a token", () => {
  const g = runScript(ludo, { seed: 42, players: 2, options: {} });
  g.act("p1", { type: "roll" });             // seeded dice -> deterministic
  expect(g.view({ role: "player", id: "p1" }).canMove).toContain("t0");
});
```
`runScript` is a test harness around the same `GameRunner` the server uses (timers advanced via fake clock `g.advance(ms)`).

### Contract tests every game must pass (auto-generated per registered module)
- Determinism: same seed + same action log ⇒ identical serialized state.
- Serialize/deserialize round-trip.
- View secrecy fuzz: 1,000 random games via `legalActions`, check projections don't leak tagged secrets.
- Termination: random play reaches `end` within bound.
- `parseAction` rejects garbage (fuzzed payloads) without throwing.

### Headless bot swarm
```
pnpm bots --url ws://localhost:8787 --create --game ludo --players 4 --audience 2000 --duration 300
```
- Bot = `protocol` client in Node (plain `ws`), plays via `legalActions`-like hints included in dev-mode views (or re-imports logic module to compute legal moves locally), audience bots vote randomly on polls.
- Reports: msgs/s, p50/p99 action→view latency, server CPU/RAM (via `/health`), dropped/limited messages. Run in CI nightly with small N; locally with large N before streams.
- Also usable as "fill empty seats" bots for streamers testing a playlist alone.

---

## 16. Performance notes (server & wire)

- Pre-serialize one buffer per viewer key per step; never `JSON.stringify` per socket.
- Coalesce multiple steps within one event-loop turn into one outbound message per viewer (microtask flush).
- Turn-based rooms: zero timers besides game timers; no tick. Idle rooms are just memory (~tens of KB).
- Enable permessage-deflate only for `view full` messages > 4 KB (uWS `SHARED_COMPRESSOR`); off for small patches (CPU on low-end servers).
- Room GC: empty room (no host, no players) closed after 10 min; ended rooms snapshot results then free.

---

## 17. Build order (suggested)

1. `shared` protocol + RNG + diff; `engine` GameModule + GameRunner + testing harness.
2. One turn-based game (Ludo) logic + tests; contract test suite.
3. Server: transport, codes, rooms, roles, reconnection, memory store.
4. Client shell: join/host/play routes, cozy scene, one game client.
5. Audience: polls, aggregation, tallies, reactions; overlay route.
6. Bot swarm & load test; SQLite store & leaderboards.
7. Twitch plugin; public room browser; moderation queue.

## Sources
- Colyseus docs / repo / uWS transport: https://docs.colyseus.io/ , https://github.com/colyseus/colyseus , https://github.com/pixels-online/uwebsockets-transport , https://tech-insider.org/colyseus-cloud-setup-2026/
- Browser multiplayer 2026 overview: https://app.cinevva.com/guides/multiplayer-browser-game
- Jackbox streamer/moderation features: https://www.jackboxgames.com/blog/streaming-moderation-accessibility-features-jackbox-party-pack-eight
- Jackbox audience behaviour & scale: https://www.jackboxgames.com/blog/how-audience-play-along-differs-in-each-jackbox-game , https://jackbox.wiki/wiki/Audience , https://gamerhorizon.blog/how-many-people-can-play-jackbox-games
- Jackbox Twitch Audience Kit: https://support.jackboxgames.com/hc/en-us/articles/15794775761047-How-do-I-use-the-Audience-Kit-extension-for-Twitch
- Twitch chat: https://dev.twitch.tv/docs/chat/irc/ , https://dev.twitch.tv/docs/chat/irc-migration/ , https://github.com/robotty/dank-twitch-irc , https://discuss.dev.twitch.com/t/i-want-to-use-eventsub-for-3rd-party-chat-client-but-does-it-support-anonymous-users/59801
