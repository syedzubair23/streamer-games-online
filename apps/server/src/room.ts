/**
 * The room actor (SPEC §3, §5, §9.5; ROADMAP M1-02): the game-side half of a room. It runs the
 * playlist and every game through `GameRunner`, and fans views out through {@link Fanout}.
 *
 * Game loop (SPEC §3 step 6): `lobby` → `intro` (6 s card, skippable; host-advanced when
 * `timerScale = 0`) → `game` → `results` (the winner moment) → `scoreboard` (Night Champion
 * standings plus the audience's next-game vote) → the next `intro` … → `ended`.
 *
 * At every game boundary the actor seats raffle winners and fills free seats from the queue
 * (`seatPick`), then picks the game's participants (sat-out-last-game first, then a seeded
 * draw; the host's `bench` list sits out) and benches the rest as audience for that game. When
 * too few players are seated it waits for the host: `fillBots` fills seats up to `minPlayers`
 * with bots, and a second `next` skips the game.
 *
 * During a game it: applies player actions (acked); routes every effect (audience polls to the
 * {@link AudiencePort}, `moderate` to the {@link ModerationPort} with the 20 s review-wait
 * timeout, `fx` / `private` / `stream` / `streamEach` to the fan-out); schedules one wake-up
 * for the runner's next event; lets a bot take over a seat whose reconnect grace ran out;
 * freezes everything on `pause` and restores it exactly on `resume`; writes a snapshot every 20
 * actions or every 10 s; and records the result on the {@link Scoreboard}.
 *
 * Everything is single-threaded and synchronous: an entry point runs, drains the jobs it
 * queued (poll results, game end), and marks the fan-out dirty; views go out once per
 * event-loop turn.
 *
 * @module
 */
import { randomInt } from "node:crypto";
import {
  createRng,
  rngFrom,
  type AudId,
  type ErrorCode,
  type GameId,
  type MemberInfo,
  type ModItem,
  type PlayerId,
  type PlaylistItem,
  type PublicPoll,
  type PublicPollResult,
  type Rng,
  type RngState,
  type RoomConfig,
  type RoomSnapshot,
  type TeamId,
  type TeamInfo,
} from "@sg/shared";
import {
  GameRunner,
  type AnyGameModule,
  type Effect,
  type GameResult,
  type PollResult,
  type PollSpec,
  type RunnerResult,
  type RunnerSnapshot,
  type Seat,
  type ViewerKey,
} from "@sg/engine";
import type { Clock, TimerHandle } from "./config.ts";
import { Fanout, type ViewRouting } from "./fanout.ts";
import { type GameRegistry, PackLibrary, UsedContent, type RoomContent } from "./games.ts";
import {
  fillFromQueue,
  NEXT_GAME_POLL_ID,
  NEXT_GAME_VOTE_MS,
  nextGameCandidates,
  nextInOrder,
  pickParticipants,
  raffle,
  resolveNextGameVote,
} from "./playlist.ts";
import type {
  DriverFactory,
  DriverMessage,
  ManagedRoom,
  MemberEvent,
  RoomDriver,
  RoomManager,
} from "./room-manager.ts";
import { Scoreboard, type ScoreboardRecord } from "./scoreboard.ts";
import type { Session, Surface } from "./session.ts";
import { CLOSE, type Conn } from "./transport/types.ts";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Phase lengths and snapshot cadence. Tests shorten them; the defaults follow SPEC §3/§9. */
export interface RoomTimings {
  /** Intro card (SPEC §3 step 6: 6 s with the timer on). */
  introMs: number;
  /** Results, the winner moment. */
  resultsMs: number;
  /** Scoreboard interstitial when there is no next-game vote. */
  scoreboardMs: number;
  /** Snapshot after this many player actions (SPEC §9.5: 20). */
  snapshotEveryActions: number;
  /** …or this often while something changed (SPEC §9.5: 10 s). */
  snapshotIntervalMs: number;
  /** A moderation item still pending after this long resolves as rejected (SPEC §9.7: 20 s). */
  reviewTimeoutMs: number;
}

/** The default {@link RoomTimings}. */
export const DEFAULT_ROOM_TIMINGS: Readonly<RoomTimings> = Object.freeze({
  introMs: 6_000,
  resultsMs: 8_000,
  scoreboardMs: 12_000,
  snapshotEveryActions: 20,
  snapshotIntervalMs: 10_000,
  reviewTimeoutMs: 20_000,
});

/** Room teams (SPEC §5): ids `t1`..`t4`, default colours Tomato, Sky, Sunflower, Mint. */
export const TEAM_DEFS: readonly TeamInfo[] = Object.freeze([
  { id: "t1", name: "Tomato", colorSlot: 0 },
  { id: "t2", name: "Sky", colorSlot: 1 },
  { id: "t3", name: "Sunflower", colorSlot: 2 },
  { id: "t4", name: "Mint", colorSlot: 3 },
]);

/** The highest seat index a bot-filled seat may take (seats are 0..11, SPEC §7). */
const MAX_SEATS = 12;

// ---------------------------------------------------------------------------------------------
// Pausable timers
// ---------------------------------------------------------------------------------------------

/**
 * A one-shot timer that can be frozen and resumed with exactly the remaining time (BRB,
 * SPEC §3 step 7).
 */
export class PausableTimer {
  readonly #clock: Clock;
  readonly #fn: () => void;
  #handle: TimerHandle | null = null;
  #at: number;
  #remaining: number | null = null;

  /** Starts a timer firing `fn` after `ms` (clamped to ≥ 0). */
  constructor(clock: Clock, ms: number, fn: () => void, paused = false) {
    this.#clock = clock;
    this.#fn = fn;
    this.#at = clock.now() + Math.max(0, ms);
    if (paused) this.#remaining = Math.max(0, ms);
    else this.#arm();
  }

  /** Server ms the timer fires at (while running), or would fire at if resumed now. */
  get at(): number {
    return this.#remaining === null ? this.#at : this.#clock.now() + this.#remaining;
  }

  /** Remaining ms. */
  get remaining(): number {
    return this.#remaining ?? Math.max(0, this.#at - this.#clock.now());
  }

  /** True while frozen. */
  get paused(): boolean {
    return this.#remaining !== null;
  }

  /** Freezes the timer, keeping the remaining time. */
  pause(): void {
    if (this.#remaining !== null) return;
    this.#remaining = Math.max(0, this.#at - this.#clock.now());
    this.#disarm();
  }

  /** Re-arms a frozen timer with its remaining time. */
  resume(): void {
    if (this.#remaining === null) return;
    this.#at = this.#clock.now() + this.#remaining;
    this.#remaining = null;
    this.#arm();
  }

  /** Stops the timer for good. */
  cancel(): void {
    this.#disarm();
    this.#remaining = null;
  }

  #arm(): void {
    this.#disarm();
    this.#handle = this.#clock.setTimeout(
      () => {
        this.#handle = null;
        this.#fn();
      },
      Math.max(0, this.#at - this.#clock.now()),
    );
  }

  #disarm(): void {
    if (this.#handle !== null) this.#clock.clearTimeout(this.#handle);
    this.#handle = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Audience port (the AudienceAggregator, M1-03, implements it; BasicAudience is the default)
// ---------------------------------------------------------------------------------------------

/** Who opened a poll: the running game, or the room itself (the next-game vote). */
export type PollSource = "game" | "room";

/** Audience traffic the actor forwards to its audience port. */
export type AudienceMessage = Extract<
  DriverMessage,
  { t: "aud" } | { t: "tap" } | { t: "react" } | { t: "enroll" } | { t: "audAct" }
>;

/** What an audience port can call back into. */
export interface AudienceContext {
  room: ManagedRoom;
  fanout: Fanout;
  clock: Clock;
  /** A poll closed: its aggregate result (queued; applied after the current step). */
  onResult(result: PollResult, source: PollSource): void;
  /** An enrolment closed with these entrants (Marble Rally). */
  onEnroll(entrants: { audId: AudId; name: string; skin: number }[]): void;
  /** One direct audience action (`manifest.audience.direct`). */
  onAction(audId: AudId, action: unknown): void;
}

/**
 * The seam between the room and the AudienceAggregator (SPEC §4). The room forwards every
 * audience effect and every audience message here; the port broadcasts polls and tallies and
 * reports each poll's aggregate result exactly once.
 */
export interface AudiencePort {
  open(poll: PollSpec, source: PollSource): void;
  close(pollId: string): void;
  resolve(effect: Extract<Effect, { type: "audience.resolve" }>): void;
  enroll(effect: Extract<Effect, { type: "audience.enroll" }>): void;
  award(effect: Extract<Effect, { type: "audience.award" }>): void;
  input(session: Session, msg: AudienceMessage): void;
  /** Whether a poll is open. */
  isOpen(pollId: string): boolean;
  /** Closes every open poll of `source` (its results are still reported). */
  closeAll(source: PollSource): void;
  pause(): void;
  resume(): void;
  dispose(): void;
}

/** Creates a room's audience port. */
export type AudienceFactory = (ctx: AudienceContext) => AudiencePort;

/** The public part of a poll (never `accept`). */
export function publicPoll(spec: PollSpec): PublicPoll {
  const { accept: _secret, ...rest } = spec;
  return rest;
}

/** Tallies go out at most this often per poll (SPEC §4: ≤ 4 Hz). */
export const TALLY_INTERVAL_MS = 250;
/** Dial polls report a 50-bin histogram over 0..1000 (SPEC §4). */
export const DIAL_BINS = 50;

interface BasicPoll {
  spec: PollSpec;
  source: PollSource;
  votes: Map<AudId, string | number>;
  taps: number;
  timer: PausableTimer | null;
  tallyTimer: PausableTimer | null;
  lastTallyAt: number;
  result: PollResult | null;
}

/**
 * The room's built-in audience port: one input per `audId` (changeable until close; a `quiz`
 * answer locks), per-option tallies at ≤ 4 Hz (answered count only for `hideLive` and `quiz`),
 * a 50-bin histogram for `dial`, tap totals, per-team tallies for `teamSplit`, deadline closes
 * that freeze on pause, enrolment for Marble Rally, and direct audience actions. Seeds,
 * play-along points, `guess` matching and reactions belong to the AudienceAggregator (M1-03),
 * which replaces this port through `RoomActorOptions.audience`.
 */
export class BasicAudience implements AudiencePort {
  readonly #ctx: AudienceContext;
  readonly #polls = new Map<string, BasicPoll>();
  #enrolment: {
    open: boolean;
    cap: number;
    entrants: Map<AudId, { audId: AudId; name: string; skin: number }>;
    timer: PausableTimer | null;
  } | null = null;
  #paused = false;

  constructor(ctx: AudienceContext) {
    this.#ctx = ctx;
  }

  open(spec: PollSpec, source: PollSource): void {
    const existing = this.#polls.get(spec.pollId);
    if (existing !== undefined && existing.result === null) return;
    const poll: BasicPoll = {
      spec,
      source,
      votes: new Map(),
      taps: 0,
      timer: null,
      tallyTimer: null,
      lastTallyAt: 0,
      result: null,
    };
    this.#polls.set(spec.pollId, poll);
    if (spec.closeOn !== "event") {
      poll.timer = new PausableTimer(
        this.#ctx.clock,
        spec.closesAtMs - this.#ctx.clock.now(),
        () => this.close(spec.pollId),
        this.#paused,
      );
    }
    this.#ctx.fanout.toAudience({ t: "poll", poll: publicPoll(spec) }, { stage: true });
  }

  isOpen(pollId: string): boolean {
    const p = this.#polls.get(pollId);
    return p !== undefined && p.result === null;
  }

  close(pollId: string): void {
    const poll = this.#polls.get(pollId);
    if (poll === undefined || poll.result !== null) return;
    poll.timer?.cancel();
    poll.tallyTimer?.cancel();
    const result = this.#result(poll);
    poll.result = result;
    this.#ctx.fanout.toAudience({ t: "pollEnd", pollId, result: { ...result } }, { stage: true });
    this.#ctx.onResult(result, poll.source);
  }

  closeAll(source: PollSource): void {
    for (const [id, p] of this.#polls) if (p.source === source && p.result === null) this.close(id);
  }

  resolve(effect: Extract<Effect, { type: "audience.resolve" }>): void {
    const poll = this.#polls.get(effect.pollId);
    if (poll === undefined) return;
    if (poll.result === null) this.close(effect.pollId);
    if (poll.result === null) return;
    const result: PublicPollResult = { ...poll.result };
    if (effect.correct !== undefined) result.correct = effect.correct;
    this.#ctx.fanout.toAudience({ t: "pollEnd", pollId: effect.pollId, result }, { stage: true });
  }

  enroll(effect: Extract<Effect, { type: "audience.enroll" }>): void {
    if (effect.open) {
      this.#enrolment?.timer?.cancel();
      const e = {
        open: true,
        cap: effect.cap ?? Number.POSITIVE_INFINITY,
        entrants: this.#enrolment?.entrants ?? new Map(),
        timer: null as PausableTimer | null,
      };
      if (effect.closesAtMs !== undefined)
        e.timer = new PausableTimer(
          this.#ctx.clock,
          effect.closesAtMs - this.#ctx.clock.now(),
          () => this.enroll({ type: "audience.enroll", open: false }),
          this.#paused,
        );
      this.#enrolment = e;
      return;
    }
    const e = this.#enrolment;
    if (e === null || !e.open) return;
    e.open = false;
    e.timer?.cancel();
    this.#ctx.onEnroll([...e.entrants.values()]);
    this.#enrolment = null;
  }

  award(_effect: Extract<Effect, { type: "audience.award" }>): void {
    // Play-along points are the AudienceAggregator's ledger (M1-03).
  }

  input(session: Session, msg: AudienceMessage): void {
    switch (msg.t) {
      case "aud":
        return this.#vote(session, msg.pollId, msg.choice);
      case "tap": {
        const poll = this.#polls.get(msg.pollId);
        if (poll === undefined || poll.result !== null || poll.spec.kind !== "tap") return;
        poll.taps += msg.n;
        poll.votes.set(session.id, (Number(poll.votes.get(session.id)) || 0) + msg.n);
        return this.#scheduleTally(poll);
      }
      case "enroll": {
        const e = this.#enrolment;
        if (e === null || !e.open || e.entrants.has(session.id) || e.entrants.size >= e.cap) return;
        e.entrants.set(session.id, { audId: session.id, name: session.name, skin: msg.skin });
        return;
      }
      case "audAct":
        return this.#ctx.onAction(session.id, msg.a);
      case "react":
        return; // Reactions are aggregated by the AudienceAggregator (M1-03).
    }
  }

  pause(): void {
    this.#paused = true;
    for (const p of this.#polls.values()) {
      p.timer?.pause();
      p.tallyTimer?.pause();
    }
    this.#enrolment?.timer?.pause();
  }

  resume(): void {
    this.#paused = false;
    for (const p of this.#polls.values()) {
      p.timer?.resume();
      p.tallyTimer?.resume();
    }
    this.#enrolment?.timer?.resume();
  }

  dispose(): void {
    for (const p of this.#polls.values()) {
      p.timer?.cancel();
      p.tallyTimer?.cancel();
    }
    this.#enrolment?.timer?.cancel();
    this.#polls.clear();
  }

  #vote(session: Session, pollId: string, choice: string | number): void {
    const poll = this.#polls.get(pollId);
    if (poll === undefined || poll.result !== null) return;
    const { spec } = poll;
    switch (spec.kind) {
      case "vote":
      case "predict":
      case "quiz": {
        if (typeof choice !== "string" || !(spec.options ?? []).some((o) => o.id === choice))
          return;
        if (spec.kind === "quiz" && poll.votes.has(session.id)) return;
        poll.votes.set(session.id, choice);
        break;
      }
      case "dial":
        if (typeof choice !== "number" || !Number.isInteger(choice) || choice < 0 || choice > 1000)
          return;
        poll.votes.set(session.id, choice);
        break;
      case "guess":
        if (typeof choice !== "string" || choice.length === 0 || choice.length > 32) return;
        poll.votes.set(session.id, choice);
        break;
      case "tap":
        return;
    }
    this.#scheduleTally(poll);
  }

  #scheduleTally(poll: BasicPoll): void {
    if (poll.tallyTimer !== null) return;
    const now = this.#ctx.clock.now();
    const wait = Math.max(0, poll.lastTallyAt + TALLY_INTERVAL_MS - now);
    poll.tallyTimer = new PausableTimer(
      this.#ctx.clock,
      wait,
      () => {
        poll.tallyTimer = null;
        if (poll.result !== null) return;
        poll.lastTallyAt = this.#ctx.clock.now();
        const r = this.#result(poll);
        const secret =
          poll.spec.hideLive === true || poll.spec.kind === "quiz" || poll.spec.kind === "guess";
        this.#ctx.fanout.toAudience(
          {
            t: "tally",
            pollId: poll.spec.pollId,
            tallies: secret ? {} : r.tallies,
            total: r.total,
          },
          { stage: true },
        );
      },
      this.#paused,
    );
  }

  #result(poll: BasicPoll): PollResult {
    const { spec } = poll;
    const tallies: Record<string, number> = {};
    const byTeam: Record<TeamId, Record<string, number>> = {};
    let sum = 0;
    const bump = (key: string, teamId: TeamId | undefined, n = 1): void => {
      tallies[key] = (tallies[key] ?? 0) + n;
      if (spec.teamSplit === true && teamId !== undefined) {
        const t = (byTeam[teamId] ??= {});
        t[key] = (t[key] ?? 0) + n;
      }
    };
    if (spec.kind === "vote" || spec.kind === "predict" || spec.kind === "quiz")
      for (const o of spec.options ?? []) tallies[o.id] = 0;
    for (const [audId, v] of poll.votes) {
      const teamId = this.#ctx.room.byId.get(audId)?.teamId;
      if (spec.kind === "dial" && typeof v === "number") {
        bump(String(Math.min(DIAL_BINS - 1, Math.floor((v * DIAL_BINS) / 1001))), teamId);
        sum += v;
      } else if (spec.kind === "tap") {
        bump("taps", teamId, Number(v) || 0);
      } else if (spec.kind !== "guess" && typeof v === "string") {
        bump(v, teamId);
      }
    }
    if (spec.kind === "tap") tallies["taps"] = poll.taps;
    const result: PollResult = {
      pollId: spec.pollId,
      kind: spec.kind,
      total: poll.votes.size,
      tallies,
    };
    if (spec.teamSplit === true) result.byTeam = byTeam;
    if (spec.kind === "dial" && poll.votes.size > 0) result.mean = sum / poll.votes.size;
    if (spec.kind === "guess") result.firstCorrect = [];
    return result;
  }
}

// ---------------------------------------------------------------------------------------------
// Moderation port (moderation.ts, M1-04, extends it; BasicModeration is the default)
// ---------------------------------------------------------------------------------------------

/** What a moderation port can call back into. */
export interface ModerationContext {
  room: ManagedRoom;
  fanout: Fanout;
  clock: Clock;
  /** The item was approved or rejected (or timed out: rejected). Queued like poll results. */
  decide(itemId: string, approved: boolean): void;
  /** A member's public fields changed (rename): rebroadcast the room snapshot. */
  roomChanged(): void;
}

/** The outcome of {@link ModerationPort.screenAction}. */
export type ScreenResult = { ok: true; action: unknown } | { ok: false; err: ErrorCode };

/** The moderator commands other than approve/reject (SPEC §9.6 `ModCommand`). */
export type MemberModCommand =
  { c: "mute"; id: string; minutes: number } | { c: "rename"; id: string; name: string };

/** The seam for the review queue (SPEC §9.7). */
export interface ModerationPort {
  /** A game emitted `moderate`. */
  submit(effect: Extract<Effect, { type: "moderate" }>, gameId: GameId | null): void;
  /** A host/moderator approve or reject. Returns false when the item is unknown. */
  command(cmd: { c: "approve" | "reject"; itemId: string }): boolean;
  /** Items still waiting. */
  pending(): readonly ModItem[];
  /**
   * Screens a player action before the game sees it (text filter, mute). The default port
   * passes every action through unchanged.
   */
  screenAction?(session: Session, action: unknown): ScreenResult;
  /** `mute` / `rename` from a host or moderator; returns the error to send, or null. */
  modCommand?(from: Session, cmd: MemberModCommand): { code: ErrorCode; msg: string } | null;
  /** Resolves everything pending as rejected without calling back (game over). */
  clear(): void;
  pause(): void;
  resume(): void;
  dispose(): void;
}

/** Creates a room's moderation port. */
export type ModerationFactory = (ctx: ModerationContext, reviewTimeoutMs: number) => ModerationPort;

/**
 * The built-in review queue: with `moderation: "off"` every item is approved at once; with
 * `reveal-review` it waits for a host or moderator, and an item still pending after the
 * review-wait timeout (20 s) resolves as rejected so an absent moderator never stalls a
 * stream. The queue (`modq`) goes only to the host panel and moderators. Pausing freezes the
 * timeout.
 */
export class BasicModeration implements ModerationPort {
  readonly #ctx: ModerationContext;
  readonly #timeoutMs: number;
  readonly #items = new Map<string, { item: ModItem; timer: PausableTimer }>();
  #paused = false;

  constructor(ctx: ModerationContext, reviewTimeoutMs: number) {
    this.#ctx = ctx;
    this.#timeoutMs = reviewTimeoutMs;
  }

  submit(effect: Extract<Effect, { type: "moderate" }>, gameId: GameId | null): void {
    if (this.#ctx.room.config.moderation === "off") {
      this.#ctx.decide(effect.itemId, true);
      return;
    }
    if (this.#items.has(effect.itemId)) return;
    const now = this.#ctx.clock.now();
    const owner = this.#ctx.room.byId.get(effect.ownerId);
    const item: ModItem = {
      itemId: effect.itemId,
      kind: effect.kind,
      ownerId: effect.ownerId,
      ownerName: owner?.name ?? effect.ownerId,
      preview: effect.preview,
      gameId,
      createdAt: now,
      expiresAt: now + this.#timeoutMs,
    };
    const timer = new PausableTimer(
      this.#ctx.clock,
      this.#timeoutMs,
      () => this.#finish(effect.itemId, false),
      this.#paused,
    );
    this.#items.set(effect.itemId, { item, timer });
    this.#broadcast();
  }

  command(cmd: { c: "approve" | "reject"; itemId: string }): boolean {
    if (!this.#items.has(cmd.itemId)) return false;
    this.#finish(cmd.itemId, cmd.c === "approve");
    return true;
  }

  pending(): readonly ModItem[] {
    return [...this.#items.values()].map((e) => ({ ...e.item, expiresAt: e.timer.at }));
  }

  clear(): void {
    for (const e of this.#items.values()) e.timer.cancel();
    const had = this.#items.size > 0;
    this.#items.clear();
    if (had) this.#broadcast();
  }

  pause(): void {
    this.#paused = true;
    for (const e of this.#items.values()) e.timer.pause();
  }

  resume(): void {
    this.#paused = false;
    for (const e of this.#items.values()) e.timer.resume();
    if (this.#items.size > 0) this.#broadcast();
  }

  dispose(): void {
    for (const e of this.#items.values()) e.timer.cancel();
    this.#items.clear();
  }

  #finish(itemId: string, approved: boolean): void {
    const e = this.#items.get(itemId);
    if (e === undefined) return;
    e.timer.cancel();
    this.#items.delete(itemId);
    this.#broadcast();
    this.#ctx.decide(itemId, approved);
  }

  #broadcast(): void {
    this.#ctx.fanout.toModerators({ t: "modq", items: [...this.pending()] });
  }
}

// ---------------------------------------------------------------------------------------------
// Room actor
// ---------------------------------------------------------------------------------------------

/** Options for {@link createRoomActorFactory}. */
export interface RoomActorOptions {
  /** The room manager (membership changes, sends, topics, store). */
  manager: () => RoomManager;
  /** Game id → logic module. */
  games: GameRegistry;
  /** Content packs; default: none. */
  packs?: PackLibrary;
  /** Room RNG seed per room code (tests); default: a fresh random seed per room. */
  seed?: (code: string) => number | string;
  /** Phase lengths and snapshot cadence. */
  timings?: Partial<RoomTimings>;
  /** Runner dev mode (deep-freeze state every step); default true unless NODE_ENV=production. */
  dev?: boolean;
  /** Takeover-bot thinking time (runner default 1.2 s). */
  botDelayMs?: number;
  /** Replaces the built-in audience port (the AudienceAggregator, M1-03). */
  audience?: AudienceFactory;
  /** Replaces the built-in review queue (moderation.ts, M1-04). */
  moderation?: ModerationFactory;
  /** Called on `kick { ban: true }` so the ban list (bans.ts, M1-04) can record the session. */
  onBan?: (room: ManagedRoom, session: Session) => void;
}

/** One game on the table. */
interface GameSlot {
  index: number;
  gameId: GameId;
  item: PlaylistItem;
  module: AnyGameModule;
  seats: Seat[];
  teams: TeamInfo[];
  /** Real players in this game. */
  real: Set<PlayerId>;
  /** Seats filled with bots (practice). */
  bots: Set<PlayerId>;
  /** Seated players sitting this game out (audience role for the game). */
  benched: Set<PlayerId>;
  runner: GameRunner<unknown, unknown, unknown, unknown> | null;
  content: RoomContent | null;
  used: boolean;
  ended: boolean;
  /** Participants whose reconnect grace ran out; released when the game ends. */
  abandoned: Set<PlayerId>;
}

/** The persisted actor state (inside the room's store record). */
export interface ActorRecord {
  v: 1;
  rng: RngState;
  playlistIndex: number;
  played: number[];
  satOut: PlayerId[];
  hostBenched: PlayerId[];
  fillBots: boolean;
  queue: string[];
  pendingSeats: string[];
  scoreboard: ScoreboardRecord;
  used: ReturnType<UsedContent["toRecord"]>;
  paused: boolean;
  phaseRemainingMs: number | null;
  blockedIndex: number | null;
  vote: { candidates: number[] } | null;
  current: {
    index: number;
    gameId: GameId;
    seats: Seat[];
    teams: TeamInfo[];
    real: PlayerId[];
    bots: PlayerId[];
    benched: PlayerId[];
    abandoned: PlayerId[];
    ended: boolean;
    runner: RunnerSnapshot | null;
  } | null;
}

type Job = () => void;

/**
 * Creates the {@link DriverFactory} that installs a {@link RoomActor} in every room.
 */
export function createRoomActorFactory(o: RoomActorOptions): DriverFactory {
  return (room, restored) => new RoomActor(room, o, restored as ActorRecord | undefined);
}

/** The game-side half of one room. See the module docs. */
export class RoomActor implements RoomDriver, ViewRouting {
  readonly room: ManagedRoom;
  readonly fanout: Fanout;
  readonly scoreboard: Scoreboard;
  readonly #o: RoomActorOptions;
  readonly #timings: RoomTimings;
  readonly #rng: Rng;
  readonly #audience: AudiencePort;
  readonly #moderation: ModerationPort;
  readonly #used: UsedContent;
  readonly #packs: PackLibrary;

  #playlistIndex = -1;
  #played = new Set<number>();
  #lastPlaylist: PlaylistItem[];
  #current: GameSlot | null = null;
  #satOut = new Set<PlayerId>();
  #hostBenched = new Set<PlayerId>();
  #fillBots = false;
  /** Audience ids in the order they joined the queue. */
  #queue: string[] = [];
  /** Raffle winners / promoted members waiting for the next game boundary. */
  #pendingSeats: string[] = [];
  #restricted = new Set<string>();
  #phaseTimer: PausableTimer | null = null;
  #phaseAction: (() => void) | null = null;
  #wake: TimerHandle | null = null;
  #wakeAt: number | null = null;
  #snapshotTimer: TimerHandle | null = null;
  #actionsSinceSnapshot = 0;
  #dirtySinceSnapshot = false;
  #blockedIndex: number | null = null;
  #vote: { candidates: number[] } | null = null;
  #jobs: Job[] = [];
  #draining = false;
  #flushScheduled: NodeJS.Immediate | null = null;
  #disposed = false;

  constructor(room: ManagedRoom, o: RoomActorOptions, restored?: ActorRecord) {
    this.room = room;
    this.#o = o;
    this.#timings = { ...DEFAULT_ROOM_TIMINGS, ...o.timings };
    this.#packs = o.packs ?? PackLibrary.empty();
    const manager = (): RoomManager => o.manager();
    this.fanout = new Fanout(
      room,
      {
        send: (conn, data) => conn.send(data),
        publish: (topic, data) => manager().publishRaw(topic, data),
      },
      this,
    );
    const clock = this.#clock;
    this.#audience = (o.audience ?? ((ctx) => new BasicAudience(ctx)))({
      room,
      fanout: this.fanout,
      clock,
      onResult: (result, source) => this.#enqueue(() => this.#onPollResult(result, source)),
      onEnroll: (entrants) =>
        this.#enqueue(() => {
          const runner = this.#liveRunner();
          if (runner !== null) this.#apply(runner.audienceEnroll(entrants, clock.now()));
        }),
      onAction: (audId, action) =>
        this.#run(() => {
          const slot = this.#current;
          const runner = this.#liveRunner();
          if (runner === null || slot === null || slot.module.manifest.audience.direct !== true)
            return;
          this.#apply(runner.audienceAction(audId, action, clock.now()));
        }),
    });
    this.#moderation = (o.moderation ?? ((ctx, ms) => new BasicModeration(ctx, ms)))(
      {
        room,
        fanout: this.fanout,
        clock,
        decide: (itemId, approved) =>
          this.#enqueue(() => {
            const runner = this.#liveRunner();
            if (runner !== null) this.#apply(runner.moderation(itemId, approved, clock.now()));
          }),
        roomChanged: () => this.#manager.roomChanged(room),
      },
      this.#timings.reviewTimeoutMs,
    );
    if (restored !== undefined && restored.v === 1) {
      this.#rng = rngFrom(restored.rng);
      this.scoreboard = Scoreboard.fromRecord(restored.scoreboard);
      this.#used = UsedContent.fromRecord(restored.used);
      this.#lastPlaylist = structuredClone(room.config.playlist);
      this.#restore(restored);
    } else {
      this.#rng = createRng(o.seed?.(room.code) ?? randomInt(0, 2 ** 47));
      this.scoreboard = new Scoreboard();
      this.#used = new UsedContent();
      this.#lastPlaylist = structuredClone(room.config.playlist);
    }
    this.#armSnapshotTimer();
  }

  get #clock(): Clock {
    return this.#o.manager().clock;
  }

  get #manager(): RoomManager {
    return this.#o.manager();
  }

  /** The running game's runner (null between games). For tests and tooling. */
  get runner(): GameRunner<unknown, unknown, unknown, unknown> | null {
    return this.#current?.runner ?? null;
  }

  /** Ids playing the current game (real players and bot seats). */
  get participants(): PlayerId[] {
    return this.#current?.seats.map((s) => s.id) ?? [];
  }

  /** Ids benched for the current game. */
  get benched(): PlayerId[] {
    return [...(this.#current?.benched ?? [])];
  }

  /** Playlist indices already played this night. */
  get played(): number[] {
    return [...this.#played].sort((a, b) => a - b);
  }

  /** Raffle winners and promotions waiting for the next game boundary. */
  get pendingSeats(): string[] {
    return [...this.#pendingSeats];
  }

  /** The pending review queue. */
  get moderationQueue(): readonly ModItem[] {
    return this.#moderation.pending();
  }

  // -------------------------------------------------------------------------------------------
  // ViewRouting
  // -------------------------------------------------------------------------------------------

  keyFor(session: Session, surface: Surface): ViewerKey | null {
    if (surface === "stage" || surface === "overlay") return { role: "stage" };
    if (surface === "panel") return { role: "host" };
    switch (session.role) {
      case "moderator":
        return { role: "moderator" };
      case "player":
        return this.#current?.real.has(session.id) === true
          ? { role: "player", id: session.id }
          : { role: "audience" };
      case "audience":
        return this.#restricted.has(session.id)
          ? { role: "audience", restricted: true }
          : { role: "audience" };
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // RoomDriver
  // -------------------------------------------------------------------------------------------

  onMessage(session: Session, conn: Conn, msg: DriverMessage): void {
    this.#run(() => {
      switch (msg.t) {
        case "act":
          return this.#act(session, conn, msg.id, msg.a);
        case "host":
          return this.#host(session, conn, msg.cmd);
        case "mod":
          return this.#mod(session, conn, msg.cmd);
        case "resync": {
          for (const [surface, c] of session.conns)
            if (c === conn) this.fanout.sendFull(session, surface, conn);
          return;
        }
        case "queue":
          this.#queue = this.#queue.filter((id) => id !== session.id);
          if (msg.join && session.role === "audience") this.#queue.push(session.id);
          return;
        case "aud":
        case "tap":
        case "react":
        case "enroll":
        case "audAct":
          return this.#audience.input(session, msg);
        case "bg":
          return;
      }
    });
  }

  onMember(session: Session, event: MemberEvent): void {
    this.#run(() => {
      const slot = this.#current;
      const runner = this.#liveRunner();
      const now = this.#clock.now();
      if (event === "join" || event === "reconnect") {
        if (session.role === "audience") this.#updateRestricted(session);
        if (event === "join" && session.queued && !this.#queue.includes(session.id))
          this.#queue.push(session.id);
        this.fanout.syncTopics(session);
        if (event === "reconnect" && slot !== null && slot.real.has(session.id)) {
          slot.abandoned.delete(session.id);
          if (session.bot) {
            session.bot = false;
            this.#manager.roomChanged(this.room);
          }
          if (runner !== null) this.#apply(runner.playerRejoin(session.id, now));
        }
        for (const [surface, conn] of session.conns) this.fanout.sendFull(session, surface, conn);
        if (session.role === "host" || session.role === "moderator") {
          const panel = session.role === "host" ? session.conns.get("panel") : undefined;
          const items = [...this.#moderation.pending()];
          if (session.role === "moderator")
            for (const c of session.conns.values()) this.#manager.send(c, { t: "modq", items });
          else if (panel !== undefined) this.#manager.send(panel, { t: "modq", items });
        }
      } else if (event === "disconnect") {
        if (runner !== null && slot !== null && slot.real.has(session.id))
          this.#apply(runner.playerLeave(session.id, now));
      } else {
        this.#queue = this.#queue.filter((id) => id !== session.id);
        this.#pendingSeats = this.#pendingSeats.filter((id) => id !== session.id);
        this.#restricted.delete(session.id);
        this.#hostBenched.delete(session.id);
      }
    });
  }

  onGraceExpired(session: Session): boolean {
    const slot = this.#current;
    const runner = this.#liveRunner();
    if (slot === null || runner === null || !slot.real.has(session.id)) return false;
    // SPEC §3 idle-proof rules: the seat is held and the module's bot plays it.
    this.#run(() => {
      slot.abandoned.add(session.id);
      session.bot = true;
      this.#apply(runner.setBot(session.id, true, this.#clock.now()));
      this.#manager.roomChanged(this.room);
    });
    return true;
  }

  snapshot(base: RoomSnapshot): RoomSnapshot {
    const slot = this.#current;
    const members: MemberInfo[] = [...base.members];
    if (slot !== null) {
      for (const id of slot.benched) {
        const s = this.room.byId.get(id);
        if (s === undefined || s.seat === null) continue;
        members.push({
          id: s.id,
          name: s.name,
          role: "player",
          seat: s.seat,
          colorSlot: s.seat % 8,
          ...(s.teamId !== undefined ? { teamId: s.teamId } : {}),
          connected: s.connected,
          benched: true,
        });
      }
      // Bot-played seats show while the game is on the table (practice fill, or a seat whose
      // owner was kicked or moved to the audience mid-game).
      const onTable = this.room.phase === "intro" || this.room.phase === "game";
      for (const seat of onTable ? slot.seats : []) {
        if (!slot.bots.has(seat.id)) continue;
        members.push({
          id: seat.id,
          name: seat.name,
          role: "player",
          seat: seat.seat,
          colorSlot: seat.colorSlot,
          ...(seat.teamId !== undefined ? { teamId: seat.teamId } : {}),
          connected: true,
          bot: true,
        });
      }
    }
    const rank = (m: MemberInfo): number => (m.role === "host" ? -1 : (m.seat ?? 1000));
    members.sort((a, b) => rank(a) - rank(b));
    const inGame =
      this.room.phase === "intro" || this.room.phase === "game" || this.room.phase === "results";
    return {
      ...base,
      members,
      teams: this.#roomTeams(),
      playlistIndex: this.#playlistIndex,
      current: inGame && slot !== null ? slot.gameId : null,
      standings: this.scoreboard.standings(),
    };
  }

  onConfig(config: Readonly<RoomConfig>): void {
    this.#run(() => {
      this.#current?.runner?.setTiming({
        timerScale: config.timerScale,
        streamDelaySec: config.streamDelaySec,
      });
      this.#remapPlaylist(config.playlist);
      if (!config.antiSnipe && this.#restricted.size > 0) {
        this.#restricted.clear();
        this.fanout.syncAllTopics();
      }
    });
  }

  persist(): ActorRecord {
    const slot = this.#current;
    return {
      v: 1,
      rng: this.#rng.state(),
      playlistIndex: this.#playlistIndex,
      played: [...this.#played],
      satOut: [...this.#satOut],
      hostBenched: [...this.#hostBenched],
      fillBots: this.#fillBots,
      queue: [...this.#queue],
      pendingSeats: [...this.#pendingSeats],
      scoreboard: this.scoreboard.toRecord(),
      used: this.#used.toRecord(),
      paused: this.room.paused,
      phaseRemainingMs: this.#phaseTimer?.remaining ?? null,
      blockedIndex: this.#blockedIndex,
      vote: this.#vote === null ? null : { candidates: [...this.#vote.candidates] },
      current:
        slot === null
          ? null
          : {
              index: slot.index,
              gameId: slot.gameId,
              seats: slot.seats.map((s) => ({ ...s })),
              teams: slot.teams.map((t) => ({ ...t })),
              real: [...slot.real],
              bots: [...slot.bots],
              benched: [...slot.benched],
              abandoned: [...slot.abandoned],
              ended: slot.ended,
              runner: slot.runner?.snapshot() ?? null,
            },
    };
  }

  dispose(): void {
    this.#disposed = true;
    this.#phaseTimer?.cancel();
    this.#clearWake();
    if (this.#snapshotTimer !== null) this.#clock.clearTimeout(this.#snapshotTimer);
    if (this.#flushScheduled !== null) clearImmediate(this.#flushScheduled);
    this.#audience.dispose();
    this.#moderation.dispose();
  }

  // -------------------------------------------------------------------------------------------
  // Execution: run, jobs, flush
  // -------------------------------------------------------------------------------------------

  /** Runs one entry point, drains the jobs it queued and schedules the turn's flush. */
  #run(fn: () => void): void {
    if (this.#disposed) return;
    if (this.#draining) {
      fn();
      return;
    }
    this.#draining = true;
    try {
      fn();
      for (let job = this.#jobs.shift(); job !== undefined; job = this.#jobs.shift()) job();
    } finally {
      this.#draining = false;
    }
    this.#rescheduleWake();
    this.#scheduleFlush();
  }

  #enqueue(job: Job): void {
    this.#jobs.push(job);
    if (!this.#draining) this.#run(() => undefined);
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled !== null || this.#disposed) return;
    this.#flushScheduled = setImmediate(() => {
      this.#flushScheduled = null;
      if (!this.#disposed) this.fanout.flush();
    });
  }

  /** Flushes pending views and fx now (tests; the actor itself flushes once per turn). */
  flushNow(): void {
    if (this.#flushScheduled !== null) clearImmediate(this.#flushScheduled);
    this.#flushScheduled = null;
    this.fanout.flush();
  }

  // -------------------------------------------------------------------------------------------
  // Runner plumbing
  // -------------------------------------------------------------------------------------------

  #liveRunner(): GameRunner<unknown, unknown, unknown, unknown> | null {
    const slot = this.#current;
    return slot !== null && slot.runner !== null && !slot.ended ? slot.runner : null;
  }

  /** Routes a runner call's effects; queues the game's end. */
  #apply(result: RunnerResult): void {
    this.#dirtySinceSnapshot = true;
    const slot = this.#current;
    for (const effect of result.effects) this.#route(effect, slot);
    if (slot !== null && slot.runner !== null && slot.runner.ended && !slot.ended) {
      slot.ended = true;
      const res = slot.runner.result;
      this.#enqueue(() => this.#finishGame(slot, res));
    }
  }

  #route(effect: Effect, slot: GameSlot | null): void {
    switch (effect.type) {
      case "audience.open":
        return this.#audience.open(effect.poll, "game");
      case "audience.close":
        return this.#audience.close(effect.pollId);
      case "audience.resolve":
        return this.#audience.resolve(effect);
      case "audience.enroll":
        return this.#audience.enroll(effect);
      case "audience.award":
        return this.#audience.award(effect);
      case "fx":
        if (effect.name !== "illegal") this.fanout.queueFx([effect]);
        return;
      case "private":
        return this.fanout.toMember(effect.to, {
          t: "fx",
          events: [
            effect.data === undefined
              ? { name: effect.name }
              : { name: effect.name, data: effect.data },
          ],
        });
      case "moderate":
        return this.#moderation.submit(effect, slot?.gameId ?? null);
      case "stream":
        return this.fanout.stream(effect.channel, effect.frame);
      case "streamEach":
        return this.fanout.streamEach(effect.frames);
      case "score":
      case "end":
      case "timer.set":
      case "timer.clear":
        return;
    }
  }

  #onPollResult(result: PollResult, source: PollSource): void {
    if (source === "room") {
      if (result.pollId === NEXT_GAME_POLL_ID) this.#afterVote(result);
      return;
    }
    const runner = this.#liveRunner();
    if (runner !== null) this.#apply(runner.audienceResult(result, this.#clock.now()));
  }

  #rescheduleWake(): void {
    const runner = this.#liveRunner();
    const at = runner?.nextEventAt() ?? null;
    if (at === this.#wakeAt && (at === null || this.#wake !== null)) return;
    this.#clearWake();
    if (at === null) return;
    this.#wakeAt = at;
    this.#wake = this.#clock.setTimeout(
      () => {
        this.#wake = null;
        this.#wakeAt = null;
        this.#run(() => {
          const r = this.#liveRunner();
          if (r !== null) this.#apply(r.advance(this.#clock.now()));
        });
      },
      Math.max(0, at - this.#clock.now()),
    );
  }

  #clearWake(): void {
    if (this.#wake !== null) this.#clock.clearTimeout(this.#wake);
    this.#wake = null;
    this.#wakeAt = null;
  }

  // -------------------------------------------------------------------------------------------
  // Snapshots (SPEC §9.5: every 20 actions or every 10 s)
  // -------------------------------------------------------------------------------------------

  #armSnapshotTimer(): void {
    if (this.#disposed) return;
    this.#snapshotTimer = this.#clock.setTimeout(() => {
      this.#snapshotTimer = null;
      if (this.#dirtySinceSnapshot) this.#snapshotNow();
      this.#armSnapshotTimer();
    }, this.#timings.snapshotIntervalMs);
  }

  #snapshotNow(): void {
    this.#actionsSinceSnapshot = 0;
    this.#dirtySinceSnapshot = false;
    this.#manager.persistNow(this.room);
  }

  /** Counts a player action toward the every-20-actions snapshot (turn-based games only). */
  #countAction(slot: GameSlot): void {
    if (slot.module.manifest.tickHz !== 0) return;
    this.#actionsSinceSnapshot++;
    if (this.#actionsSinceSnapshot >= this.#timings.snapshotEveryActions) this.#snapshotNow();
  }

  // -------------------------------------------------------------------------------------------
  // Player actions
  // -------------------------------------------------------------------------------------------

  #act(session: Session, conn: Conn, id: number, raw: unknown): void {
    const slot = this.#current;
    const runner = this.#liveRunner();
    if (slot === null || runner === null || this.room.phase !== "game") {
      this.#manager.send(conn, { t: "ack", id, ok: false, err: "ILLEGAL" });
      return;
    }
    if (!slot.real.has(session.id)) {
      this.#manager.send(conn, { t: "ack", id, ok: false, err: "NOT_ALLOWED" });
      return;
    }
    const screened = this.#moderation.screenAction?.(session, raw) ?? { ok: true, action: raw };
    if (!screened.ok) {
      this.#manager.send(conn, { t: "ack", id, ok: false, err: screened.err });
      return;
    }
    const result = runner.act(session.id, screened.action, this.#clock.now(), "player");
    this.#apply(result);
    this.#countAction(slot);
    this.#manager.send(
      conn,
      result.ok
        ? { t: "ack", id, ok: true }
        : { t: "ack", id, ok: false, err: result.err === "NOT_SEATED" ? "NOT_ALLOWED" : "ILLEGAL" },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Host and moderator commands
  // -------------------------------------------------------------------------------------------

  #error(conn: Conn, code: ErrorCode, msg: string): void {
    this.#manager.send(conn, { t: "error", code, msg });
  }

  #host(from: Session, conn: Conn, cmd: Extract<DriverMessage, { t: "host" }>["cmd"]): void {
    const phase = this.room.phase;
    switch (cmd.c) {
      case "start":
        if (phase !== "lobby" && phase !== "ended")
          return this.#error(conn, "ILLEGAL", "the night is already running; use next");
        return this.#startNight(conn);
      case "next":
        return this.#next(conn);
      case "pause":
        return this.#pause();
      case "resume":
        return this.#resume();
      case "endGame":
        return this.#endGame(conn);
      case "forceAdvance": {
        const runner = this.#liveRunner();
        if (runner === null || phase !== "game")
          return this.#error(conn, "ILLEGAL", "no game is running");
        const r = runner.hostCommand({ c: "forceAdvance" }, this.#clock.now());
        this.#apply(r);
        if (!r.ok) this.#error(conn, "ILLEGAL", `forceAdvance refused: ${r.err ?? "?"}`);
        return;
      }
      case "playlist.set": {
        const allowed = new Set(this.#manager.config.allowedGames);
        const items = cmd.items
          .filter((i) => allowed.has(i.gameId))
          .map((i) => ({
            gameId: i.gameId,
            options: i.options,
            ...(i.label !== undefined ? { label: i.label } : {}),
          }));
        this.room.config = { ...this.room.config, playlist: items };
        this.#remapPlaylist(items);
        this.#manager.roomChanged(this.room);
        return;
      }
      case "kick":
        return this.#kick(conn, cmd.id, cmd.ban === true);
      case "promote":
        return this.#promote(conn, cmd.id, cmd.role);
      case "team.assign":
        return this.#teamAssign(conn, cmd.id, cmd.teamId);
      case "transferHost":
        return this.#transferHost(from, conn, cmd.id);
      case "raffle":
        return this.#raffle(conn, cmd.n);
      case "bench":
        return this.#bench(conn, cmd.ids);
      case "fillBots":
        this.#fillBots = cmd.on;
        this.#manager.roomChanged(this.room);
        return;
      default:
        // config / revealCode / ambient are applied by the room manager before this point.
        return;
    }
  }

  #mod(from: Session, conn: Conn, cmd: Extract<DriverMessage, { t: "mod" }>["cmd"]): void {
    if (cmd.c === "approve" || cmd.c === "reject") {
      if (!this.#moderation.command(cmd))
        this.#error(conn, "ILLEGAL", `no pending item ${cmd.itemId}`);
      return;
    }
    if (this.#moderation.modCommand === undefined)
      return this.#error(conn, "ILLEGAL", `"${cmd.c}" needs the moderation port (moderation.ts)`);
    const refused = this.#moderation.modCommand(from, cmd);
    if (refused !== null) this.#error(conn, refused.code, refused.msg);
  }

  #kick(conn: Conn, id: string, ban: boolean): void {
    const s = this.room.byId.get(id);
    if (s === undefined) return this.#error(conn, "ILLEGAL", `no member ${id}`);
    if (s.id === this.room.hostId)
      return this.#error(conn, "NOT_ALLOWED", "the host cannot be kicked");
    this.#leaveGame(s);
    if (ban) this.#o.onBan?.(this.room, s);
    this.#manager.removeMember(this.room, s, CLOSE.KICKED, ban ? "banned" : "kicked");
  }

  #promote(conn: Conn, id: string, role: "moderator" | "player" | "audience"): void {
    const s = this.room.byId.get(id);
    if (s === undefined) return this.#error(conn, "ILLEGAL", `no member ${id}`);
    if (s.id === this.room.hostId || s.role === "overlay")
      return this.#error(conn, "NOT_ALLOWED", "that member's role cannot change");
    if (role === "player") {
      if (s.role === "player" || (s.seat !== null && this.#current?.benched.has(s.id) === true))
        return;
      if (this.#betweenGames()) {
        const seat = this.room.freeSeat();
        if (seat === null) return this.#error(conn, "ROOM_FULL", "every seat is taken");
        this.#setRole(s, "player", seat);
      } else if (!this.#pendingSeats.includes(s.id)) {
        // Mid-game: seated at the next game boundary.
        this.#pendingSeats.push(s.id);
        this.#manager.roomChanged(this.room);
      }
      return;
    }
    this.#leaveGame(s);
    this.#current?.benched.delete(s.id);
    this.#pendingSeats = this.#pendingSeats.filter((p) => p !== s.id);
    this.#setRole(s, role, null);
    if (role === "audience") this.#updateRestricted(s);
    this.fanout.syncTopics(s);
  }

  #teamAssign(conn: Conn, id: string, teamId: string | null): void {
    const s = this.room.byId.get(id);
    if (s === undefined) return this.#error(conn, "ILLEGAL", `no member ${id}`);
    if (teamId !== null && !this.#roomTeams().some((t) => t.id === teamId))
      return this.#error(conn, "ILLEGAL", `no team ${teamId} in this room`);
    this.#manager.setMember(this.room, s, { teamId });
  }

  #transferHost(from: Session, conn: Conn, id: string): void {
    const target = this.room.byId.get(id);
    if (target === undefined || target.role === "overlay" || target.id === this.room.hostId)
      return this.#error(conn, "ILLEGAL", `cannot hand the host role to ${id}`);
    const old = this.room.host;
    if (old === undefined || from.id !== old.id)
      return this.#error(conn, "NOT_ALLOWED", "only the host can transfer the host role");
    this.#leaveGame(target);
    this.#current?.benched.delete(target.id);
    this.#pendingSeats = this.#pendingSeats.filter((p) => p !== target.id);
    this.room.hostId = target.id;
    this.#manager.setMember(this.room, target, { role: "host", seat: null });
    this.#manager.setMember(this.room, old, { role: "moderator", seat: null });
    this.fanout.syncTopics(target);
    this.fanout.syncTopics(old);
  }

  #raffle(conn: Conn, n: number): void {
    const queued = this.#queue.filter((id) => {
      const s = this.room.byId.get(id);
      return s !== undefined && s.role === "audience" && s.queued && s.seat === null;
    });
    const pool =
      queued.length > 0
        ? queued
        : [...this.room.byId.values()]
            .filter((s) => s.role === "audience" && s.connected && s.seat === null)
            .map((s) => s.id);
    const winners = raffle(pool, n, this.#rng).filter((id) => !this.#pendingSeats.includes(id));
    if (winners.length === 0)
      return this.#error(conn, "ILLEGAL", "nobody is in the audience to raffle");
    this.#pendingSeats.push(...winners);
    this.fanout.queueFx([
      {
        name: "raffle",
        data: { winners: winners.map((id) => ({ id, name: this.room.byId.get(id)?.name ?? id })) },
      },
    ]);
    if (this.#betweenGames() && this.room.phase !== "results") this.#seatPending();
    this.#manager.roomChanged(this.room);
  }

  #bench(conn: Conn, ids: readonly string[]): void {
    const seated = new Set(this.room.seated().map((s) => s.id));
    const unknown = ids.filter((id) => !seated.has(id));
    if (unknown.length > 0)
      return this.#error(conn, "ILLEGAL", `not seated: ${unknown.join(", ")}`);
    this.#hostBenched = new Set(ids);
    // The intro has not started the runner yet: re-pick with the new bench.
    const slot = this.#current;
    if (this.room.phase === "intro" && slot !== null && slot.runner === null) {
      this.#restoreBenched(slot);
      const ok = this.#assignParticipants(slot);
      if (!ok) return this.#error(conn, "ILLEGAL", "too few players left for this game");
    }
    this.#manager.roomChanged(this.room);
  }

  /** Takes a member out of the running game: a bot plays their seat to the end. */
  #leaveGame(s: Session): void {
    const slot = this.#current;
    const runner = this.#liveRunner();
    if (slot === null || !slot.real.has(s.id)) return;
    slot.real.delete(s.id);
    slot.abandoned.delete(s.id);
    s.bot = false;
    if (runner !== null) {
      this.#apply(runner.playerLeave(s.id, this.#clock.now()));
      this.#apply(runner.setBot(s.id, true, this.#clock.now()));
      slot.bots.add(s.id);
    }
  }

  #setRole(s: Session, role: Session["role"], seat: number | null): void {
    this.#manager.setMember(this.room, s, { role, seat });
    this.fanout.syncTopics(s);
  }

  // -------------------------------------------------------------------------------------------
  // Game loop
  // -------------------------------------------------------------------------------------------

  #betweenGames(): boolean {
    const p = this.room.phase;
    return p === "lobby" || p === "results" || p === "scoreboard" || p === "ended";
  }

  #setPhase(phase: RoomSnapshot["phase"], ms: number | null, then: (() => void) | null): void {
    this.#phaseTimer?.cancel();
    this.#phaseTimer = null;
    this.#phaseAction = then;
    this.room.phase = phase;
    if (ms !== null && then !== null)
      this.#phaseTimer = new PausableTimer(
        this.#clock,
        ms,
        () => this.#run(() => this.#firePhase()),
        this.room.paused,
      );
    this.#dirtySinceSnapshot = true;
    this.#manager.roomChanged(this.room);
  }

  #firePhase(): void {
    const action = this.#phaseAction;
    this.#phaseTimer?.cancel();
    this.#phaseTimer = null;
    this.#phaseAction = null;
    action?.();
  }

  #startNight(conn: Conn): void {
    const playlist = this.room.config.playlist;
    if (playlist.length === 0) return this.#error(conn, "ILLEGAL", "the playlist is empty");
    if (this.room.phase === "ended") {
      this.#played.clear();
      this.#playlistIndex = -1;
    }
    const first = nextInOrder(playlist, this.#played, this.#playlistIndex);
    if (first === null) return this.#error(conn, "ILLEGAL", "every playlist entry was played");
    this.#beginIntro(first, conn);
  }

  #next(conn: Conn): void {
    switch (this.room.phase) {
      case "lobby":
        return this.#startNight(conn);
      case "intro":
        if (this.#current !== null && this.#current.runner === null)
          this.#startGame(this.#current, conn);
        return;
      case "game": {
        const runner = this.#liveRunner();
        if (runner !== null)
          this.#apply(runner.hostCommand({ c: "forceAdvance" }, this.#clock.now()));
        return;
      }
      case "results":
        return this.#firePhase();
      case "scoreboard":
        if (this.#blockedIndex !== null) {
          // Second press while waiting for players: skip that game (SPEC §3 step 4 "Skip game").
          const skipped = this.#blockedIndex;
          this.#blockedIndex = null;
          this.#played.add(skipped);
          this.#playlistIndex = skipped;
          return this.#advanceFromScoreboard(conn);
        }
        if (this.#vote !== null && this.#audience.isOpen(NEXT_GAME_POLL_ID)) {
          this.#audience.close(NEXT_GAME_POLL_ID);
          return;
        }
        return this.#firePhase();
      case "ended":
        return this.#error(conn, "ILLEGAL", "the night is over; start a new one");
    }
  }

  #pause(): void {
    if (this.room.paused) return;
    this.room.paused = true;
    const runner = this.#liveRunner();
    if (runner !== null) this.#apply(runner.pause(this.#clock.now()));
    this.#phaseTimer?.pause();
    this.#audience.pause();
    this.#moderation.pause();
    this.fanout.queueFx([{ name: "brb", data: { on: true } }]);
    this.#manager.roomChanged(this.room);
  }

  #resume(): void {
    if (!this.room.paused) return;
    this.room.paused = false;
    const runner = this.#liveRunner();
    if (runner !== null) this.#apply(runner.resume(this.#clock.now()));
    this.#phaseTimer?.resume();
    this.#audience.resume();
    this.#moderation.resume();
    this.fanout.queueFx([{ name: "brb", data: { on: false } }]);
    this.#manager.roomChanged(this.room);
  }

  #endGame(conn: Conn): void {
    const slot = this.#current;
    if (slot === null || (this.room.phase !== "game" && this.room.phase !== "intro"))
      return this.#error(conn, "ILLEGAL", "no game is running");
    if (slot.ended) return;
    slot.ended = true;
    // Ended by the host: no result, Night Champion unchanged (SPEC §5 empty ranking).
    this.#finishGame(slot, { ranking: [] });
  }

  /** Boundary work, participant pick, then the intro card. */
  #beginIntro(index: number, conn: Conn | null): void {
    const item = this.room.config.playlist[index];
    if (item === undefined) return;
    const module = this.#o.games.get(item.gameId);
    if (module === null) {
      const why = `${item.gameId} is not available: ${this.#o.games.whyUnavailable(item.gameId)}`;
      if (conn !== null) this.#error(conn, "ILLEGAL", why);
      else this.#hostError(why);
      this.#blockedIndex = index;
      if (this.room.phase !== "lobby") this.#setPhase("scoreboard", null, null);
      return;
    }
    const previous = this.#current;
    if (previous !== null) this.#restoreBenched(previous);
    this.#seatPending();
    this.#fillFromQueue();
    const slot: GameSlot = {
      index,
      gameId: item.gameId,
      item,
      module,
      seats: [],
      teams: [],
      real: new Set(),
      bots: new Set(),
      benched: new Set(),
      runner: null,
      content: null,
      used: false,
      ended: false,
      abandoned: new Set(),
    };
    if (!this.#assignParticipants(slot)) {
      const { minPlayers } = module.manifest;
      const msg = `${module.manifest.name} needs at least ${minPlayers} players; turn on "Fill with bots" or press next to skip it`;
      if (conn !== null) this.#error(conn, "ILLEGAL", msg);
      else this.#hostError(msg);
      this.#blockedIndex = index;
      if (this.room.phase !== "lobby") this.#setPhase("scoreboard", null, null);
      return;
    }
    this.#blockedIndex = null;
    this.#vote = null;
    this.#current = slot;
    this.#playlistIndex = index;
    this.#hostBenched.clear();
    this.fanout.setSource(null, null);
    this.#updateAllRestricted();
    const auto = this.room.config.timerScale !== 0;
    this.#setPhase("intro", auto ? this.#timings.introMs : null, () => this.#startGame(slot, null));
  }

  /**
   * Picks the slot's seats from the seated players (and bots when `fillBots` is on) and flips
   * benched players to the audience. Returns false when too few players are available.
   */
  #assignParticipants(slot: GameSlot): boolean {
    const { minPlayers, maxPlayers, teamSupport } = slot.module.manifest;
    const seated = this.room.seated().filter((s) => s.role === "player");
    const split = pickParticipants({
      seated: seated.map((s) => ({ id: s.id, seat: s.seat ?? 0 })),
      capacity: maxPlayers,
      satOut: this.#satOut,
      hostBenched: this.#hostBenched,
      rng: this.#rng,
    });
    const botCount = this.#fillBots ? Math.max(0, minPlayers - split.participants.length) : 0;
    if (
      split.participants.length + botCount < minPlayers ||
      split.participants.length + botCount === 0
    )
      return false;
    const seats: Seat[] = split.participants.map((p) => {
      const s = this.room.byId.get(p.id) as Session;
      return { id: s.id, name: s.name, seat: p.seat, colorSlot: p.seat % 8 };
    });
    const taken = new Set(seated.map((s) => s.seat));
    const bots = new Set<PlayerId>();
    for (let i = 0, seat = 0; i < botCount && seat < MAX_SEATS; seat++) {
      if (taken.has(seat)) continue;
      const id = `bot${i + 1}`;
      seats.push({ id, name: `Bot ${i + 1}`, seat, colorSlot: seat % 8 });
      bots.add(id);
      i++;
    }
    seats.sort((a, b) => a.seat - b.seat);
    slot.teams = teamSupport === "none" ? [] : this.#gameTeams(teamSupport);
    if (slot.teams.length > 0) this.#assignTeams(seats, slot.teams);
    slot.seats = seats;
    slot.real = new Set(split.participants.map((p) => p.id));
    slot.bots = bots;
    slot.benched = new Set(split.benched.map((p) => p.id));
    for (const id of slot.benched) {
      const s = this.room.byId.get(id);
      if (s !== undefined) this.#setRole(s, "audience", s.seat);
    }
    return true;
  }

  #roomTeams(): TeamInfo[] {
    const { mode, count } = this.room.config.teams;
    return mode === "none" ? [] : TEAM_DEFS.slice(0, count).map((t) => ({ ...t }));
  }

  #gameTeams(support: "optional" | "required"): TeamInfo[] {
    const teams = this.#roomTeams();
    if (teams.length > 0) return teams;
    return support === "required" ? TEAM_DEFS.slice(0, 2).map((t) => ({ ...t })) : [];
  }

  /** Room team assignments where set; everyone else is balanced onto the smallest team. */
  #assignTeams(seats: Seat[], teams: readonly TeamInfo[]): void {
    const ids = new Set(teams.map((t) => t.id));
    const size = new Map(teams.map((t) => [t.id, 0]));
    for (const seat of seats) {
      const teamId = this.room.byId.get(seat.id)?.teamId;
      if (teamId !== undefined && ids.has(teamId)) {
        seat.teamId = teamId;
        size.set(teamId, (size.get(teamId) ?? 0) + 1);
      }
    }
    for (const seat of seats) {
      if (seat.teamId !== undefined) continue;
      let best = teams[0]?.id as string;
      for (const t of teams) if ((size.get(t.id) ?? 0) < (size.get(best) ?? 0)) best = t.id;
      seat.teamId = best;
      size.set(best, (size.get(best) ?? 0) + 1);
    }
  }

  #startGame(slot: GameSlot, conn: Conn | null): void {
    if (this.#current !== slot || slot.runner !== null) return;
    const now = this.#clock.now();
    const content = this.#packs.forRoom(this.room.config.contentFilter, this.#used);
    let runner: GameRunner<unknown, unknown, unknown, unknown>;
    try {
      runner = new GameRunner(slot.module, {
        players: slot.seats,
        teams: slot.teams,
        options: slot.item.options,
        seed: this.#rng.int(2 ** 32),
        now,
        timerScale: this.room.config.timerScale,
        streamDelaySec: this.room.config.streamDelaySec,
        content: content.access,
        audienceCount: this.room.audienceCount(),
        dev: this.#o.dev ?? process.env["NODE_ENV"] !== "production",
        ...(this.#o.botDelayMs !== undefined ? { botDelayMs: this.#o.botDelayMs } : {}),
      });
    } catch (err) {
      const why = `${slot.gameId} could not start: ${err instanceof Error ? err.message : String(err)}`;
      if (conn !== null) this.#error(conn, "ILLEGAL", why);
      else this.#hostError(why);
      slot.ended = true;
      this.#finishGame(slot, { ranking: [] });
      return;
    }
    slot.runner = runner;
    slot.content = content;
    this.fanout.setSource(slot.gameId, runner);
    this.fanout.syncAllTopics();
    this.#setPhase("game", null, null);
    if (this.room.paused) this.#apply(runner.pause(now));
    this.#apply({ ok: true, effects: [...runner.setupEffects] });
    for (const id of slot.bots) this.#apply(runner.setBot(id, true, now));
    for (const id of slot.real) {
      const s = this.room.byId.get(id);
      if (s !== undefined && !s.connected) this.#apply(runner.playerLeave(id, now));
    }
  }

  #finishGame(slot: GameSlot, result: GameResult | null): void {
    if (slot.used) return;
    slot.used = true;
    this.#audience.closeAll("game");
    this.#moderation.clear();
    const scorable = [...slot.real]
      .filter((id) => this.room.byId.has(id))
      .map((id) => {
        const seat = slot.seats.find((s) => s.id === id);
        const s = this.room.byId.get(id) as Session;
        return { id, name: s.name, ...(seat?.teamId !== undefined ? { teamId: seat.teamId } : {}) };
      });
    const award = this.scoreboard.record(
      slot.gameId,
      result ?? { ranking: [] },
      scorable,
      this.room.config.scoring,
    );
    if (slot.runner !== null && slot.content !== null)
      slot.content.commit(slot.module.serialize(slot.runner.state));
    this.#played.add(slot.index);
    this.#satOut = new Set(slot.benched);
    // Seats whose owner never came back are released now that their bot finished the game.
    for (const id of slot.abandoned) {
      const s = this.room.byId.get(id);
      if (s !== undefined && !s.connected) {
        slot.real.delete(id);
        this.#manager.removeMember(this.room, s, CLOSE.NORMAL, "seat released");
      }
    }
    for (const id of slot.real) {
      const s = this.room.byId.get(id);
      if (s !== undefined && s.bot) s.bot = false;
    }
    this.fanout.queueFx([{ name: "results", data: { gameId: slot.gameId, points: award.points } }]);
    this.#clearWake();
    this.#snapshotNow();
    this.#setPhase("results", this.#timings.resultsMs, () => this.#toScoreboard(slot));
  }

  #toScoreboard(slot: GameSlot): void {
    this.#restoreBenched(slot);
    this.#seatPending();
    const playlist = this.room.config.playlist;
    const candidates = nextGameCandidates(playlist, this.#played, this.#playlistIndex);
    const auto = this.room.config.timerScale !== 0;
    if (candidates.length === 0) {
      this.#vote = null;
      this.#setPhase("scoreboard", auto ? this.#timings.scoreboardMs : null, () =>
        this.#endNight(),
      );
      return;
    }
    if (this.room.config.playlistMode === "audience-vote" && candidates.length > 1) {
      const now = this.#clock.now();
      const windowMs = NEXT_GAME_VOTE_MS + Math.round(this.room.config.streamDelaySec * 1000);
      this.#vote = { candidates };
      this.#setPhase("scoreboard", null, null);
      this.#audience.open(
        {
          pollId: NEXT_GAME_POLL_ID,
          kind: "vote",
          prompt: "What should we play next?",
          options: candidates.map((i) => {
            const item = playlist[i] as PlaylistItem;
            return {
              id: String(i),
              label: item.label ?? this.#o.games.get(item.gameId)?.manifest.name ?? item.gameId,
            };
          }),
          closesAtMs: now + windowMs,
          ...(auto ? {} : { closeOn: "event" as const }),
        },
        "room",
      );
      return;
    }
    this.#vote = null;
    this.#setPhase("scoreboard", auto ? this.#timings.scoreboardMs : null, () =>
      this.#advanceFromScoreboard(null),
    );
  }

  #afterVote(result: PollResult): void {
    const vote = this.#vote;
    if (vote === null || this.room.phase !== "scoreboard") return;
    this.#vote = null;
    const outcome = resolveNextGameVote(
      vote.candidates,
      result.tallies,
      result.total,
      this.room.config.audienceMin,
    );
    this.fanout.queueFx([
      { name: "nextGame", data: { index: outcome.index, counted: outcome.counted } },
    ]);
    this.#beginIntro(outcome.index, null);
  }

  #advanceFromScoreboard(conn: Conn | null): void {
    const next = nextInOrder(this.room.config.playlist, this.#played, this.#playlistIndex);
    if (next === null) return this.#endNight();
    this.#beginIntro(next, conn);
  }

  #endNight(): void {
    this.#vote = null;
    this.#setPhase("ended", null, null);
  }

  /** Benched players get their player role back (the game is over for them too). */
  #restoreBenched(slot: GameSlot): void {
    for (const id of slot.benched) {
      const s = this.room.byId.get(id);
      if (s !== undefined && s.role === "audience" && s.seat !== null)
        this.#setRole(s, "player", s.seat);
    }
    slot.benched.clear();
  }

  /** Seats raffle winners and promoted members, in order, while seats are free. */
  #seatPending(): void {
    const still: string[] = [];
    for (const id of this.#pendingSeats) {
      const s = this.room.byId.get(id);
      if (s === undefined || s.role === "player") continue;
      const seat = this.room.freeSeat();
      if (seat === null) {
        still.push(id);
        continue;
      }
      this.#queue = this.#queue.filter((q) => q !== id);
      this.#setRole(s, "player", seat);
    }
    this.#pendingSeats = still;
  }

  /** Fills free seats from the queue at a game boundary (`seatPick`). */
  #fillFromQueue(): void {
    const queue = this.#queue.filter((id) => {
      const s = this.room.byId.get(id);
      return s !== undefined && s.role === "audience" && s.queued && s.seat === null;
    });
    let free = 0;
    const taken = new Set(this.room.seated().map((s) => s.seat));
    for (let i = 0; i < this.room.config.maxPlayers; i++) if (!taken.has(i)) free++;
    for (const id of fillFromQueue(queue, free, this.room.config.seatPick, this.#rng)) {
      const s = this.room.byId.get(id);
      const seat = this.room.freeSeat();
      if (s === undefined || seat === null) break;
      this.#queue = this.#queue.filter((q) => q !== id);
      this.#setRole(s, "player", seat);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Anti-snipe (SPEC §7 `antiSnipe`)
  // -------------------------------------------------------------------------------------------

  #participantHashes(): Set<string> {
    const out = new Set<string>();
    for (const id of this.#current?.real ?? []) {
      const s = this.room.byId.get(id);
      if (s !== undefined) out.add(s.ipHash);
    }
    return out;
  }

  #updateRestricted(s: Session): void {
    const restricted =
      this.room.config.antiSnipe &&
      s.role === "audience" &&
      this.#participantHashes().has(s.ipHash);
    if (restricted) this.#restricted.add(s.id);
    else this.#restricted.delete(s.id);
  }

  #updateAllRestricted(): void {
    this.#restricted.clear();
    if (this.room.config.antiSnipe) {
      const hashes = this.#participantHashes();
      for (const s of this.room.byId.values())
        if (s.role === "audience" && hashes.has(s.ipHash)) this.#restricted.add(s.id);
    }
    this.fanout.syncAllTopics();
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  #hostError(msg: string): void {
    const host = this.room.host;
    if (host === undefined) return;
    for (const conn of host.conns.values()) this.#error(conn, "ILLEGAL", msg);
  }

  /**
   * Keeps `played` and the current index pointing at the same entries after the host edits
   * the playlist (entries match by game, options and label).
   */
  #remapPlaylist(next: readonly PlaylistItem[]): void {
    const prev = this.#lastPlaylist;
    const sig = (i: PlaylistItem): string => JSON.stringify([i.gameId, i.options, i.label ?? null]);
    const used = new Set<number>();
    const map = (oldIndex: number): number | null => {
      const item = prev[oldIndex];
      if (item === undefined) return null;
      const s = sig(item);
      for (let j = 0; j < next.length; j++) {
        const n = next[j];
        if (!used.has(j) && n !== undefined && sig(n) === s) {
          used.add(j);
          return j;
        }
      }
      return null;
    };
    const played = new Set<number>();
    const current = this.#playlistIndex >= 0 ? map(this.#playlistIndex) : null;
    for (const i of this.#played) {
      if (i === this.#playlistIndex) continue;
      const j = map(i);
      if (j !== null) played.add(j);
    }
    if (current !== null && this.#played.has(this.#playlistIndex)) played.add(current);
    if (this.#current !== null && current !== null) this.#current.index = current;
    this.#played = played;
    this.#playlistIndex =
      current ?? (this.#playlistIndex >= 0 ? Math.min(this.#playlistIndex, next.length - 1) : -1);
    this.#lastPlaylist = structuredClone([...next]);
  }

  #restore(r: ActorRecord): void {
    this.#playlistIndex = r.playlistIndex;
    this.#played = new Set(r.played);
    this.#satOut = new Set(r.satOut);
    this.#hostBenched = new Set(r.hostBenched);
    this.#fillBots = r.fillBots;
    this.#queue = [...r.queue];
    this.#pendingSeats = [...r.pendingSeats];
    this.#blockedIndex = r.blockedIndex;
    this.room.paused = r.paused;
    const c = r.current;
    if (c !== null) {
      const item = this.room.config.playlist[c.index];
      const module = this.#o.games.get(c.gameId);
      if (item !== undefined && module !== null) {
        const slot: GameSlot = {
          index: c.index,
          gameId: c.gameId,
          item,
          module,
          seats: c.seats,
          teams: c.teams,
          real: new Set(c.real),
          bots: new Set(c.bots),
          benched: new Set(c.benched),
          runner: null,
          content: null,
          used: c.ended,
          ended: c.ended,
          abandoned: new Set(c.abandoned),
        };
        if (c.runner !== null) {
          slot.content = this.#packs.forRoom(this.room.config.contentFilter, this.#used);
          slot.runner = GameRunner.restore(module, c.runner, {
            content: slot.content.access,
            dev: this.#o.dev ?? process.env["NODE_ENV"] !== "production",
            ...(this.#o.botDelayMs !== undefined ? { botDelayMs: this.#o.botDelayMs } : {}),
          });
          this.fanout.setSource(c.gameId, slot.runner);
        }
        this.#current = slot;
      }
    }
    // Phase timers resume with their remaining time; a restored vote falls back to playlist order.
    const remaining = r.phaseRemainingMs;
    const phase = this.room.phase;
    const slot = this.#current;
    if (phase === "intro" && slot !== null && slot.runner === null)
      this.#setPhase("intro", remaining ?? 0, () => this.#startGame(slot, null));
    else if (phase === "results" && slot !== null)
      this.#setPhase("results", remaining ?? 0, () => this.#toScoreboard(slot));
    else if (phase === "scoreboard" && r.vote !== null) {
      this.#vote = { candidates: r.vote.candidates };
      this.#setPhase("scoreboard", remaining ?? 0, () =>
        this.#afterVote({ pollId: NEXT_GAME_POLL_ID, kind: "vote", total: 0, tallies: {} }),
      );
    } else if (phase === "scoreboard" && remaining !== null)
      this.#setPhase("scoreboard", remaining, () => this.#advanceFromScoreboard(null));
    this.#rescheduleWake();
  }
}
