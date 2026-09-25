/**
 * The shared shape of every poll kind (SPEC §4). A poll kind validates and records inputs,
 * reports its live tally, builds the aggregate {@link PollResult} the game receives, and does
 * the platform-side scoring at close (`guess`) or on `audience.resolve` (`predict`, `quiz`,
 * `dial`). Timers, broadcasting, `hideLive`, stream delay and `audienceMin` belong to the
 * aggregator, so every kind stays a small, synchronous, easily tested state machine.
 *
 * @module
 */
import type { AudId, PublicPollResult, TeamId } from "@sg/shared";
import type { Effect, PollResult, PollSpec } from "@sg/engine";
import type { Leaderboard } from "../leaderboard.ts";

/** The audience member behind one input (identity comes from the session, never the message). */
export interface Voter {
  audId: AudId;
  name: string;
  teamId: TeamId | undefined;
}

/** A member's personal outcome of a poll, sent in their own `pollEnd` (`you`). */
export interface You {
  correct?: boolean;
  points?: number;
  seeds?: number;
}

/** What a `tally` frame carries before the aggregator applies `hideLive`. */
export interface Live {
  tallies: Record<string, number>;
  total: number;
}

/** The result of one input. `changed` means the live tally may differ (schedule a tally). */
export type InputOutcome =
  | { ok: false; reason: InputRejection }
  | { ok: true; changed: boolean; cue?: { name: string; data?: unknown } };

/** Why an input was dropped (silently; the audience never gets an error frame). */
export type InputRejection =
  | "kind" // wrong message kind for this poll (e.g. `tap` on a vote)
  | "invalid" // not an option / out of range / too long
  | "locked" // quiz answered, guess already correct
  | "cooldown" // guess faster than 1 per 1.5 s
  | "rate"; // tap over 5/s

/** Room-wide state a poll kind may read or change. */
export interface PollEnv {
  /** Server receive time of the input (or the close / resolve). */
  now: number;
  leaderboard: Leaderboard;
  /** The `predict` stake (SPEC §4: 100 Seeds, host-configurable). */
  predictStake: number;
}

/** The `audience.resolve` effect. */
export type ResolveEffect = Extract<Effect, { type: "audience.resolve" }>;

/** One poll kind's state machine. */
export interface PollKindState {
  /** The effective spec (stream delay applied); `accept` stays server-side. */
  readonly spec: PollSpec;
  /** A `{ t: "aud" }` choice. */
  vote(voter: Voter, choice: string | number, env: PollEnv): InputOutcome;
  /** A `{ t: "tap" }` batch. */
  tap(voter: Voter, n: number, env: PollEnv): InputOutcome;
  /** The live tally (before `hideLive`). */
  live(): Live;
  /** The aggregate result the game receives. */
  result(): PollResult;
  /** The distribution broadcast in `pollEnd` at close (quiz withholds it until resolve). */
  closedPublic(): PublicPollResult;
  /** Platform-side scoring when the poll closes (guess). */
  onClose(env: PollEnv): Map<AudId, You>;
  /**
   * Platform-side scoring on `audience.resolve`. Returns the public result to re-broadcast
   * (with `correct`) and each member's outcome.
   */
  resolve(effect: ResolveEffect, env: PollEnv): { result: PublicPollResult; you: Map<AudId, You> };
}

/** One recorded input. */
export interface Ballot<T> {
  value: T;
  /** Server receive time of the (latest) input. */
  at: number;
  teamId: TeamId | undefined;
  name: string;
}

/**
 * Base for kinds that keep one ballot per `audId`: per-option (or per-bin) counting with
 * per-team splits for `teamSplit` polls, and no-op defaults for the optional hooks.
 */
export abstract class BallotPoll<T> implements PollKindState {
  readonly spec: PollSpec;
  readonly ballots = new Map<AudId, Ballot<T>>();

  constructor(spec: PollSpec) {
    this.spec = spec;
  }

  abstract vote(voter: Voter, choice: string | number, env: PollEnv): InputOutcome;

  tap(_voter: Voter, _n: number, _env: PollEnv): InputOutcome {
    return { ok: false, reason: "kind" };
  }

  live(): Live {
    return { tallies: this.count().tallies, total: this.ballots.size };
  }

  result(): PollResult {
    const { tallies, byTeam } = this.count();
    const r: PollResult = {
      pollId: this.spec.pollId,
      kind: this.spec.kind,
      total: this.ballots.size,
      tallies,
    };
    if (this.spec.teamSplit === true) r.byTeam = byTeam;
    return r;
  }

  closedPublic(): PublicPollResult {
    return { ...this.result() };
  }

  onClose(_env: PollEnv): Map<AudId, You> {
    return new Map();
  }

  resolve(
    effect: ResolveEffect,
    _env: PollEnv,
  ): { result: PublicPollResult; you: Map<AudId, You> } {
    const result: PublicPollResult = { ...this.result() };
    if (effect.correct !== undefined) result.correct = effect.correct;
    return { result, you: new Map() };
  }

  /** The key a ballot counts under (`null`: not counted). */
  protected keyOf(b: Ballot<T>): string | null {
    return typeof b.value === "string" ? b.value : null;
  }

  /** Keys that always appear in the tallies, even at 0 (options, dial bins). */
  protected baseKeys(): string[] {
    return (this.spec.options ?? []).map((o) => o.id);
  }

  /** Per-key counts, plus per-team counts. */
  protected count(): {
    tallies: Record<string, number>;
    byTeam: Record<TeamId, Record<string, number>>;
  } {
    const tallies: Record<string, number> = {};
    for (const k of this.baseKeys()) tallies[k] = 0;
    const byTeam: Record<TeamId, Record<string, number>> = {};
    for (const b of this.ballots.values()) {
      const key = this.keyOf(b);
      if (key === null) continue;
      tallies[key] = (tallies[key] ?? 0) + 1;
      if (this.spec.teamSplit === true && b.teamId !== undefined) {
        const t = (byTeam[b.teamId] ??= {});
        t[key] = (t[key] ?? 0) + 1;
      }
    }
    return { tallies, byTeam };
  }

  /** True when `choice` is one of the poll's option ids. */
  protected isOption(choice: string | number): choice is string {
    return typeof choice === "string" && (this.spec.options ?? []).some((o) => o.id === choice);
  }

  /** Records a ballot; returns whether the counted value changed. */
  protected record(voter: Voter, value: T, now: number): boolean {
    const prev = this.ballots.get(voter.audId);
    this.ballots.set(voter.audId, { value, at: now, teamId: voter.teamId, name: voter.name });
    return prev === undefined || prev.value !== value || prev.teamId !== voter.teamId;
  }
}
