/**
 * `GameRunner` (SPEC §9.5, ROADMAP M0-04): the pure runtime that drives one game module.
 *
 * It owns everything around the module's reducers, and nothing about sockets:
 * - calls `setup` / `onAction` / `onTimer` / `onTick` / `onAudience*` / `onModeration` /
 *   `onPlayerLeave` / `onPlayerRejoin` / `onHostCommand` with a correct `ctx`;
 * - applies effects: keeps the **timer table** (`timer.set` / `timer.clear`), **aggregates
 *   `score`** deltas, records **`end`**, and hands every other effect to the host (the room);
 * - enforces the **minimum audience window** (SPEC §4): an early `audience.close` of a timed
 *   poll is held until `openedAt + streamDelaySec + 5 s` (event-closed polls are exempt);
 * - **takes over a disconnected seat** by calling `bot()` after `botDelayMs`;
 * - **deep-freezes state in dev** (every step for `tickHz` 0/10/20, every 60th for 60) so a
 *   module that mutates its state throws at once;
 * - **computes views per distinct viewer key**, memoised per step (5,000 audience members cost
 *   one `view()` call);
 * - **pause** freezes every timer and **resume** re-arms it with the same remaining time.
 *
 * Time. The runner never reads a clock: every call takes the host's `now` (server ms). The
 * module sees a *game clock* that excludes paused time, so remaining input time survives a
 * pause exactly. The runner translates back to server time at its edges: `view().deadline`
 * (the top-level field every view carries, SPEC §9.3 rule 3) and the `closesAtMs` of emitted
 * `audience.open` / `audience.enroll` effects. Timers fire with `ctx.now` equal to their own
 * `atMs` (or the current time, for a timer set in the past), so results never depend on how
 * often the host calls {@link GameRunner.advance}.
 *
 * @module
 */
import {
  createRng,
  DEFAULT_ROOM_CONFIG,
  rngFrom,
  type AudId,
  type GameId,
  type PlayerId,
  type Rng,
  type RngState,
  type RoomConfig,
} from "@sg/shared";
import {
  EMPTY_CONTENT,
  resolveOptions,
  type ActionCtx,
  type ContentAccess,
  type Ctx,
  type Effect,
  type GameHostCommand,
  type GameModule,
  type GameResult,
  type PollResult,
  type PollSpec,
  type Seat,
  type SetupContext,
  type Step,
  type Timing,
  type ViewerKey,
} from "./game-module.ts";
import { createTiming, minAudienceWindowMs, type TimingConfig } from "./timing.ts";

/** Why a runner call was refused. The room maps these onto protocol `ErrorCode`s. */
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

/** The outcome of one runner call. */
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

/** A pending timer, in server time. */
export interface RunnerTimer {
  id: string;
  atMs: number;
  remainingMs: number;
}

/** An audience poll the module opened and the runner has not yet seen close. */
export interface OpenPoll {
  spec: PollSpec;
  /** Server ms when the poll opened. */
  openedAtMs: number;
  /** True while an early close is being held by the minimum audience window. */
  closing: boolean;
}

/** Counters for tests and the server's perf gates. */
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

/** How a runner is started. */
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

/** Default takeover-bot thinking time: long enough to read on stream, short enough to flow. */
export const DEFAULT_BOT_DELAY_MS = 1_200;

/** A guard against modules that schedule timers forever at the same instant. */
const MAX_EVENTS_PER_CALL = 200_000;

/** The JSON form of a running game, for Store snapshots and crash recovery (SPEC §9.5). */
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

/**
 * The stable string for a viewer key: views are memoised and fanned out per distinct key
 * (`player:<id>`, `audience`, `audience:restricted`, `stage`, `host`, `moderator`).
 */
export function viewerKeyId(viewer: ViewerKey): string {
  switch (viewer.role) {
    case "player":
      return `player:${viewer.id}`;
    case "audience":
      return viewer.restricted === true ? "audience:restricted" : "audience";
    default:
      return viewer.role;
  }
}

/**
 * Recursively freezes a plain JSON value in place and returns it. Already-frozen subtrees are
 * skipped, so re-freezing a state that shares structure with the last one is cheap.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

interface TimerEntry {
  at: number;
  seq: number;
}
interface DeferredEntry {
  at: number;
  seq: number;
  effect: Effect;
}
interface PollEntry {
  openedAt: number;
  spec: PollSpec;
}

type Due =
  | { kind: "deferred"; at: number; index: number }
  | { kind: "timer"; at: number; id: string }
  | { kind: "bot"; at: number; id: PlayerId }
  | { kind: "tick"; at: number };

const RESTORE: unique symbol = Symbol("GameRunner.restore");
interface RestoreOptions {
  [RESTORE]?: RunnerSnapshot;
}

/**
 * Drives one game module. See the module docs for the full behaviour; every mutating call
 * first fires whatever fell due before `now`, then does its work, then fires anything that is
 * due at once (a zero-delay bot, a timer set in the past).
 *
 * @typeParam S - module state
 * @typeParam A - parsed action
 * @typeParam O - options
 * @typeParam V - view
 */
export class GameRunner<S, A, O, V> {
  /** The module being run. */
  readonly module: GameModule<S, A, O, V>;
  /** Effects `setup` produced (timers already applied), for the host to route once. */
  readonly setupEffects: readonly Effect[];
  /** The resolved options the module was set up with. */
  readonly options: O;

  #state: S;
  readonly #players: Seat[];
  readonly #teams: SetupContext<O>["teams"];
  readonly #seatIds: ReadonlySet<PlayerId>;
  readonly #rng: Rng;
  readonly #botRng: Rng;
  readonly #dev: boolean;
  readonly #freezeEvery: number;
  readonly #botDelayMs: number;
  readonly #tickMs: number;
  #timingConfig: TimingConfig;
  #timing: Timing;
  #audienceCount: number;

  #clock: number;
  #offset = 0;
  #pausedAt: number | null = null;
  #seq = 0;
  readonly #timers = new Map<string, TimerEntry>();
  #deferred: DeferredEntry[] = [];
  readonly #openPolls = new Map<string, PollEntry>();
  readonly #bots = new Map<PlayerId, number | null>();
  #nextTick: number | null = null;
  readonly #scores: Record<string, number> = {};
  #result: GameResult | null = null;
  readonly #views = new Map<string, V>();
  readonly #stats: RunnerStats = { steps: 0, viewCalls: 0, botActions: 0, botIllegal: 0 };
  #out: Effect[] = [];

  /**
   * Validates the seats, resolves options and runs `setup`.
   *
   * @throws RangeError when the player count is outside the manifest's range, seat ids repeat,
   *   or the timing config is invalid.
   */
  constructor(module: GameModule<S, A, O, V>, opts: RunnerOptions<O>) {
    this.module = module;
    const snapshot = (opts as RunnerOptions<O> & RestoreOptions)[RESTORE];
    const { manifest } = module;
    const players = (snapshot?.players ?? opts.players).map((p) => ({ ...p }));
    const ids = new Set(players.map((p) => p.id));
    if (ids.size !== players.length) throw new RangeError("GameRunner: seat ids must be unique");
    if (players.length < manifest.minPlayers || players.length > manifest.maxPlayers) {
      throw new RangeError(
        `GameRunner: ${manifest.id} takes ${manifest.minPlayers}-${manifest.maxPlayers} players, got ${players.length}`,
      );
    }
    this.#players = players;
    this.#seatIds = ids;
    this.#teams = (snapshot?.teams ?? opts.teams ?? []).map((t) => ({ ...t }));
    this.#dev = opts.dev ?? true;
    this.#freezeEvery = manifest.tickHz === 60 ? 60 : 1;
    this.#botDelayMs = Math.max(0, opts.botDelayMs ?? DEFAULT_BOT_DELAY_MS);
    this.#tickMs = manifest.tickHz > 0 ? 1000 / manifest.tickHz : 0;
    this.#timingConfig = {
      timerScale: snapshot?.timerScale ?? opts.timerScale ?? DEFAULT_ROOM_CONFIG.timerScale,
      streamDelaySec:
        snapshot?.streamDelaySec ?? opts.streamDelaySec ?? DEFAULT_ROOM_CONFIG.streamDelaySec,
    };
    this.#timing = createTiming(this.#timingConfig);
    this.#audienceCount = snapshot?.audienceCount ?? opts.audienceCount ?? 0;
    this.options = resolveOptions(
      module.optionSpecs,
      (snapshot?.options ?? opts.options ?? {}) as Record<string, unknown>,
    ) as O;

    if (snapshot !== undefined) {
      if (snapshot.v !== 1 || snapshot.game !== manifest.id) {
        throw new TypeError(`GameRunner.restore: snapshot is not a v1 ${manifest.id} snapshot`);
      }
      this.#state = module.deserialize(snapshot.state);
      this.#rng = rngFrom(snapshot.rng);
      this.#botRng = rngFrom(snapshot.botRng);
      this.#clock = snapshot.clock;
      this.#offset = snapshot.offset;
      this.#pausedAt = snapshot.pausedAt;
      this.#seq = snapshot.seq;
      for (const t of snapshot.timers) this.#timers.set(t.id, { at: t.at, seq: t.seq });
      this.#deferred = snapshot.deferred.map((d) => ({ ...d }));
      for (const p of snapshot.openPolls) this.#openPolls.set(p.spec.pollId, { ...p });
      for (const b of snapshot.bots) this.#bots.set(b.id, b.at);
      this.#nextTick = snapshot.nextTick;
      Object.assign(this.#scores, snapshot.scores);
      this.#result = snapshot.result;
      this.#stats.steps = snapshot.steps;
      if (this.#dev) deepFreeze(this.#state);
      this.setupEffects = [];
      return;
    }

    const rng = createRng(opts.seed);
    this.#botRng = rng.fork("bots");
    this.#rng = rng;
    this.#clock = opts.now;
    const step = module.setup({
      players: this.#players.map((p) => ({ ...p })),
      teams: this.#teams.map((t) => ({ ...t })),
      options: this.options,
      rng: this.#rng,
      now: this.#clock,
      timing: this.#timing,
      content: opts.content ?? EMPTY_CONTENT,
      audienceCount: this.#audienceCount,
    });
    this.#state = undefined as S;
    this.#commit(step, "setup", true);
    if (this.#tickMs > 0 && this.#result === null) this.#nextTick = this.#clock + this.#tickMs;
    this.#runDue(this.#clock);
    this.setupEffects = this.#take();
  }

  /**
   * Rebuilds a runner from {@link GameRunner.snapshot}, without calling `setup`. The restored
   * runner continues exactly where the original was (same rng streams, timers, holds).
   */
  static restore<S, A, O, V>(
    module: GameModule<S, A, O, V>,
    snapshot: RunnerSnapshot,
    opts: Pick<RunnerOptions<O>, "content" | "dev" | "botDelayMs"> = {},
  ): GameRunner<S, A, O, V> {
    const restoreOpts: RunnerOptions<O> & RestoreOptions = {
      ...opts,
      players: snapshot.players,
      seed: 0,
      now: snapshot.clock + snapshot.offset,
      [RESTORE]: snapshot,
    };
    return new GameRunner(module, restoreOpts);
  }

  // ---- Read access ---------------------------------------------------------------------------

  /** The current module state (deep-frozen in dev). */
  get state(): S {
    return this.#state;
  }

  /** The game result once `end` was emitted, else `null`. */
  get result(): GameResult | null {
    return this.#result;
  }

  /** True once the module emitted `end`. */
  get ended(): boolean {
    return this.#result !== null;
  }

  /** True between {@link GameRunner.pause} and {@link GameRunner.resume}. */
  get paused(): boolean {
    return this.#pausedAt !== null;
  }

  /** The aggregated `score` deltas so far (PlayerId | TeamId → points). */
  get scores(): Readonly<Record<string, number>> {
    return { ...this.#scores };
  }

  /** The runner's clock in server ms (the latest time it has processed). */
  get now(): number {
    return this.#pausedAt ?? this.#clock + this.#offset;
  }

  /** The game clock (server time minus paused time): what the module sees as `ctx.now`. */
  get gameNow(): number {
    return this.#clock;
  }

  /** The seats this game runs with. */
  get players(): readonly Seat[] {
    return this.#players;
  }

  /** The room timing currently applied (`timerScale`, `streamDelaySec`). */
  get timing(): Readonly<TimingConfig> {
    return { ...this.#timingConfig };
  }

  /** Counters: steps, view calls, bot actions. */
  get stats(): Readonly<RunnerStats> {
    return { ...this.#stats };
  }

  /** Pending module timers in server time, soonest first. */
  timers(): RunnerTimer[] {
    const now = this.#clock;
    return [...this.#timers.entries()]
      .sort((a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq)
      .map(([id, t]) => ({
        id,
        atMs: t.at + this.#offset,
        remainingMs: Math.max(0, t.at - now),
      }));
  }

  /** Audience polls that are open (or being held open by the minimum window). */
  openPolls(): OpenPoll[] {
    const closing = new Set(this.#heldPolls());
    return [...this.#openPolls.values()].map((p) => ({
      spec: this.#translatePoll(p.spec),
      openedAtMs: p.openedAt + this.#offset,
      closing: closing.has(p.spec.pollId),
    }));
  }

  /** Whether a takeover bot plays this seat. */
  isBot(id: PlayerId): boolean {
    return this.#bots.has(id);
  }

  /**
   * The server time of the next thing the runner will do by itself (a timer, a held audience
   * close, a bot move or a tick), or `null`. Hosts schedule one wake-up for it and then call
   * {@link GameRunner.advance}. Always `null` while paused.
   */
  nextEventAt(): number | null {
    if (this.#pausedAt !== null) return null;
    const due = this.#nextDue();
    return due === null ? null : Math.max(due.at, this.#clock) + this.#offset;
  }

  /**
   * The view for one viewer, memoised per step and per distinct viewer key. The top-level
   * `deadline` is translated from game time to server time.
   */
  view(viewer: ViewerKey): V {
    const key = viewerKeyId(viewer);
    const cached = this.#views.get(key);
    if (cached !== undefined) return cached;
    this.#stats.viewCalls++;
    let view = this.module.view(this.#state, viewer);
    if (this.#offset !== 0 && isRecord(view) && typeof view["deadline"] === "number") {
      view = { ...view, deadline: view["deadline"] + this.#offset } as V;
    }
    this.#views.set(key, view);
    return view;
  }

  // ---- Inputs -------------------------------------------------------------------------------

  /**
   * A game action from a seat (or the host / a moderator). Parses it with `parseAction`,
   * then calls `onAction`. Refused while paused.
   */
  act(
    actorId: PlayerId,
    raw: unknown,
    now: number,
    role: ActionCtx["actor"]["role"] = "player",
  ): RunnerResult {
    if (this.#pausedAt !== null) return this.#refuse("PAUSED");
    this.#advanceTo(now);
    if (this.#result !== null) return this.#refuse("ENDED");
    if (role === "player" && !this.#seatIds.has(actorId)) return this.#refuse("NOT_SEATED");
    const action = this.module.parseAction(raw);
    if (action === null) return this.#refuse("BAD_ACTION");
    const ok = this.#applyAction(actorId, action, role);
    this.#runDue(this.#clock);
    return ok ? this.#done() : this.#refuse("ILLEGAL");
  }

  /** A host game command (`forceAdvance`, `skipItem`). Refused while paused. */
  hostCommand(cmd: GameHostCommand, now: number): RunnerResult {
    if (this.#pausedAt !== null) return this.#refuse("PAUSED");
    this.#advanceTo(now);
    if (this.#result !== null) return this.#refuse("ENDED");
    const hook = this.module.onHostCommand;
    if (hook === undefined) return this.#refuse("UNSUPPORTED");
    this.#commit(hook.call(this.module, this.#state, cmd, this.#ctx()), "onHostCommand");
    this.#runDue(this.#clock);
    return this.#done();
  }

  /**
   * The aggregate result of a closed poll (from the AudienceAggregator). Accepted while
   * paused: it is applied at the frozen game time.
   */
  audienceResult(result: PollResult, now: number): RunnerResult {
    return this.#platformEvent(now, "onAudienceResult", (ctx) => {
      this.#openPolls.delete(result.pollId);
      return this.module.onAudienceResult?.(this.#state, result, ctx);
    });
  }

  /** Audience entrants when an enrolment closes (Marble Rally). */
  audienceEnroll(
    entrants: { audId: AudId; name: string; skin: number }[],
    now: number,
  ): RunnerResult {
    return this.#platformEvent(now, "onAudienceEnroll", (ctx) =>
      this.module.onAudienceEnroll?.(this.#state, entrants, ctx),
    );
  }

  /** One direct audience action (`manifest.audience.direct`), already rate-limited. */
  audienceAction(audId: AudId, action: unknown, now: number): RunnerResult {
    return this.#platformEvent(now, "onAudienceAction", (ctx) =>
      this.module.onAudienceAction?.(this.#state, audId, action, ctx),
    );
  }

  /** A moderation decision for an item the module sent with a `moderate` effect. */
  moderation(itemId: string, approved: boolean, now: number): RunnerResult {
    return this.#platformEvent(now, "onModeration", (ctx) =>
      this.module.onModeration?.(this.#state, itemId, approved, ctx),
    );
  }

  /** A seated player disconnected (the room decides when a bot takes over: {@link setBot}). */
  playerLeave(id: PlayerId, now: number): RunnerResult {
    if (!this.#seatIds.has(id)) return this.#refuse("NOT_SEATED");
    return this.#platformEvent(now, "onPlayerLeave", (ctx) =>
      this.module.onPlayerLeave?.(this.#state, id, ctx),
    );
  }

  /** A seated player came back: calls `onPlayerRejoin` and ends any bot takeover. */
  playerRejoin(id: PlayerId, now: number): RunnerResult {
    if (!this.#seatIds.has(id)) return this.#refuse("NOT_SEATED");
    this.#bots.delete(id);
    return this.#platformEvent(now, "onPlayerRejoin", (ctx) =>
      this.module.onPlayerRejoin?.(this.#state, id, ctx),
    );
  }

  /**
   * Starts or stops a bot takeover for a seat. While on, the runner calls `bot()` for that
   * seat `botDelayMs` after every state change and applies whatever it returns.
   */
  setBot(id: PlayerId, on: boolean, now: number): RunnerResult {
    if (!this.#seatIds.has(id)) return this.#refuse("NOT_SEATED");
    if (this.#pausedAt === null) this.#advanceTo(now);
    if (!on) {
      this.#bots.delete(id);
      return this.#done();
    }
    if (!this.#bots.has(id)) {
      this.#bots.set(id, this.#result === null ? this.#clock + this.#botDelayMs : null);
    }
    if (this.#pausedAt === null) this.#runDue(this.#clock);
    return this.#done();
  }

  /** Fires everything due up to `now`: timers, held audience closes, bot moves, ticks. */
  advance(now: number): RunnerResult {
    if (this.#pausedAt === null) this.#advanceTo(now);
    return this.#done();
  }

  /**
   * Pauses the game (BRB). Every timer, held close, bot move and tick freezes with its
   * remaining time; nothing fires until {@link resume}.
   */
  pause(now: number): RunnerResult {
    if (this.#pausedAt !== null) return this.#done();
    this.#advanceTo(now);
    this.#pausedAt = this.#clock + this.#offset;
    return this.#done();
  }

  /** Resumes after {@link pause}: every frozen timer is re-armed with its remaining time. */
  resume(now: number): RunnerResult {
    const pausedAt = this.#pausedAt;
    if (pausedAt === null) return this.#done();
    this.#pausedAt = null;
    this.#offset += Math.max(0, now - pausedAt);
    this.#views.clear(); // the deadline translation changed
    return this.#done();
  }

  /** Changes the room's timing for future steps (host changed `timerScale` / stream delay). */
  setTiming(config: TimingConfig): void {
    this.#timing = createTiming(config);
    this.#timingConfig = { ...config };
  }

  /** Updates `ctx.audienceCount` for future steps. */
  setAudienceCount(count: number): void {
    this.#audienceCount = Math.max(0, Math.floor(count));
  }

  /** A JSON-safe snapshot of everything needed to continue this game later. */
  snapshot(): RunnerSnapshot {
    return {
      v: 1,
      game: this.module.manifest.id,
      version: this.module.manifest.version,
      state: this.module.serialize(this.#state),
      rng: this.#rng.state(),
      botRng: this.#botRng.state(),
      clock: this.#clock,
      offset: this.#offset,
      pausedAt: this.#pausedAt,
      seq: this.#seq,
      timers: [...this.#timers.entries()].map(([id, t]) => ({ id, at: t.at, seq: t.seq })),
      deferred: this.#deferred.map((d) => ({ ...d })),
      openPolls: [...this.#openPolls.values()].map((p) => ({ ...p })),
      bots: [...this.#bots.entries()].map(([id, at]) => ({ id, at })),
      nextTick: this.#nextTick,
      scores: { ...this.#scores },
      result: this.#result,
      steps: this.#stats.steps,
      players: this.#players.map((p) => ({ ...p })),
      teams: this.#teams.map((t) => ({ ...t })),
      timerScale: this.#timingConfig.timerScale,
      streamDelaySec: this.#timingConfig.streamDelaySec,
      audienceCount: this.#audienceCount,
      options: this.options,
    };
  }

  // ---- Internals ----------------------------------------------------------------------------

  #ctx(): Ctx {
    return {
      rng: this.#rng,
      now: this.#clock,
      timing: this.#timing,
      audienceCount: this.#audienceCount,
    };
  }

  #platformEvent(now: number, hook: string, call: (ctx: Ctx) => Step<S> | undefined): RunnerResult {
    if (this.#pausedAt === null) this.#advanceTo(now);
    if (this.#result !== null) return this.#refuse("ENDED");
    const step = call(this.#ctx());
    if (step !== undefined) this.#commit(step, hook);
    if (this.#pausedAt === null) this.#runDue(this.#clock);
    return this.#done();
  }

  /** Applies an already-parsed action; returns false when the module rejected it. */
  #applyAction(actorId: PlayerId, action: A, role: ActionCtx["actor"]["role"]): boolean {
    const seat = this.#players.find((p) => p.id === actorId);
    const actor: ActionCtx["actor"] =
      seat?.teamId !== undefined
        ? { id: actorId, role, teamId: seat.teamId }
        : { id: actorId, role };
    const prev = this.#state;
    const step = this.module.onAction(prev, action, { ...this.#ctx(), actor });
    const illegal =
      step.state === prev ||
      (step.effects ?? []).some((e) => e.type === "fx" && e.name === "illegal");
    this.#commit(step, "onAction");
    return !illegal;
  }

  /** Applies a reducer result: new state, freeze, memo reset, effects. */
  #commit(step: Step<S>, hook: string, first = false): void {
    if (typeof step !== "object" || step === null || !("state" in step)) {
      throw new TypeError(`${this.module.manifest.id}.${hook} must return a Step ({ state })`);
    }
    const changed = first || step.state !== this.#state;
    this.#state = step.state;
    this.#stats.steps++;
    if (this.#dev && this.#stats.steps % this.#freezeEvery === 0) deepFreeze(this.#state);
    if (changed) this.#views.clear();
    for (const effect of step.effects ?? []) this.#effect(effect);
    if (changed && this.#result === null) {
      for (const [id, at] of this.#bots) {
        if (at === null) this.#bots.set(id, this.#clock + this.#botDelayMs);
      }
    }
  }

  #effect(effect: Effect): void {
    switch (effect.type) {
      case "timer.set":
        if (this.#result === null) {
          this.#timers.set(effect.id, { at: effect.atMs, seq: this.#seq++ });
        }
        return;
      case "timer.clear":
        this.#timers.delete(effect.id);
        return;
      case "audience.open":
        this.#openPolls.set(effect.poll.pollId, { openedAt: this.#clock, spec: effect.poll });
        this.#emit(effect);
        return;
      case "audience.close":
      case "audience.resolve": {
        const pollId = effect.pollId;
        const held = this.#deferred.filter((d) => pollIdOf(d.effect) === pollId);
        if (held.length > 0) {
          // Keep order: anything about a poll whose close is held waits behind that close.
          const at = Math.max(...held.map((d) => d.at));
          this.#deferred.push({ at, seq: this.#seq++, effect });
          return;
        }
        if (effect.type === "audience.close") {
          const poll = this.#openPolls.get(pollId);
          if (poll !== undefined && poll.spec.closeOn !== "event") {
            const minAt = poll.openedAt + minAudienceWindowMs(this.#timingConfig.streamDelaySec);
            if (this.#clock < minAt) {
              this.#deferred.push({ at: minAt, seq: this.#seq++, effect });
              return;
            }
          }
          this.#openPolls.delete(pollId);
        }
        this.#emit(effect);
        return;
      }
      case "score":
        for (const [id, delta] of Object.entries(effect.deltas)) {
          this.#scores[id] = (this.#scores[id] ?? 0) + delta;
        }
        this.#emit(effect);
        return;
      case "end":
        if (this.#result === null) {
          this.#result = effect.result;
          this.#timers.clear();
          this.#nextTick = null;
          for (const id of this.#bots.keys()) this.#bots.set(id, null);
        }
        this.#emit(effect);
        return;
      default:
        this.#emit(effect);
    }
  }

  #emit(effect: Effect): void {
    this.#out.push(this.#translate(effect));
  }

  #translate(effect: Effect): Effect {
    if (this.#offset === 0) return effect;
    if (effect.type === "audience.open") {
      return { ...effect, poll: this.#translatePoll(effect.poll) };
    }
    if (effect.type === "audience.enroll" && effect.closesAtMs !== undefined) {
      return { ...effect, closesAtMs: effect.closesAtMs + this.#offset };
    }
    return effect;
  }

  #translatePoll(spec: PollSpec): PollSpec {
    return this.#offset === 0 ? spec : { ...spec, closesAtMs: spec.closesAtMs + this.#offset };
  }

  #heldPolls(): string[] {
    return this.#deferred.map((d) => pollIdOf(d.effect)).filter((id) => id !== null);
  }

  #advanceTo(now: number): void {
    const target = now - this.#offset;
    this.#runDue(target);
    if (target > this.#clock) this.#clock = target;
  }

  #nextDue(): Due | null {
    let best: Due | null = null;
    let bestRank = Infinity;
    let bestSeq = Infinity;
    const consider = (due: Due, rank: number, seq: number): void => {
      if (
        best === null ||
        due.at < best.at ||
        (due.at === best.at && (rank < bestRank || (rank === bestRank && seq < bestSeq)))
      ) {
        best = due;
        bestRank = rank;
        bestSeq = seq;
      }
    };
    this.#deferred.forEach((d, index) => consider({ kind: "deferred", at: d.at, index }, 0, d.seq));
    for (const [id, t] of this.#timers) consider({ kind: "timer", at: t.at, id }, 1, t.seq);
    let order = 0;
    for (const [id, at] of this.#bots) {
      if (at !== null) consider({ kind: "bot", at, id }, 2, order);
      order++;
    }
    if (this.#nextTick !== null) consider({ kind: "tick", at: this.#nextTick }, 3, 0);
    return best;
  }

  /** Fires every due event with `at <= until`, in time order, each at its own time. */
  #runDue(until: number): void {
    for (let n = 0; ; n++) {
      if (n > MAX_EVENTS_PER_CALL) {
        throw new Error(`GameRunner: ${this.module.manifest.id} scheduled a runaway event loop`);
      }
      const due = this.#nextDue();
      if (due === null || due.at > until) return;
      if (due.at > this.#clock) this.#clock = due.at;
      switch (due.kind) {
        case "deferred": {
          const [entry] = this.#deferred.splice(due.index, 1);
          if (entry === undefined) break;
          if (entry.effect.type === "audience.close") this.#openPolls.delete(entry.effect.pollId);
          this.#emit(entry.effect);
          break;
        }
        case "timer": {
          this.#timers.delete(due.id);
          const hook = this.module.onTimer;
          if (hook !== undefined && this.#result === null) {
            this.#commit(hook.call(this.module, this.#state, due.id, this.#ctx()), "onTimer");
          }
          break;
        }
        case "bot": {
          this.#bots.set(due.id, null);
          if (this.#result !== null) break;
          const action = this.module.bot(this.#state, due.id, this.#botRng);
          if (action === null) break;
          this.#stats.botActions++;
          if (!this.#applyAction(due.id, action, "player")) this.#stats.botIllegal++;
          break;
        }
        case "tick": {
          this.#nextTick = due.at + this.#tickMs;
          const hook = this.module.onTick;
          if (hook !== undefined && this.#result === null) {
            this.#commit(hook.call(this.module, this.#state, this.#tickMs, this.#ctx()), "onTick");
          }
          if (this.#result !== null) this.#nextTick = null;
          break;
        }
      }
    }
  }

  #take(): Effect[] {
    const out = this.#out;
    this.#out = [];
    return out;
  }

  #done(): RunnerResult {
    return { ok: true, effects: this.#take() };
  }

  #refuse(err: RunnerError): RunnerResult {
    return { ok: false, err, effects: this.#take() };
  }
}

function pollIdOf(effect: Effect): string | null {
  return effect.type === "audience.close" || effect.type === "audience.resolve"
    ? effect.pollId
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
