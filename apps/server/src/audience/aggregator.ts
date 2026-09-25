/**
 * The AudienceAggregator (SPEC §4, ROADMAP M1-03): the room's {@link AudiencePort}. Games never
 * see individual votes; they emit `audience.*` effects and receive one aggregate
 * {@link PollResult} per poll.
 *
 * - **Every poll kind** (`vote`, `predict`, `quiz`, `dial`, `guess`, `tap`) lives in
 *   `./polls/`; this class owns their lifecycle: open, deadline, close, resolve.
 * - **One input per `audId`** (the session decides identity, never the message), changeable
 *   until close; a `quiz` answer locks on the first one.
 * - **Tallies** go out at most every {@link TALLY_INTERVAL_MS} (≤ 4 Hz) per poll and only when
 *   something changed; a `hideLive` poll sends only `total` until close; `quiz` sends only the
 *   answered count until resolve. The `guess` answers and guess texts never leave the server.
 * - **Stream delay** (SPEC §4) is added exactly once, by the engine: every timed poll window
 *   is built with `ctx.timing.input(base)` (= `base × timerScale + streamDelay`), and room
 *   polls (the next-game vote) include it in their window too. So a `closeOn: "deadline"`
 *   poll closes at the `closesAtMs` it was opened with, which already carries the delay, and
 *   phones count down to the same instant the game's own timers use. `closeOn: "event"` polls
 *   ignore the deadline, close the instant the game says so, and discard every input
 *   received after that.
 * - **Minimum audience**: every result carries `counted: total >= audienceMin`; below it the
 *   vote is shown but does not count.
 * - **Seeds and play-along points** feed the {@link Leaderboard}; each scored member gets a
 *   personal `pollEnd` with `you` (correct, points, Seeds balance).
 * - **Reactions** are batched every 500 ms ({@link ReactionAggregator}).
 * - Marble Rally's enrolment and direct actions pass through to the game.
 *
 * Audience sockets are rate limited to 5 msg/s by the room manager before anything gets here
 * (`audienceMsgPerSec`); the per-kind limits (1 guess per 1.5 s, 5 taps/s) are enforced here.
 *
 * @module
 */
import type { AudId, PublicPollResult, ReactionId } from "@sg/shared";
import type { Effect, PollResult, PollSpec } from "@sg/engine";
import {
  PausableTimer,
  publicPoll,
  TALLY_INTERVAL_MS,
  type AudienceContext,
  type AudienceFactory,
  type AudienceMessage,
  type AudiencePort,
  type PollSource,
} from "../room.ts";
import type { Session } from "../session.ts";
import { Leaderboard } from "./leaderboard.ts";
import {
  createPoll,
  type PollEnv,
  type PollKindState,
  type Voter,
  type You,
} from "./polls/index.ts";
import { ReactionAggregator, REACTION_INTERVAL_MS } from "./reactions.ts";
import { DEFAULT_PREDICT_STAKE } from "./seeds.ts";

/** A poll result with the minimum-audience flag (SPEC §4). */
export type AudiencePollResult = PollResult & {
  /** `total >= audienceMin`: below it the vote is shown but must not affect scoring. */
  counted: boolean;
};

/** The broadcast form of {@link AudiencePollResult}. */
export type AudiencePublicResult = PublicPollResult & { counted: boolean };

/** Tuning for {@link AudienceAggregator}; the defaults follow SPEC §4. */
export interface AggregatorOptions {
  /** `predict` stake in Seeds (SPEC §4: 100, host-configurable). */
  predictStake?: number;
  /** Minimum ms between two tallies of one poll (SPEC §4: ≤ 4 Hz → 250). */
  tallyIntervalMs?: number;
  /** Reaction batch interval (SPEC §4: 500 ms). */
  reactionIntervalMs?: number;
  /** The room's audience leaderboard (default: a fresh one per room). */
  leaderboard?: Leaderboard;
}

/** Counters for tests and the perf lab. */
export interface AggregatorStats {
  polls: number;
  tallies: number;
  reactionBatches: number;
  inputs: number;
  /** Inputs dropped: invalid, locked, cooldown, rate, or for a poll that is not open. */
  dropped: number;
  /** Inputs for an event-closed poll received after its closing event (SPEC §4). */
  late: number;
}

interface LivePoll {
  state: PollKindState;
  source: PollSource;
  openedAt: number;
  closedAt: number | null;
  timer: PausableTimer | null;
  tallyTimer: PausableTimer | null;
  lastTallyAt: number;
  dirty: boolean;
  result: AudiencePollResult | null;
}

interface Enrolment {
  open: boolean;
  cap: number;
  entrants: Map<AudId, { audId: AudId; name: string; skin: number }>;
  timer: PausableTimer | null;
}

/** The room's audience aggregator. */
export class AudienceAggregator implements AudiencePort {
  readonly leaderboard: Leaderboard;
  readonly stats: AggregatorStats = {
    polls: 0,
    tallies: 0,
    reactionBatches: 0,
    inputs: 0,
    dropped: 0,
    late: 0,
  };
  readonly #ctx: AudienceContext;
  readonly #polls = new Map<string, LivePoll>();
  readonly #reactions: ReactionAggregator;
  readonly #predictStake: number;
  readonly #tallyIntervalMs: number;
  #enrolment: Enrolment | null = null;
  #paused = false;

  constructor(ctx: AudienceContext, o: AggregatorOptions = {}) {
    this.#ctx = ctx;
    this.leaderboard = o.leaderboard ?? new Leaderboard();
    this.#predictStake = Math.max(0, Math.trunc(o.predictStake ?? DEFAULT_PREDICT_STAKE));
    this.#tallyIntervalMs = Math.max(TALLY_INTERVAL_MS, o.tallyIntervalMs ?? TALLY_INTERVAL_MS);
    this.#reactions = new ReactionAggregator(
      ctx.clock,
      (counts) => this.#sendReactions(counts),
      o.reactionIntervalMs ?? REACTION_INTERVAL_MS,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Poll lifecycle
  // -------------------------------------------------------------------------------------------

  open(spec: PollSpec, source: PollSource): void {
    const existing = this.#polls.get(spec.pollId);
    if (existing !== undefined && existing.result === null) return;
    const now = this.#ctx.clock.now();
    const poll: LivePoll = {
      state: createPoll(spec, now),
      source,
      openedAt: now,
      closedAt: null,
      timer: null,
      tallyTimer: null,
      lastTallyAt: Number.NEGATIVE_INFINITY,
      dirty: false,
      result: null,
    };
    this.#polls.set(spec.pollId, poll);
    this.stats.polls++;
    if (spec.closeOn !== "event")
      poll.timer = new PausableTimer(
        this.#ctx.clock,
        spec.closesAtMs - now,
        () => this.close(spec.pollId),
        this.#paused,
      );
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
    poll.tallyTimer = null;
    poll.closedAt = this.#ctx.clock.now();
    const counted = this.#counted(poll.state.result().total);
    const result: AudiencePollResult = { ...poll.state.result(), counted };
    poll.result = result;
    const pub: AudiencePublicResult = { ...poll.state.closedPublic(), counted };
    this.#ctx.fanout.toAudience({ t: "pollEnd", pollId, result: pub }, { stage: true });
    this.#sendYou(pollId, pub, poll.state.onClose(this.#env()));
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
    const { result, you } = poll.state.resolve(effect, this.#env());
    const pub: AudiencePublicResult = { ...result, counted: poll.result.counted };
    this.#ctx.fanout.toAudience(
      { t: "pollEnd", pollId: effect.pollId, result: pub },
      { stage: true },
    );
    this.#sendYou(effect.pollId, pub, you);
  }

  // -------------------------------------------------------------------------------------------
  // Enrolment, awards, inputs
  // -------------------------------------------------------------------------------------------

  enroll(effect: Extract<Effect, { type: "audience.enroll" }>): void {
    if (effect.open) {
      this.#enrolment?.timer?.cancel();
      const e: Enrolment = {
        open: true,
        cap: effect.cap ?? Number.POSITIVE_INFINITY,
        entrants: this.#enrolment?.entrants ?? new Map(),
        timer: null,
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

  award(effect: Extract<Effect, { type: "audience.award" }>): void {
    for (const [id, points] of Object.entries(effect.points)) {
      const name = this.#ctx.room.byId.get(id)?.name;
      this.leaderboard.addPoints(id, points, name);
    }
  }

  input(session: Session, msg: AudienceMessage): void {
    this.stats.inputs++;
    switch (msg.t) {
      case "aud":
      case "tap":
        return this.#pollInput(session, msg);
      case "react":
        if (!this.#reactions.add(msg.e)) this.stats.dropped++;
        return;
      case "enroll": {
        const e = this.#enrolment;
        if (
          e === null ||
          !e.open ||
          e.entrants.has(session.id) ||
          e.entrants.size >= e.cap ||
          !Number.isInteger(msg.skin)
        ) {
          this.stats.dropped++;
          return;
        }
        e.entrants.set(session.id, { audId: session.id, name: session.name, skin: msg.skin });
        return;
      }
      case "audAct":
        return this.#ctx.onAction(session.id, msg.a);
    }
  }

  // -------------------------------------------------------------------------------------------
  // BRB and teardown
  // -------------------------------------------------------------------------------------------

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
    const now = this.#ctx.clock.now();
    for (const p of this.#polls.values()) {
      p.tallyTimer?.resume();
      if (p.timer === null || p.result !== null) continue;
      p.timer.resume();
      // The deadline moved by the length of the break: re-announce it so phones count down right.
      const spec: PollSpec = { ...p.state.spec, closesAtMs: now + p.timer.remaining };
      this.#ctx.fanout.toAudience({ t: "poll", poll: publicPoll(spec) }, { stage: true });
    }
    this.#enrolment?.timer?.resume();
  }

  dispose(): void {
    for (const p of this.#polls.values()) {
      p.timer?.cancel();
      p.tallyTimer?.cancel();
    }
    this.#enrolment?.timer?.cancel();
    this.#reactions.dispose();
    this.#polls.clear();
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  #counted(total: number): boolean {
    return total >= this.#ctx.room.config.audienceMin;
  }

  #env(): PollEnv {
    return {
      now: this.#ctx.clock.now(),
      leaderboard: this.leaderboard,
      predictStake: this.#predictStake,
    };
  }

  #pollInput(session: Session, msg: Extract<AudienceMessage, { t: "aud" } | { t: "tap" }>): void {
    const poll = this.#polls.get(msg.pollId);
    if (poll === undefined || poll.result !== null) {
      // An event-closed poll discards anything received after the closing event.
      if (poll?.state.spec.closeOn === "event") this.stats.late++;
      this.stats.dropped++;
      return;
    }
    const voter: Voter = { audId: session.id, name: session.name, teamId: session.teamId };
    const env = this.#env();
    const out =
      msg.t === "aud" ? poll.state.vote(voter, msg.choice, env) : poll.state.tap(voter, msg.n, env);
    if (!out.ok) {
      this.stats.dropped++;
      return;
    }
    this.leaderboard.see(session.id, session.name);
    if (out.cue !== undefined)
      this.#ctx.fanout.toMember(session.id, {
        t: "fx",
        events: [{ name: out.cue.name, data: { pollId: msg.pollId } }],
      });
    if (out.changed) this.#scheduleTally(poll);
  }

  #scheduleTally(poll: LivePoll): void {
    poll.dirty = true;
    if (poll.tallyTimer !== null) return;
    const wait = Math.max(0, poll.lastTallyAt + this.#tallyIntervalMs - this.#ctx.clock.now());
    poll.tallyTimer = new PausableTimer(
      this.#ctx.clock,
      wait,
      () => {
        poll.tallyTimer = null;
        if (poll.result !== null || !poll.dirty) return;
        poll.dirty = false;
        poll.lastTallyAt = this.#ctx.clock.now();
        const live = poll.state.live();
        const hidden = poll.state.spec.hideLive === true;
        this.stats.tallies++;
        this.#ctx.fanout.toAudience(
          {
            t: "tally",
            pollId: poll.state.spec.pollId,
            tallies: hidden ? {} : live.tallies,
            total: live.total,
          },
          { stage: true },
        );
      },
      this.#paused,
    );
  }

  #sendYou(pollId: string, result: AudiencePublicResult, you: Map<AudId, You>): void {
    for (const [id, mine] of you) {
      const session = this.#ctx.room.byId.get(id);
      if (session === undefined || !session.connected) continue;
      const seeds = mine.seeds ?? this.leaderboard.seeds.balance(id);
      this.#ctx.fanout.toMember(id, { t: "pollEnd", pollId, result, you: { ...mine, seeds } });
    }
  }

  #sendReactions(counts: Partial<Record<ReactionId, number>>): void {
    this.stats.reactionBatches++;
    this.#ctx.fanout.broadcast({ t: "reactions", counts }, { cosmetic: true });
  }
}

/** A room audience factory that installs an {@link AudienceAggregator} per room. */
export function createAudienceAggregator(o: AggregatorOptions = {}): AudienceFactory {
  return (ctx) => new AudienceAggregator(ctx, o);
}
