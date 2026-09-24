# Engine API reference

<!-- Generated from TSDoc by `pnpm --filter @sg/engine api-docs`. Do not edit by hand;
     `packages/engine/test/api-docs.test.ts` fails when this file is stale. -->

The public API of `@sg/engine`. Game builders read this file and SPEC §9.3, §9.4 and §14;
they never need to read engine source. Every entry below is exported from the entry point
named in its section heading.

## `@sg/engine`

Game logic API (SPEC §9.3), `GameRunner`, `ctx.timing` and the scenario contract (SPEC §14). Safe for the server, bots and logic: no DOM, no three.js.

### `src/game-module.ts`

The game module API (SPEC §9.3): what every game's pure logic implements and what the
{@link GameRunner} drives. The declarations between the markers below are copied exactly from
the spec (`test/spec-sync.test.ts` fails if they drift); the spec leaves `ContentAccess` to
this file, and it is defined after the copied block together with small helpers.

Module rules (lint and the contract suite enforce these):
1. No `Math.random`, `Date`, timers, I/O or globals: use `ctx.rng`, `ctx.now`, `ctx.timing`.
2. State is plain JSON and treated as immutable (the runner deep-freezes it in dev).
3. Every view includes `phase: string` and `deadline: number | null` (server ms).
4. Hidden information lives under `secret` / `hidden` keys or in `secretPaths`.
5. Content reaches clients only through `view()`, and only once revealed.
6. `onAction` never throws; bad input returns the state unchanged.

#### GameManifest (interface)

Static facts about a game: identity, player range, audience hooks, tick rate, session length
and the 3-step how-to-play card (SPEC §9.3).

```ts
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
```

#### OptionSpec (type)

One host option. The options form is generated from these specs and the runner resolves host
input against them (`resolveOptions`).

```ts
export type OptionSpec =
  | { kind: "int"; key: string; label: string; min: number; max: number; step?: number; default: number }
  | { kind: "bool"; key: string; label: string; default: boolean }
  | { kind: "enum"; key: string; label: string; choices: { value: string; label: string }[]; default: string }
  | { kind: "seconds"; key: string; label: string; min: number; max: number; default: number }
  | { kind: "pack"; key: string; label: string; packKind: PackKind; multi: boolean; default: string[] };
```

#### Timing (interface)

`ctx.timing`: turns base durations into deadline lengths. `input` for player/audience input
windows (scaled, plus stream delay, `null` at timerScale 0); `pace` for reveals and readouts
(never scaled).

```ts
export interface Timing {
  /** Player/audience input window: base × timerScale + streamDelay. Returns null when timerScale = 0 (no timer). */
  input(baseMs: number): number | null;
  /** Pacing (reveals, animations, readouts): base only, never scaled, never null. */
  pace(baseMs: number): number;
}
```

#### Seat (interface)

A seated participant: room player id, display name, seat index, optional team and identity
colour slot (0..7).

```ts
export interface Seat { id: PlayerId; name: string; seat: number; teamId?: TeamId; colorSlot: number /*0..7*/ }
```

#### SetupContext (interface)

What `setup` receives: seats, teams, resolved options, the seeded rng, the clock, timing,
server-only content access and the audience size.

```ts
export interface SetupContext<O> {
  players: Seat[]; teams: { id: TeamId; name: string; colorSlot: number }[];
  options: O; rng: Rng; now: number; timing: Timing;
  content: ContentAccess;          // server-only pack access (sync, pre-loaded); returns [] in client scenarios unless fixture given
  audienceCount: number;
}
```

#### Ctx (interface)

What every reducer receives: the seeded rng, the (game) clock, timing and the audience size.
The only sources of randomness and time in logic.

```ts
export interface Ctx { rng: Rng; now: number; timing: Timing; audienceCount: number }
```

#### ActionCtx (interface)

The `onAction` context: {@link Ctx} plus the acting seat (or host / moderator) and its team.

```ts
export interface ActionCtx extends Ctx { actor: { id: PlayerId; role: "player" | "host" | "moderator"; teamId?: TeamId } }
```

#### Step (interface)

A reducer result: the next state plus effects for the runner and the platform.

```ts
export interface Step<S> { state: S; effects?: Effect[] }
```

#### Effect (type)

Side-effect requests from a reducer. The runner applies `timer.*`, `score` and `end` (and
holds early `audience.close`s for the minimum audience window); every other effect goes to the
platform.

```ts
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
```

#### PollSpec (interface)

An audience poll the game opens with `audience.open` (SPEC §4). `accept` is a server-side
secret and is never broadcast.

```ts
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
```

#### PollResult (interface)

The aggregate result of a closed poll, delivered to `onAudienceResult`. Games never see
individual votes.

```ts
export interface PollResult {
  pollId: string; kind: PollSpec["kind"]; total: number;
  tallies: Record<string, number>;           // optionId -> count; dial: bin index -> count; tap: {taps}
  byTeam?: Record<TeamId, Record<string, number>>;
  mean?: number;                             // dial
  firstCorrect?: { audId: AudId; name: string }[]; // guess
}
```

#### GameResult (interface)

The final ranking (feeds Night Champion placement points) and optional highlights.

```ts
export interface GameResult {
  ranking: { id: PlayerId | TeamId; score: number; place: number }[];
  highlights?: { label: string; playerId?: PlayerId; audId?: AudId }[];
}
```

#### ViewerKey (type)

Who a view is for. One view is computed per distinct key per step; `stage` is broadcast-safe
and never contains secrets.

```ts
export type ViewerKey =
  | { role: "player"; id: PlayerId }
  | { role: "audience"; restricted?: boolean }  // ONE shared view for all audience; `restricted` = second shared view for audience sessions whose IP hash matches a seated player (games strip secrets there)
  | { role: "stage" }        // safe to broadcast; used by host Stage and overlay
  | { role: "host" }         // stage + host-only info (moderation previews, pending counts); never player secrets. Delivered ONLY to the host panel pop-out, never to the Stage window (§2)
  | { role: "moderator" };
```

#### GameModule (interface)

The pure game logic contract every game implements (SPEC §9.3). `view()` is the security
boundary; `onAction` never throws; `bot()` is required.

```ts
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

#### PackInfo (interface)

Summary of one content pack a game may draw from (never the items themselves).

```ts
export interface PackInfo {
  id: string;
  kind: PackKind;
  name: string;
  rating: "all" | "teen";
  count: number;
}
```

#### ContentAccess (interface)

Server-only, synchronous access to the pre-loaded content packs (SPEC §9.3 `SetupContext.content`,
§12). Clients never receive a whole pack: games copy the items they use into `hidden` state and
reveal them through `view()`. In client scenarios it returns `[]` unless a fixture is given
(see `fakeContent` in `@sg/engine/testing`).

```ts
export interface ContentAccess {
  /** The packs of `kind` available to this room (after the room's content filter). */
  packs(kind: PackKind): readonly PackInfo[];
  /**
   * Every item of `kind` in the given packs, in pack order then item order. Unknown pack ids
   * (or packs of another kind) are skipped, so the result can be empty.
   */
  items<K extends PackKind>(kind: K, packIds: readonly string[]): readonly PackItemMap[K][];
  /**
   * True when a content item was already used earlier in this room session (no repeats across
   * games, e.g. trivia-night). `key` is the item's `id`, or for id-less kinds its main text
   * (see {@link contentKey}).
   */
  isUsed(kind: PackKind, key: string): boolean;
}
```

#### contentKey (function)

The stable key of a content item, used by {@link ContentAccess.isUsed}: the item's `id` when it
has one; `doodle-words` use the word, `ooo-pairs` use `"a|b"`.

```ts
export function contentKey<K extends PackKind>(kind: K, item: PackItemMap[K]): string;
```

#### EMPTY_CONTENT (const)

Content access with no packs at all: every lookup is empty and nothing is used.

```ts
const EMPTY_CONTENT: ContentAccess;
```

#### SECRET_KEYS (const)

Keys under which state holds hidden information (SPEC §9.3 rule 4).

```ts
const SECRET_KEYS: readonly string[];
```

#### defaultOptions (function)

The default option values of a game, from its `optionSpecs` (each spec's `default`). The
runner merges host options over these.

```ts
export function defaultOptions(specs: readonly OptionSpec[]): Record<string, unknown>;
```

#### resolveOptions (function)

Resolves host options against a game's `optionSpecs`: every spec key gets a valid value.
Missing or invalid values fall back to the spec default; numbers are clamped to
`[min, max]` (and snapped to `step` for `int`, whole seconds for `seconds`); enums must be
one of their choices; packs must be string arrays (one id when `multi` is false). Keys that
no spec declares are dropped.

```ts
export function resolveOptions(
  specs: readonly OptionSpec[],
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown>;
```

#### AnyGameModule (type)

Any game module, for registries and tooling that do not care about the type parameters.

```ts
export type AnyGameModule = GameModule<any, any, any, any>;
```

#### GameHostCommand (type)

The host commands a game may receive through `onHostCommand`.

```ts
export type GameHostCommand = Parameters<
  NonNullable<GameModule<unknown, unknown, unknown, unknown>["onHostCommand"]>
>[1];
```

### `src/runner.ts`

`GameRunner` (SPEC §9.5, ROADMAP M0-04): the pure runtime that drives one game module.

It owns everything around the module's reducers, and nothing about sockets:
- calls `setup` / `onAction` / `onTimer` / `onTick` / `onAudience*` / `onModeration` /
  `onPlayerLeave` / `onPlayerRejoin` / `onHostCommand` with a correct `ctx`;
- applies effects: keeps the **timer table** (`timer.set` / `timer.clear`), **aggregates
  `score`** deltas, records **`end`**, and hands every other effect to the host (the room);
- enforces the **minimum audience window** (SPEC §4): an early `audience.close` of a timed
  poll is held until `openedAt + streamDelaySec + 5 s` (event-closed polls are exempt);
- **takes over a disconnected seat** by calling `bot()` after `botDelayMs`;
- **deep-freezes state in dev** (every step for `tickHz` 0/10/20, every 60th for 60) so a
  module that mutates its state throws at once;
- **computes views per distinct viewer key**, memoised per step (5,000 audience members cost
  one `view()` call);
- **pause** freezes every timer and **resume** re-arms it with the same remaining time.

Time. The runner never reads a clock: every call takes the host's `now` (server ms). The
module sees a *game clock* that excludes paused time, so remaining input time survives a
pause exactly. The runner translates back to server time at its edges: `view().deadline`
(the top-level field every view carries, SPEC §9.3 rule 3) and the `closesAtMs` of emitted
`audience.open` / `audience.enroll` effects. Timers fire with `ctx.now` equal to their own
`atMs` (or the current time, for a timer set in the past), so results never depend on how
often the host calls {@link GameRunner.advance}.

#### RunnerError (type)

Why a runner call was refused. The room maps these onto protocol `ErrorCode`s.

```ts
export type RunnerError =
  /** `parseAction` returned `null`. */
  | "BAD_ACTION"
  /** The module rejected the action (state unchanged, or an `illegal` fx). */
  | "ILLEGAL"
  /** A `player` actor that holds no seat in this game. */
  | "NOT_SEATED"
  /** The game already emitted `end`. */
  | "ENDED"
  /** The runner is paused; player actions and host game commands wait for resume. */
  | "PAUSED"
  /** The module does not implement the hook this call needs. */
  | "UNSUPPORTED";
```

#### RunnerResult (interface)

The outcome of one runner call.

```ts
export interface RunnerResult {
  ok: boolean;
  err?: RunnerError;
  /**
   * Effects for the host to route, in order, including any produced by timers that fell due
   * before the call. Times are server ms. `timer.*` effects are internal and never appear here;
   * `score` and `end` do (the runner has already applied them).
   */
  effects: Effect[];
}
```

#### RunnerTimer (interface)

A pending timer, in server time.

```ts
export interface RunnerTimer {
  id: string;
  atMs: number;
  remainingMs: number;
}
```

#### OpenPoll (interface)

An audience poll the module opened and the runner has not yet seen close.

```ts
export interface OpenPoll {
  spec: PollSpec;
  /** Server ms when the poll opened. */
  openedAtMs: number;
  /** True while an early close is being held by the minimum audience window. */
  closing: boolean;
}
```

#### RunnerStats (interface)

Counters for tests and the server's perf gates.

```ts
export interface RunnerStats {
  /** Reducer calls applied (setup included). */
  steps: number;
  /** `module.view()` calls actually made (memo misses). */
  viewCalls: number;
  /** Bot takeover actions applied. */
  botActions: number;
  /** Bot takeover actions the module rejected. */
  botIllegal: number;
}
```

#### RunnerOptions (interface)

How a runner is started.

```ts
export interface RunnerOptions<O> {
  /** Seated participants, in seat order. */
  players: readonly Seat[];
  teams?: SetupContext<O>["teams"];
  /** Host options; merged over the module's `optionSpecs` defaults and clamped to them. */
  options?: Partial<O>;
  /** Seeds `ctx.rng` (and, forked, the takeover bots). */
  seed: number | string;
  /** Server ms at setup. */
  now: number;
  /** Default `DEFAULT_ROOM_CONFIG.timerScale` (1). */
  timerScale?: RoomConfig["timerScale"];
  /** Default `DEFAULT_ROOM_CONFIG.streamDelaySec` (3). */
  streamDelaySec?: number;
  /** Default {@link EMPTY_CONTENT}. */
  content?: ContentAccess;
  /** Default 0. */
  audienceCount?: number;
  /** Dev mode: deep-freeze state (default true; production servers pass false). */
  dev?: boolean;
  /** Delay before a takeover bot acts (game ms). Default {@link DEFAULT_BOT_DELAY_MS}. */
  botDelayMs?: number;
}
```

#### DEFAULT_BOT_DELAY_MS (const)

Default takeover-bot thinking time: long enough to read on stream, short enough to flow.

```ts
const DEFAULT_BOT_DELAY_MS: 1200;
```

#### RunnerSnapshot (interface)

The JSON form of a running game, for Store snapshots and crash recovery (SPEC §9.5).

```ts
export interface RunnerSnapshot {
  v: 1;
  game: GameId;
  version: string;
  state: string;
  rng: RngState;
  botRng: RngState;
  clock: number;
  offset: number;
  pausedAt: number | null;
  seq: number;
  timers: { id: string; at: number; seq: number }[];
  deferred: { at: number; seq: number; effect: Effect }[];
  openPolls: { openedAt: number; spec: PollSpec }[];
  bots: { id: PlayerId; at: number | null }[];
  nextTick: number | null;
  scores: Record<string, number>;
  result: GameResult | null;
  steps: number;
  players: Seat[];
  teams: SetupContext<unknown>["teams"];
  timerScale: RoomConfig["timerScale"];
  streamDelaySec: number;
  audienceCount: number;
  options: unknown;
}
```

#### viewerKeyId (function)

The stable string for a viewer key: views are memoised and fanned out per distinct key
(`player:<id>`, `audience`, `audience:restricted`, `stage`, `host`, `moderator`).

```ts
export function viewerKeyId(viewer: ViewerKey): string;
```

#### deepFreeze (function)

Recursively freezes a plain JSON value in place and returns it. Already-frozen subtrees are
skipped, so re-freezing a state that shares structure with the last one is cheap.

```ts
export function deepFreeze<T>(value: T): T;
```

#### GameRunner (class)

Drives one game module. See the module docs for the full behaviour; every mutating call
first fires whatever fell due before `now`, then does its work, then fires anything that is
due at once (a zero-delay bot, a timer set in the past).

- `@typeParam` S - module state
- `@typeParam` A - parsed action
- `@typeParam` O - options
- `@typeParam` V - view

```ts
export class GameRunner<S, A, O, V> {
  // The module being run.
  readonly module: GameModule<S, A, O, V>;
  // Effects `setup` produced (timers already applied), for the host to route once.
  readonly setupEffects: readonly Effect[];
  // The resolved options the module was set up with.
  readonly options: O;
  constructor(module: GameModule<S, A, O, V>, opts: RunnerOptions<O>);
  // Rebuilds a runner from {@link GameRunner.snapshot}, without calling `setup`. The restored
  // runner continues exactly where the original was (same rng streams, timers, holds).
  static restore<S, A, O, V>(
    module: GameModule<S, A, O, V>,
    snapshot: RunnerSnapshot,
    opts: Pick<RunnerOptions<O>, "content" | "dev" | "botDelayMs"> = {},
  ): GameRunner<S, A, O, V>;
  // The current module state (deep-frozen in dev).
  get state(): S;
  // The game result once `end` was emitted, else `null`.
  get result(): GameResult | null;
  // True once the module emitted `end`.
  get ended(): boolean;
  // True between {@link GameRunner.pause} and {@link GameRunner.resume}.
  get paused(): boolean;
  // The aggregated `score` deltas so far (PlayerId | TeamId → points).
  get scores(): Readonly<Record<string, number>>;
  // The runner's clock in server ms (the latest time it has processed).
  get now(): number;
  // The game clock (server time minus paused time): what the module sees as `ctx.now`.
  get gameNow(): number;
  // The seats this game runs with.
  get players(): readonly Seat[];
  // The room timing currently applied (`timerScale`, `streamDelaySec`).
  get timing(): Readonly<TimingConfig>;
  // Counters: steps, view calls, bot actions.
  get stats(): Readonly<RunnerStats>;
  // Pending module timers in server time, soonest first.
  timers(): RunnerTimer[];
  // Audience polls that are open (or being held open by the minimum window).
  openPolls(): OpenPoll[];
  // Whether a takeover bot plays this seat.
  isBot(id: PlayerId): boolean;
  // The server time of the next thing the runner will do by itself (a timer, a held audience
  // close, a bot move or a tick), or `null`. Hosts schedule one wake-up for it and then call
  // {@link GameRunner.advance}. Always `null` while paused.
  nextEventAt(): number | null;
  // The view for one viewer, memoised per step and per distinct viewer key. The top-level
  // `deadline` is translated from game time to server time.
  view(viewer: ViewerKey): V;
  // A game action from a seat (or the host / a moderator). Parses it with `parseAction`,
  // then calls `onAction`. Refused while paused.
  act(
    actorId: PlayerId,
    raw: unknown,
    now: number,
    role: ActionCtx["actor"]["role"] = "player",
  ): RunnerResult;
  // A host game command (`forceAdvance`, `skipItem`). Refused while paused.
  hostCommand(cmd: GameHostCommand, now: number): RunnerResult;
  // The aggregate result of a closed poll (from the AudienceAggregator). Accepted while
  // paused: it is applied at the frozen game time.
  audienceResult(result: PollResult, now: number): RunnerResult;
  // Audience entrants when an enrolment closes (Marble Rally).
  audienceEnroll(
    entrants: { audId: AudId; name: string; skin: number }[],
    now: number,
  ): RunnerResult;
  // One direct audience action (`manifest.audience.direct`), already rate-limited.
  audienceAction(audId: AudId, action: unknown, now: number): RunnerResult;
  // A moderation decision for an item the module sent with a `moderate` effect.
  moderation(itemId: string, approved: boolean, now: number): RunnerResult;
  // A seated player disconnected (the room decides when a bot takes over: {@link setBot}).
  playerLeave(id: PlayerId, now: number): RunnerResult;
  // A seated player came back: calls `onPlayerRejoin` and ends any bot takeover.
  playerRejoin(id: PlayerId, now: number): RunnerResult;
  // Starts or stops a bot takeover for a seat. While on, the runner calls `bot()` for that
  // seat `botDelayMs` after every state change and applies whatever it returns.
  setBot(id: PlayerId, on: boolean, now: number): RunnerResult;
  // Fires everything due up to `now`: timers, held audience closes, bot moves, ticks.
  advance(now: number): RunnerResult;
  // Pauses the game (BRB). Every timer, held close, bot move and tick freezes with its
  // remaining time; nothing fires until {@link resume}.
  pause(now: number): RunnerResult;
  // Resumes after {@link pause}: every frozen timer is re-armed with its remaining time.
  resume(now: number): RunnerResult;
  // Changes the room's timing for future steps (host changed `timerScale` / stream delay).
  setTiming(config: TimingConfig): void;
  // Updates `ctx.audienceCount` for future steps.
  setAudienceCount(count: number): void;
  // A JSON-safe snapshot of everything needed to continue this game later.
  snapshot(): RunnerSnapshot;
}
```

### `src/scenario.ts`

The scenario contract (SPEC §14): every visible state of a game is reachable as a named
scenario that `/dev/scenario` renders with no network. The declarations between the markers
are copied exactly from the spec (`test/spec-sync.test.ts` fails if they drift).

#### ScenarioCtx (interface)

A named, reachable game state for `/dev/scenario` (SPEC §14): builds a state (and optionally a
viewer and fx to replay), with an optional animation to scrub.

```ts
export interface ScenarioCtx { seed: number; rng: Rng; players: number; role: "stage"|"host"|"player"|"audience" }
```

#### Scenario (interface)

```ts
export interface Scenario<S> { id: string; description: string; build(ctx: ScenarioCtx): { state: S; viewer?: ViewerKey; fx?: {name:string;data?:unknown}[] }; anim?: { name: string; durationMs: number } }
```

#### ScenarioRegistry (type)

A game's scenarios by id (exported from its `scenarios.ts`).

```ts
export type ScenarioRegistry<S> = Record<string, Scenario<S>>;
```

#### ScenarioRole (type)

The roles a scenario can be rendered for (`/dev/scenario?role=`).

```ts
export type ScenarioRole = ScenarioCtx["role"];
```

#### SCENARIO_ROLES (const)

Every scenario role, in the order the harness renders them.

```ts
const SCENARIO_ROLES: readonly ScenarioRole[];
```

#### DEFAULT_SCENARIO_PLAYER (const)

The default player a `role=player` scenario is viewed as, when the scenario names none.

```ts
const DEFAULT_SCENARIO_PLAYER: PlayerId;
```

#### viewerKeyForRole (function)

The viewer key for a scenario role. `player` views as `playerId` (default
{@link DEFAULT_SCENARIO_PLAYER}); the other roles map one to one.

```ts
export function viewerKeyForRole(role: ScenarioRole, playerId?: PlayerId): ViewerKey;
```

#### ResolveScenarioInput (interface)

Inputs to {@link resolveScenario}: the query parameters of `/dev/scenario`.

```ts
export interface ResolveScenarioInput {
  /** The scenario id (`state=`). */
  state: string;
  /** The seed (`seed=`); also seeds the scenario's `rng`. Default 1. */
  seed?: number;
  /** Player count hint for scenarios that support several. Default `module.manifest.minPlayers`. */
  players?: number;
  /** Role to render for (`role=`). Default `stage`. */
  role?: ScenarioRole;
  /** Player id for `role=player` when the scenario does not pick its own viewer. */
  playerId?: PlayerId;
}
```

#### ResolvedScenario (interface)

What the scenario route mounts: the state, the viewer, its view and any fx to replay.

```ts
export interface ResolvedScenario<S, V> {
  scenario: Scenario<S>;
  state: S;
  viewer: ViewerKey;
  view: V;
  fx: { name: string; data?: unknown }[];
}
```

#### resolveScenario (function)

Builds a scenario exactly as `/dev/scenario` does (SPEC §14): seeds an rng from `seed`,
calls `scenario.build`, then runs `view(state, viewer)` for the scenario's own viewer when it
matches `role`, or else the viewer of `role`. Deterministic for a fixed input.

- `@throws` Error when the scenario id is unknown (the message lists the registered ids).

```ts
export function resolveScenario<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  registry: ScenarioRegistry<S>,
  input: ResolveScenarioInput,
): ResolvedScenario<S, V>;
```

### `src/timing.ts`

`ctx.timing` (SPEC §9.3 `Timing`, §4 "Stream delay", §15 "Timers"): the only way game logic
turns a base duration into a deadline length.

- `input(base)` is a **player or audience input window**: `base × timerScale + streamDelay`,
  or `null` when `timerScale = 0` (no input timers; the host advances with `forceAdvance`).
- `pace(base)` is **pacing** (reveals, animations, readouts): `base`, never scaled, never null.

Games store the resulting absolute deadline (`ctx.now + timing.input(…)`) in their state, so
views always carry the real deadline and the runner never rescales timers behind their back.

#### TimingConfig (type)

The room settings that shape timing (a subset of {@link RoomConfig}).

```ts
export type TimingConfig = Pick<RoomConfig, "timerScale" | "streamDelaySec">;
```

#### TIMER_SCALES (const)

Every legal `RoomConfig.timerScale` (SPEC §7).

```ts
const TIMER_SCALES: readonly RoomConfig["timerScale"][];
```

#### MIN_AUDIENCE_WINDOW_EXTRA_MS (const)

The minimum audience window (SPEC §4): an early close of a timed audience poll is held until
at least `streamDelaySec + 5 s` after the poll opened. This is the fixed 5 s part.

```ts
const MIN_AUDIENCE_WINDOW_EXTRA_MS: 5000;
```

#### createTiming (function)

Builds the {@link Timing} a runner hands to game logic.

- `@throws` RangeError when `timerScale` is not one of {@link TIMER_SCALES} or `streamDelaySec`
is outside `0..8` (SPEC §7), so a bad room config fails loudly instead of skewing timers.

```ts
export function createTiming(config: TimingConfig): Timing;
```

#### minAudienceWindowMs (function)

The minimum audience window in ms for a stream delay (SPEC §4):
`streamDelaySec × 1000 + 5000`.

```ts
export function minAudienceWindowMs(streamDelaySec: number): number;
```

## `@sg/engine/client`

Client module API (SPEC §9.4) and the shell contracts it names. Imported by game clients only (DOM + three.js types).

### `src/client-module.ts`

The client module API (SPEC §9.4): what every game's Stage and phone clients implement, and
what the shell hands them. The declarations between the markers are copied exactly from the
spec (`test/spec-sync.test.ts` fails if they drift).

The spec names its supporting types (`CameraRig`, `ThemeApi`, `MaterialFactories`, …) but
leaves their shape to this file. They are defined after the copied block as **structural
contracts**: `@sg/render` (M1-06/M1-07), `@sg/ui` (M1-05) and `@sg/audio` (M1-08) implement
them, and games program against them, so a game never imports a concrete engine class. The
engine only depends on three.js **types** (erased at build time), never on its runtime.

Shell rules (SPEC §9.4): the shell owns the renderer, the single render loop, the room, table,
lights, ambient modes, camera rig, transitions, intro card, Results, Scoreboard, reactions,
audience panel and timer HUD. Games only add to `ctx.scene` and `ctx.hud`, and every
`StageInstance.dispose()` frees everything it created.

#### GameClientModule (interface)

A game's client entry (SPEC §9.4): its table mat, Stage (3D + HUD), phone controller and
optional custom audience panel.

```ts
export interface GameClientModule<V, A> {
  id: GameId;
  mat: MatKind;                                   // "wood-board" | "inlay" | "paper" | "cork" | "felt" | "pegboard"
  stage(ctx: StageContext): StageInstance<V>;     // 3D objects + stage HUD (DOM), consumes stage|host view
  controller(ctx: ControllerContext<A>): ControllerInstance<V>;    // phone UI for players (Preact, DOM/SVG); may call ctx.requestBoard() ONLY behind the opt-in "3D board" toggle (lazy-loads three)
  audience?(ctx: ControllerContext<never>): ControllerInstance<V>; // optional custom audience panel; default = generic poll UI
}
```

#### StageContext (interface)

Everything the shell hands a game's Stage. Games only add to `scene` and `hud`, never own a
render loop, and create materials only through `materials`.

```ts
export interface StageContext {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- copied exactly from SPEC §9.4
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
```

#### StageInstance (interface)

A mounted Stage: diff-driven `update`, optional fx / scenario seek / per-frame / resize hooks,
and a `dispose` that frees everything it created.

```ts
export interface StageInstance<V> {
  update(view: V, prev: V | null): void;          // diff-driven animation
  onFx?(e: { name: string; data?: unknown }): void;
  seek?(anim: string, t: number): void;           // scenario t-scrub (0..1) for screenshots
  frame?(dtMs: number): void;
  resize?(w: number, h: number): void;
  dispose(): void;                                // MUST free everything it created
}
```

#### ControllerContext (interface)

Everything the shell hands a phone controller (DOM/SVG): root element, theme, `send`, sound,
haptics, the opt-in 3D board and the local player.

```ts
export interface ControllerContext<A> {
  root: HTMLElement; theme: ThemeApi; send(action: A): Promise<{ ok: boolean; err?: string }>;
  sfx: StageContext["sfx"]; haptic(ms: number): void; requestBoard(): Promise<StageContext>; me: { id: string; colorSlot: number };
}
```

#### ControllerInstance (interface)

A mounted controller or audience panel.

```ts
export interface ControllerInstance<V> { update(view: V, prev: V | null): void; dispose(): void }
```

#### MatKind (type)

The table mat a game plays on (SPEC §11).

```ts
export type MatKind = "wood-board" | "inlay" | "paper" | "cork" | "felt" | "pegboard";
```

#### MAT_KINDS (const)

Every {@link MatKind}.

```ts
const MAT_KINDS: readonly MatKind[];
```

#### QualityTier (type)

The device quality tier (SPEC §10). Games must stay inside that tier's budget.

```ts
export type QualityTier = "low" | "mid" | "high";
```

#### QUALITY_TIERS (const)

Every {@link QualityTier}, cheapest first.

```ts
const QUALITY_TIERS: readonly QualityTier[];
```

#### Vec3Like (interface)

A plain 3D point; `three`'s `Vector3` satisfies it.

```ts
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}
```

#### PointerLike (interface)

A pointer position in client (CSS) pixels; a DOM `PointerEvent` satisfies it.

```ts
export interface PointerLike {
  clientX: number;
  clientY: number;
}
```

#### ColorLike (type)

A colour: an `@sg/ui` token value (a CSS colour string taken from {@link ThemeTokens}) or a
three.js `Color`. Games never write colour literals (SPEC §13, DOD G2).

```ts
export type ColorLike = string | Color;
```

#### CameraState (type)

The four camera states (SPEC §13.4).

```ts
export type CameraState = "establishing" | "play" | "focus" | "top";
```

#### CAMERA_STATES (const)

Every {@link CameraState}.

```ts
const CAMERA_STATES: readonly CameraState[];
```

#### CameraRig (interface)

The shell's camera rig. It always glides on the `camera` spring and never cuts during play;
idle drift, portrait framing and Stream Layout offsets are applied by the rig itself.

```ts
export interface CameraRig {
  /** The state the rig is in or gliding towards. */
  readonly state: CameraState;
  /**
   * Glides to a camera state. `immediate` snaps (allowed only before the first frame of a
   * scenario or behind a transition).
   */
  setState(state: CameraState, opts?: { immediate?: boolean }): void;
  /** Glides the `focus` state towards a point on the table (15–25% closer, 28° FOV). */
  focusOn(target: Vec3Like, opts?: { immediate?: boolean }): void;
}
```

#### ModeTokens (interface)

The per-mode colour and light tokens (SPEC §13.2); colours are CSS colour strings.

```ts
export interface ModeTokens {
  skyTop: string;
  skyBottom: string;
  hemiSky: string;
  hemiGround: string;
  key: string;
  keyIntensity: number;
  fillIntensity: number;
  fog: string;
  wall: string;
  wood: string;
  felt: string;
  shadow: string;
  shadowAlpha: number;
  glow: string;
  glowIntensity: number;
  uiBg: string;
  uiSurface: string;
  uiSurfaceAlpha: number;
  uiInk: string;
  uiMuted: string;
  uiLine: string;
  accent: string;
}
```

#### IdentityGlyph (type)

The glyph paired with each identity colour (SPEC §13.3).

```ts
export type IdentityGlyph =
  "circle" | "triangle" | "square" | "diamond" | "star" | "plus" | "pentagon" | "heart";
```

#### IdentityColor (interface)

One of the 8 identity colours (SPEC §13.3), fixed in every mode.

```ts
export interface IdentityColor {
  /** Colour slot `0..7` (`Seat.colorSlot`). */
  slot: number;
  /** Display name, e.g. "Tomato". */
  name: string;
  base: string;
  deep: string;
  glyph: IdentityGlyph;
}
```

#### EasingName (type)

The named easings of SPEC §13.4.

```ts
export type EasingName = "outSoft" | "inSoft" | "inout" | "back" | "linear";
```

#### EASING_NAMES (const)

Every {@link EasingName}.

```ts
const EASING_NAMES: readonly EasingName[];
```

#### SpringName (type)

The named springs of SPEC §13.4.

```ts
export type SpringName = "snappy" | "bouncy" | "gentle" | "wobbly" | "camera";
```

#### SPRING_NAMES (const)

Every {@link SpringName}.

```ts
const SPRING_NAMES: readonly SpringName[];
```

#### SpringConfig (interface)

A spring's physical parameters (SPEC §13.4 lists stiffness/damping).

```ts
export interface SpringConfig {
  stiffness: number;
  damping: number;
  /** Default 1. */
  mass?: number;
}
```

#### SpringPresets (type)

The spring presets handed to games (`ctx.springs`).

```ts
export type SpringPresets = Readonly<Record<SpringName, SpringConfig>>;
```

#### ThemeTokens (interface)

The full token set of the active mode (SPEC §13; implemented by `@sg/ui/tokens.ts`).

```ts
export interface ThemeTokens {
  mode: ModeTokens;
  /** The 8 identity colours, indexed by colour slot. */
  identity: readonly IdentityColor[];
  semantic: { success: string; warning: string; danger: string; info: string; audience: string };
  /** Game-specific fixed tokens (SPEC §13.3). */
  fixed: { chessLight: string; chessDark: string; paper: string; glass: string };
  /** Radii in px (SPEC §13.4); `pill` is fully rounded. */
  radius: { sm: number; md: number; lg: number; xl: number; pill: number };
  /** The 4-pt spacing scale in px. */
  space: readonly number[];
  /** Durations in ms and easings (CSS `cubic-bezier(…)` strings) by name. */
  motion: {
    durationMs: Readonly<Record<EasingName, number>>;
    easing: Readonly<Record<EasingName, string>>;
  };
}
```

#### ThemeApi (interface)

Theme access for games (`ctx.theme`).

```ts
export interface ThemeApi {
  /** The active ambient mode. */
  readonly mode: AmbientMode;
  /** The active mode's tokens. Replaced (not mutated) on a mode change. */
  readonly tokens: ThemeTokens;
  /** The identity colour of a colour slot (`0..7`; other values wrap). */
  identity(slot: number): IdentityColor;
  /**
   * Subscribes to mode changes (the shell lerps the environment over 2.5 s; games re-tint on
   * this callback). Returns the unsubscribe function; call it in `dispose()`.
   */
  onModeChange(cb: (mode: AmbientMode, tokens: ThemeTokens) => void): () => void;
}
```

#### TweenHandle (interface)

A running tween or spring.

```ts
export interface TweenHandle {
  /** Stops it where it is; `finished` then resolves. */
  cancel(): void;
  /** Resolves when it completes or is cancelled. */
  readonly finished: Promise<void>;
}
```

#### TweenOptions (interface)

Options of a timed tween. Durations come from tokens, never literals.

```ts
export interface TweenOptions {
  durationMs: number;
  easing?: EasingName;
  delayMs?: number;
  onUpdate?: () => void;
  onComplete?: () => void;
}
```

#### TweenTargets (type)

The numeric properties of `T` a tween may drive.

```ts
export type TweenTargets<T> = Partial<Record<keyof T, number>>;
```

#### TweenApi (interface)

Tweens and springs driven by the shell's loop (`ctx.tween`). Every running animation keeps
the on-demand loop awake; with reduced motion, tweens jump to their end value.

```ts
export interface TweenApi {
  /** Tweens numeric properties of `target` (e.g. an `Object3D.position`) to `to`. */
  to<T extends object>(target: T, to: TweenTargets<T>, opts: TweenOptions): TweenHandle;
  /** Animates numeric properties of `target` to `to` on a spring preset or config. */
  spring<T extends object>(
    target: T,
    to: TweenTargets<T>,
    spring: SpringName | SpringConfig,
    opts?: { onUpdate?: () => void; onComplete?: () => void },
  ): TweenHandle;
  /** Cancels every tween and spring on `target`. */
  cancelAll(target: object): void;
}
```

#### ReactionName (type)

One of the 6 audience emotes (the same ids as `ReactionId` in `@sg/shared`).

```ts
export type ReactionName = "heart" | "laugh" | "wow" | "clap" | "fire" | "sad";
```

#### FxApi (interface)

Pooled stage effects (`ctx.fx`). All respect the quality tier and reduced motion (no
confetti, no shake).

```ts
export interface FxApi {
  /** A confetti burst in the given colours (usually identity colours), from `origin` or centre. */
  confetti(colors: readonly ColorLike[], opts?: { origin?: Vec3Like; count?: number }): void;
  /** A soft puff (6 instanced circles) at a point, e.g. a capture. */
  puff(pos: Vec3Like, color: ColorLike): void;
  /** Adds an additive halo sprite to an object ("fake bloom"). Returns the remover. */
  halo(target: Object3D, opts?: { color?: ColorLike; scale?: number }): () => void;
  /** Floating reaction sprites (at most 30 on screen, shared with the audience layer). */
  reactions(name: ReactionName, count?: number): void;
  /** Camera micro-shake (high tier only; a no-op with reduced motion). */
  shake(strength?: number): void;
}
```

#### CanvasPainter (type)

Paints a mat's canvas texture; `w`/`h` are the canvas size in px.

```ts
export type CanvasPainter = (ctx: CanvasRenderingContext2D, size: { w: number; h: number }) => void;
```

#### MatApi (interface)

The table mat (`ctx.mats`).

```ts
export interface MatApi {
  /** Switches the table mat, optionally overpainting it (board art, card layout, …). */
  setMat(kind: MatKind, painter?: CanvasPainter): void;
}
```

#### MaterialOptions (interface)

Options for the material factories. Colours come from tokens.

```ts
export interface MaterialOptions {
  color?: ColorLike;
  map?: Texture | null;
  vertexColors?: boolean;
  transparent?: boolean;
  opacity?: number;
}
```

#### MaterialFactories (interface)

The ONLY source of materials (SPEC §13.5; lint bans `new *Material` in games). The caller
owns each returned material and disposes it in `dispose()`.

```ts
export interface MaterialFactories {
  /** Toon with the 3-step ramp, plus the rim "toy glow" on mid/high: pieces. */
  makeToon(opts?: MaterialOptions & { rim?: boolean }): MeshToonMaterial;
  /** Procedural clay matcap, warm/cool blended per mode: chess and clay objects. */
  makeMatcap(opts?: MaterialOptions & { variant?: "warm" | "cool" | "blend" }): MeshMatcapMaterial;
  /** Lambert with vertex-colour AO: room and table pieces. */
  makeLambertVC(opts?: MaterialOptions): MeshLambertMaterial;
  /** Unlit: sky, halos, confetti, shadows. */
  makeBasic(
    opts?: MaterialOptions & { additive?: boolean; depthWrite?: boolean },
  ): MeshBasicMaterial;
}
```

#### TextureName (type)

The procedural textures of SPEC §13.6 / M1-06.

```ts
export type TextureName =
  | "noise"
  | "wood"
  | "felt"
  | "paper"
  | "cork"
  | "board"
  | "cards"
  | "dice"
  | "blob"
  | "matcap"
  | "ramp"
  | "grain";
```

#### ProceduralTextureOptions (interface)

Options of a procedural texture.

```ts
export interface ProceduralTextureOptions {
  /** Edge length in px (the factory clamps it per quality tier). */
  size?: number;
  seed?: number;
  tint?: ColorLike;
  /** Kind-specific variant, e.g. a board layout or a matcap flavour. */
  variant?: string;
}
```

#### ProceduralTextures (type)

Procedural, cached textures (`ctx.textures`; v1 ships no image files). Returned textures are
shared: never dispose them.

```ts
export type ProceduralTextures = {
  readonly [K in TextureName]: (opts?: ProceduralTextureOptions) => CanvasTexture | DataTexture;
};
```

#### SfxName (type)

The core synthesized sound set (SPEC §13.7).

```ts
export type SfxName =
  "pop" | "tick" | "tok" | "card" | "chime" | "success" | "fail" | "capture" | "win" | "vote";
```

#### SFX_NAMES (const)

Every {@link SfxName}.

```ts
const SFX_NAMES: readonly SfxName[];
```

#### PickApi (interface)

Picking without per-frame allocation (`ctx.pick`).

```ts
export interface PickApi {
  /**
   * Analytic intersection of the pointer ray with the horizontal plane `y = planeY` (default:
   * the table top). Writes into and returns `out` (or an internal vector), or `null` if the ray
   * misses.
   */
  plane(pointer: PointerLike, planeY?: number, out?: Vector3): Vector3 | null;
  /** The instance id under the pointer on an instanced mesh, or `null`. */
  instance(mesh: InstancedMesh, pointer: PointerLike): number | null;
  /** The first of `targets` under the pointer (recursive), or `null`. */
  object(targets: readonly Object3D[], pointer: PointerLike): Object3D | null;
}
```

## `@sg/engine/testing`

The test kit every game uses: `runScript`, the contract suite (G4), the timed-bot sim and pacing report (G5, G14), `fakeContent`.

### `src/testing/contract.ts`

The contract suite every game must pass (ROADMAP M0-04, DOD G4, SPEC §9.3 module rules):

| check         | what it proves                                                            |
|---------------|---------------------------------------------------------------------------|
| `determinism` | the same seed and inputs give the same states and effects, run after run  |
| `serialize`   | state is plain JSON and `deserialize(serialize(s))` round-trips exactly   |
| `secrecy`     | fuzzed games: no view leaks another viewer's `secret`/`hidden` values     |
| `termination` | bot-only games always end, within `maxSteps`, with no illegal bot action  |
| `parseAction` | 1,000 garbage payloads never throw; every legal action parses             |
| `illegal`     | actions from seats that may not act leave the state unchanged             |
| `views`       | every view carries `phase: string` and `deadline: number \| null`         |

`checkContract` returns a report (used by the engine's own "expected to fail" fixture
tests); `runContractSuite` registers one Vitest test per check.

#### ContractCheckName (type)

The checks of the contract suite.

```ts
export type ContractCheckName =
  "determinism" | "serialize" | "secrecy" | "termination" | "parseAction" | "illegal" | "views";
```

#### CONTRACT_CHECKS (const)

Every check, in report order.

```ts
const CONTRACT_CHECKS: readonly ContractCheckName[];
```

#### ContractOptions (interface)

Options for the contract suite.

```ts
export interface ContractOptions<S, O> {
  /** Seeds per player count: a count (`1..n`) or explicit seeds. Default 20. */
  seeds?: number | readonly number[];
  /** Player counts. Default min, typical and max from the manifest. */
  players?: readonly number[];
  /** Option presets to cycle through (each game uses one). Default: the defaults only. */
  presets?: readonly Partial<O>[];
  /** Games played for the secrecy fuzz (DOD G4: 200). */
  fuzzGames?: number;
  /** Garbage payloads for the parseAction fuzz (DOD G4: 1,000). */
  garbage?: number;
  /** Extra secret locations (SPEC §9.3 rule 4 `secretPaths`, JSONPath-lite). */
  secretPaths?: readonly string[];
  /** Runner steps per game before it counts as non-terminating. Default 10,000. */
  maxSteps?: number;
  /** Content for setup; a factory is called once per game. */
  content?: ContentAccess | (() => ContentAccess);
  /** Default 1. */
  timerScale?: RoomConfig["timerScale"];
  /** Default 3. */
  streamDelaySec?: number;
  /** Games compared for determinism (each is played twice). Default 12. */
  determinismGames?: number;
  /** States sampled for the parseAction / illegal / views checks. Default 400. */
  sampleStates?: number;
  /** Only run these checks. */
  checks?: readonly ContractCheckName[];
  /** Hooks passed through to the sim (involvement, direct audience actions…). */
  sim?: Pick<SimOptions<S, O>, "audienceAction" | "audienceDirectOpen" | "involves">;
  /** Vitest timeout per check (ms). Default 120,000. */
  timeoutMs?: number;
}
```

#### ContractCheck (interface)

The result of one check.

```ts
export interface ContractCheck {
  name: ContractCheckName;
  ok: boolean;
  /** Human-readable failures (the first few, with seeds and paths). */
  failures: string[];
  /** Counters: games, states, payloads… */
  stats: Record<string, number>;
}
```

#### ContractReport (interface)

The full contract report.

```ts
export interface ContractReport {
  game: string;
  ok: boolean;
  checks: ContractCheck[];
}
```

#### checkContract (function)

Runs the contract checks and returns a report. Never throws for a module failure: module
exceptions are reported as failures of the check that hit them.

```ts
export function checkContract<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: ContractOptions<S, O> = {},
): ContractReport;
```

#### runContractSuite (function)

Registers the contract suite with Vitest: one `describe` per module, one `it` per check,
each failing with the check's failure list.

```ts
export function runContractSuite<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: ContractOptions<S, O> = {},
): void;
```

#### plainJsonProblem (function)

Why `value` is not plain JSON (a path and a reason), or `null` when it is.

```ts
export function plainJsonProblem(value: unknown, path = "$"): string | null;
```

#### jsonDiff (function)

The first path where two JSON values differ, or `null` when they are deep-equal.

```ts
export function jsonDiff(a: unknown, b: unknown, path = "$"): string | null;
```

#### SecretValue (interface)

A hidden value found in state, with the viewer ids that own it.

```ts
export interface SecretValue {
  value: string | number;
  path: (string | number)[];
  owners: string[];
}
```

#### collectSecrets (function)

Collects the hidden values of a state (SPEC §9.3 rule 4): every string (length ≥ 3) and
number under a `secret` / `hidden` key or a `secretPaths` match. A value's **owners** are
the player/team ids on its path (as keys, or as the `id` / `playerId` / `ownerId` / `owner` /
`authorId` of an enclosing object). Strings that also appear outside hidden subtrees are
public (revealed) and are skipped.

```ts
export function collectSecrets(
  state: unknown,
  ids: ReadonlySet<string>,
  secretPaths: readonly string[] = [],
): SecretValue[];
```

#### allViewers (function)

The viewers the secrecy fuzz checks: every seat plus every shared viewer key.

```ts
export function allViewers(players: readonly PlayerId[]): ViewerKey[];
```

#### findLeaks (function)

The leaks in one state: for each viewer, hidden values it does not own that appear in its
view (strings verbatim in the serialized view; numbers at the same path). Values sent for
moderation (`moderate` effect previews) may appear in the host and moderator views.

```ts
export function findLeaks<S, V>(
  module: Pick<GameModule<S, unknown, unknown, V>, "view">,
  state: S,
  players: readonly { id: PlayerId; teamId?: string }[],
  opts: {
    teams?: readonly string[];
    secretPaths?: readonly string[];
    moderated?: ReadonlySet<string>;
  } = {},
): string[];
```

#### garbagePayload (function)

A random JSON-ish payload (numbers, strings, nested objects/arrays, odd keys, huge values).

```ts
export function garbagePayload(rng: Rng, depth = 0, seedActions: readonly unknown[] = []): unknown;
```

### `src/testing/fake-content.ts`

`fakeContent`: an in-memory {@link ContentAccess} built from content-pack fixtures, for game
tests, sims and scenarios (SPEC §9.3 `SetupContext.content`, §12). Packs are validated
against the real pack schemas by default, so a fixture cannot drift from what the server
would load.

#### FakeContentOptions (interface)

Options for {@link fakeContent}.

```ts
export interface FakeContentOptions {
  /** Content keys already used earlier in the session, per kind (see `contentKey`). */
  used?: Partial<Record<PackKind, readonly string[]>>;
  /** Validate every pack with its zod schema (default true). */
  validate?: boolean;
}
```

#### FakeContent (interface)

A {@link ContentAccess} whose "used" set can be changed by tests.

```ts
export interface FakeContent extends ContentAccess {
  /** Marks a content key as used (as the room would after a game). */
  markUsed(kind: PackKind, key: string): void;
}
```

#### fakeContent (function)

Builds a content access over `packs`.

- `@throws` Error when a pack fails its schema (with the zod issues) or two packs share an id.

```ts
export function fakeContent(packs: readonly AnyPack[], opts: FakeContentOptions = {}): FakeContent;
```

#### markAllUsed (function)

Marks every item of `items` used, by its {@link contentKey}.

```ts
export function markAllUsed<K extends PackKind>(
  content: FakeContent,
  kind: K,
  items: readonly PackItemMap[K][],
): void;
```

### `src/testing/run-script.ts`

`runScript`: drive a game module through a scripted sequence on a real {@link GameRunner}
with a virtual clock. It is how game rule tests (G3) read: "p1 answers, 3 s pass, the timer
fires, the audience result arrives, expect…", with every step checked and traced.

```ts
const { runner } = runScript(logic, [
  { timer: "intro" },
  { act: "p1", action: { type: "move", cell: 4 } },
  { act: "p1", action: { type: "move", cell: 0 }, expect: "illegal" },
  { check: ({ state }) => expect(state.moves).toBe(1) },
], { players: 2, seed: 7 });
```

#### makeSeats (function)

Seats `p1..pN` named "Player 1..N", colour slots `0..N-1`, optionally dealt into teams.

```ts
export function makeSeats(count: number, opts: { teams?: readonly string[] } = {}): Seat[];
```

#### ActExpectation (type)

What an `act` step expects: success, a specific refusal, or anything.

```ts
export type ActExpectation = "ok" | RunnerError | "any";
```

#### ScriptStep (type)

One scripted step. Times are ms relative to the script start (virtual clock).

```ts
export type ScriptStep<S, A> =
  | {
      act: PlayerId;
      /** A typed action, or any raw payload (it goes through `parseAction`). */
      action: A | unknown;
      role?: ActionCtx["actor"]["role"];
      /** Default "ok". */
      expect?: ActExpectation;
    }
  | { wait: number }
  | { at: number }
  | { timer: string }
  | { next: true }
  | { host: GameHostCommand; expect?: ActExpectation }
  | { audience: PollResult }
  | { enroll: { audId: AudId; name: string; skin: number }[] }
  | { audienceAction: { audId: AudId; action: unknown } }
  | { moderate: { itemId: string; approved: boolean } }
  | { leave: PlayerId }
  | { rejoin: PlayerId }
  | { bot: PlayerId; on?: boolean }
  | { pause: true }
  | { resume: true }
  | { check: (ctx: ScriptCheckCtx<S, A>) => void };
```

#### ScriptCheckCtx (interface)

Passed to `check` steps.

```ts
export interface ScriptCheckCtx<S, A> {
  state: S;
  runner: GameRunner<S, A, unknown, unknown>;
  /** Virtual ms since the script started. */
  elapsed: number;
  /** Every effect so far, in order. */
  effects: readonly Effect[];
  /** The effects of the previous step. */
  last: readonly Effect[];
}
```

#### ScriptOptions (interface)

Script options: runner options with friendlier defaults.

```ts
export interface ScriptOptions<O> extends Partial<Omit<RunnerOptions<O>, "players">> {
  /** A seat count (see {@link makeSeats}) or explicit seats. Default: the manifest minimum. */
  players?: number | readonly Seat[];
}
```

#### ScriptTraceEntry (interface)

One traced step.

```ts
export interface ScriptTraceEntry<S, A> {
  index: number;
  step: ScriptStep<S, A>;
  /** Virtual ms since start, after the step. */
  elapsed: number;
  result: RunnerResult;
}
```

#### ScriptRun (interface)

The outcome of {@link runScript}.

```ts
export interface ScriptRun<S, A, O, V> {
  runner: GameRunner<S, A, O, V>;
  state: S;
  /** Every effect (setup included), in order. */
  effects: Effect[];
  trace: ScriptTraceEntry<S, A>[];
  /** Virtual ms since start at the end of the script. */
  elapsed: number;
}
```

#### SCRIPT_EPOCH (const)

The script start time used when `now` is not given.

```ts
const SCRIPT_EPOCH: 1000000;
```

#### runScript (function)

Runs `script` against a fresh runner (dev mode, `botDelayMs` 0 unless given).

- `@throws` Error naming the step index when a step's expectation fails, a `timer` step names a
timer that is not pending, or a `check` throws.

```ts
export function runScript<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  script: readonly ScriptStep<S, A>[],
  opts: ScriptOptions<O> = {},
): ScriptRun<S, A, O, V>;
```

### `src/testing/sim.ts`

The sim runner (ROADMAP M0-04, DOD G5/G14): plays whole games on a real {@link GameRunner}
against a **virtual clock**, with

- the **timed bot model**: every seat is a bot that acts at a random point between 25% and
  70% of its input window (never instantly), through the wire (`JSON` round trip +
  `parseAction`);
- a simulated **audience** of 50 bots that answers every open poll, joins every enrolment,
  and (with a hook) sends direct actions: a stand-in for the platform AudienceAggregator;
- a **timeline** of phases, open audience interactions and per-player input windows, from
  which the **pacing report** is computed: `{ durationMs, audienceIdleMaxMs,
  playerIdleMaxMs, timeline }`.

{@link pacingReport} replays many seeded games per player count and {@link checkPacing}
applies the G14 limits (median duration within `estMinutes`, p90 ≤ upper × 1.25, audience
idle ≤ 30 s, player idle ≤ 45 s, excluding the declared `intro` / `final` phases).

#### TimelineEntry (type)

One stretch on the sim timeline (virtual ms since the game started).

```ts
export type TimelineEntry =
  | { kind: "phase"; phase: string; startMs: number; endMs: number }
  | {
      kind: "audience";
      what: "poll" | "enroll" | "direct";
      id: string;
      pollKind?: PollSpec["kind"];
      startMs: number;
      endMs: number;
    }
  | { kind: "input"; playerId: PlayerId; startMs: number; endMs: number }
  | { kind: "involved"; playerId: PlayerId; startMs: number; endMs: number };
```

#### SimStepInfo (interface)

What `onStep` receives after every sim event.

```ts
export interface SimStepInfo<S> {
  state: S;
  /** Virtual ms since start. */
  elapsed: number;
  effects: readonly Effect[];
  runner: GameRunner<S, unknown, unknown, unknown>;
}
```

#### ActionPolicy (type)

How seats choose actions: the module's `bot()` (default), or half bot / half random legal.

```ts
export type ActionPolicy = "bot" | "mixed";
```

#### SimOptions (interface)

Options for {@link simulateGame}.

```ts
export interface SimOptions<S, O> {
  seed: number | string;
  /** Seat count or explicit seats. */
  players: number | readonly Seat[];
  options?: Partial<O>;
  /** Default 1 (the room default). */
  timerScale?: RoomConfig["timerScale"];
  /** Default 3. */
  streamDelaySec?: number;
  /** A content access, or a factory called once per game (fresh "used" state). */
  content?: ContentAccess | (() => ContentAccess);
  /** Simulated audience size. Default 50. */
  audienceBots?: number;
  /** Fraction of the input window at which a bot acts: `[min, max]`. Default `[0.25, 0.7]`. */
  botWindow?: readonly [number, number];
  /** Window length for an input with no deadline (timerScale 0, untimed phases). Default 10 s. */
  defaultWindowMs?: number;
  /** A bot never acts sooner than this after its window opens. Default 250 ms. */
  minReactionMs?: number;
  /** Runner steps before the game counts as runaway. Default 10,000. */
  maxSteps?: number;
  /** Virtual time before the game counts as runaway. Default 4 h. */
  maxDurationMs?: number;
  /** Phases excluded from the idle checks (G14). Default `["intro", "final"]`. */
  excludePhases?: readonly string[];
  /**
   * With nothing scheduled, the simulated host sends `forceAdvance` after `hostAdvanceMs`.
   * Default: only when `timerScale` is 0 (no input timers, the host advances). With timers on,
   * a game that waits for the host counts as stalled.
   */
  hostAdvance?: boolean;
  /** Default 5 s. */
  hostAdvanceMs?: number;
  /** Seat policy. Default "bot". */
  policy?: ActionPolicy;
  /** A reveal involving this player's own content is on screen (counts against player idle). */
  involves?: (state: S, player: PlayerId) => boolean;
  /** Direct audience actions are open (counts as an audience interaction). */
  audienceDirectOpen?: (state: S) => boolean;
  /** A direct action for one audience bot (only used while `audienceDirectOpen`). */
  audienceAction?: (state: S, audId: AudId, rng: Rng) => unknown;
  /** Called after every sim event, e.g. to assert spec invariants (G5). */
  onStep?: (info: SimStepInfo<S>) => void;
  /** Runner dev mode (deep-freeze). Default true. */
  dev?: boolean;
  /** Record per-event state hashes (for determinism diffs). Default false. */
  recordHashes?: boolean;
}
```

#### SimResult (interface)

The outcome of one simulated game.

```ts
export interface SimResult<S> {
  seed: number | string;
  players: number;
  /** True when the game emitted `end`. */
  ended: boolean;
  /** Why the game did not end (`maxSteps`, `maxDuration`, `stalled`), when it did not. */
  failure?: string;
  result: GameResult | null;
  /** Virtual ms from setup to `end` (or to the failure). */
  durationMs: number;
  /** Longest stretch with no open audience interaction, excluding `excludePhases`. */
  audienceIdleMaxMs: number;
  /** Longest stretch any player had no input and no involvement, excluding `excludePhases`. */
  playerIdleMaxMs: number;
  timeline: TimelineEntry[];
  steps: number;
  /** Seat actions applied. */
  actions: number;
  /** Seat actions the module refused (bots should produce none). */
  illegalActions: number;
  /** Details of the first few refused seat actions. */
  illegalSamples: string[];
  /** Polls the sim audience answered. */
  polls: number;
  /** FNV-1a hash over every event's state and effects: equal runs have equal fingerprints. */
  fingerprint: string;
  /** Per-event hashes (only with `recordHashes`). */
  hashes: string[];
  finalState: S;
}
```

#### simulateGame (function)

Plays one game to its end with timed bots and a simulated audience.

```ts
export function simulateGame<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: SimOptions<S, O>,
): SimResult<S>;
```

#### pollResult (function)

A plausible aggregate result for a poll answered by the sim audience (SPEC §4 shapes):
option tallies for vote/predict/quiz, a 50-bin histogram and mean for dial, correct counts
and the first 3 names for guess, a tap total for tap.

```ts
export function pollResult(spec: PollSpec, audience: readonly AudId[], rng: Rng): PollResult;
```

#### longestGap (function)

Merges intervals and returns the longest uncovered stretch of `[0, span]`.

```ts
export function longestGap(intervals: readonly Interval[], span: number): number;
```

#### PacingOptions (interface)

Options for {@link pacingReport}.

```ts
export interface PacingOptions<S, O> extends Omit<SimOptions<S, O>, "seed" | "players"> {
  /** Seeds per player count: a count (`1..n`) or explicit seeds. Default 50. */
  seeds?: number | readonly number[];
  /** Player counts. Default: min, typical (rounded mean) and max from the manifest. */
  players?: readonly number[];
}
```

#### PacingGame (interface)

One game's line in the pacing report.

```ts
export interface PacingGame {
  seed: number;
  players: number;
  ended: boolean;
  failure?: string;
  durationMs: number;
  audienceIdleMaxMs: number;
  playerIdleMaxMs: number;
}
```

#### PacingGroup (interface)

Aggregates for one player count.

```ts
export interface PacingGroup {
  players: number;
  games: number;
  medianMs: number;
  p90Ms: number;
  audienceIdleMaxMs: number;
  playerIdleMaxMs: number;
}
```

#### PacingReport (interface)

The G14 pacing report (`artifacts/verify/<id>-pacing.json`).

```ts
export interface PacingReport {
  game: string;
  estMinutes: [number, number];
  games: PacingGame[];
  groups: PacingGroup[];
  /** Worst values over every game. */
  durationMs: number;
  audienceIdleMaxMs: number;
  playerIdleMaxMs: number;
  /** The timeline of the game with the worst audience or player idle gap. */
  timeline: TimelineEntry[];
}
```

#### defaultPlayerCounts (function)

The default player counts for pacing and contract runs: min, typical and max.

```ts
export function defaultPlayerCounts(manifest: {
  minPlayers: number;
  maxPlayers: number;
}): number[];
```

#### seedList (function)

The seed list for a count or an explicit list.

```ts
export function seedList(seeds: number | readonly number[]): number[];
```

#### quantile (function)

The q-quantile (nearest rank) of `values`.

```ts
export function quantile(values: readonly number[], q: number): number;
```

#### pacingReport (function)

Replays seeded games for each player count with the timed bot model and summarises pacing.

```ts
export function pacingReport<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: PacingOptions<S, O> = {},
): PacingReport;
```

#### PacingLimits (interface)

The G14 limits; every field has the DoD default.

```ts
export interface PacingLimits {
  /** Session range; default the manifest's `estMinutes`. */
  estMinutes?: readonly [number, number];
  /** Default 1.25. */
  p90Factor?: number;
  /** Default 30 s. */
  audienceIdleMaxMs?: number;
  /** Default 45 s (a spec may declare a longer exception with a reason). */
  playerIdleMaxMs?: number;
  /** Skip the duration check (e.g. a preset excluded from G14's duration check). */
  skipDuration?: boolean;
}
```

#### PacingVerdict (interface)

The verdict of {@link checkPacing}.

```ts
export interface PacingVerdict {
  ok: boolean;
  failures: string[];
  checks: { duration: boolean; audienceIdle: boolean; playerIdle: boolean; ended: boolean };
}
```

#### checkPacing (function)

Applies the G14 limits to a pacing report.

```ts
export function checkPacing(report: PacingReport, limits: PacingLimits = {}): PacingVerdict;
```
