/**
 * The sim runner (ROADMAP M0-04, DOD G5/G14): plays whole games on a real {@link GameRunner}
 * against a **virtual clock**, with
 *
 * - the **timed bot model**: every seat is a bot that acts at a random point between 25% and
 *   70% of its input window (never instantly), through the wire (`JSON` round trip +
 *   `parseAction`);
 * - a simulated **audience** of 50 bots that answers every open poll, joins every enrolment,
 *   and (with a hook) sends direct actions: a stand-in for the platform AudienceAggregator;
 * - a **timeline** of phases, open audience interactions and per-player input windows, from
 *   which the **pacing report** is computed: `{ durationMs, audienceIdleMaxMs,
 *   playerIdleMaxMs, timeline }`.
 *
 * {@link pacingReport} replays many seeded games per player count and {@link checkPacing}
 * applies the G14 limits (median duration within `estMinutes`, p90 ≤ upper × 1.25, audience
 * idle ≤ 30 s, player idle ≤ 45 s, excluding the declared `intro` / `final` phases).
 *
 * @module
 */
import {
  createRng,
  DEFAULT_ROOM_CONFIG,
  type AudId,
  type PlayerId,
  type Rng,
  type RoomConfig,
} from "@sg/shared";
import type {
  ContentAccess,
  Effect,
  GameModule,
  GameResult,
  PollResult,
  PollSpec,
  Seat,
} from "../game-module.ts";
import { GameRunner } from "../runner.ts";
import { makeSeats } from "./run-script.ts";

/** One stretch on the sim timeline (virtual ms since the game started). */
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

/** What `onStep` receives after every sim event. */
export interface SimStepInfo<S> {
  state: S;
  /** Virtual ms since start. */
  elapsed: number;
  effects: readonly Effect[];
  runner: GameRunner<S, unknown, unknown, unknown>;
}

/** How seats choose actions: the module's `bot()` (default), or half bot / half random legal. */
export type ActionPolicy = "bot" | "mixed";

/** Options for {@link simulateGame}. */
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

/** The outcome of one simulated game. */
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

const DEFAULT_EPOCH = 1_000_000;

interface SimPoll {
  spec: PollSpec;
  openedAt: number;
}

interface Interval {
  start: number;
  end: number;
}

/**
 * Plays one game to its end with timed bots and a simulated audience.
 */
export function simulateGame<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: SimOptions<S, O>,
): SimResult<S> {
  const seats =
    typeof opts.players === "number"
      ? makeSeats(opts.players)
      : opts.players.map((p) => ({ ...p }));
  const t0 = DEFAULT_EPOCH;
  const audienceBots = opts.audienceBots ?? 50;
  const [winMin, winMax] = opts.botWindow ?? [0.25, 0.7];
  const defaultWindowMs = opts.defaultWindowMs ?? 10_000;
  const minReactionMs = opts.minReactionMs ?? 250;
  const maxSteps = opts.maxSteps ?? 10_000;
  const maxDurationMs = opts.maxDurationMs ?? 4 * 60 * 60 * 1000;
  const excludePhases = new Set(opts.excludePhases ?? ["intro", "final"]);
  const hostAdvanceMs = opts.hostAdvanceMs ?? 5_000;
  const timerScale = opts.timerScale ?? DEFAULT_ROOM_CONFIG.timerScale;
  const hostAdvance = opts.hostAdvance ?? timerScale === 0;
  const policy = opts.policy ?? "bot";
  const simRng = createRng(`sim:${String(opts.seed)}`);
  const seatRng = simRng.fork("seats");
  const audRng = simRng.fork("audience");
  const content = typeof opts.content === "function" ? opts.content() : opts.content;

  const runner = new GameRunner(module, {
    players: seats,
    seed: opts.seed,
    now: t0,
    options: opts.options,
    timerScale,
    streamDelaySec: opts.streamDelaySec ?? DEFAULT_ROOM_CONFIG.streamDelaySec,
    ...(content !== undefined ? { content } : {}),
    audienceCount: audienceBots,
    dev: opts.dev ?? true,
  });
  const anyRunner = runner as unknown as GameRunner<S, unknown, unknown, unknown>;

  let now = t0;
  let hash = 0x811c9dc5;
  const hashes: string[] = [];
  const timeline: TimelineEntry[] = [];
  const polls = new Map<string, SimPoll>();
  let pollsAnswered = 0;
  let enroll = null as { openedAt: number; closesAt: number | null; cap: number | null } | null;
  const pending = new Map<PlayerId, number>();
  /** The input window (phase + deadline) each pending action was scheduled for. */
  const pendingSig = new Map<PlayerId, string>();
  /** Seats whose bot returned null: no retry until the state changes. */
  const idleUntilChange = new Map<PlayerId, S>();
  let actions = 0;
  let illegalActions = 0;
  const illegalSamples: string[] = [];
  let failure: string | undefined;
  let hostAdvanceAt: number | null = null;
  let nextDirectAt: number | null = null;

  // Open intervals for the timeline.
  let phase = null as { name: string; start: number } | null;
  const inputOpen = new Map<PlayerId, number>();
  const involvedOpen = new Map<PlayerId, number>();
  let directOpenSince: number | null = null;

  const rel = (t: number): number => t - t0;
  const audienceIds: AudId[] = Array.from({ length: audienceBots }, (_, i) => `aud${i + 1}`);

  const mix = (text: string): void => {
    let h = hash;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    hash = h >>> 0;
  };

  const closePollTimeline = (pollId: string, at: number): void => {
    const poll = polls.get(pollId);
    if (poll === undefined) return;
    polls.delete(pollId);
    timeline.push({
      kind: "audience",
      what: "poll",
      id: pollId,
      pollKind: poll.spec.kind,
      startMs: rel(poll.openedAt),
      endMs: rel(at),
    });
  };

  const deliverPoll = (pollId: string, at: number): Effect[] => {
    const poll = polls.get(pollId);
    if (poll === undefined) return [];
    closePollTimeline(pollId, at);
    pollsAnswered++;
    return runner.audienceResult(pollResult(poll.spec, audienceIds, audRng), at).effects;
  };

  const closeEnroll = (at: number): Effect[] => {
    if (enroll === null) return [];
    const cap = enroll.cap ?? audienceBots;
    timeline.push({
      kind: "audience",
      what: "enroll",
      id: `enroll@${rel(enroll.openedAt)}`,
      startMs: rel(enroll.openedAt),
      endMs: rel(at),
    });
    enroll = null;
    const entrants = audienceIds.slice(0, Math.max(0, cap)).map((audId, i) => ({
      audId,
      name: `Viewer ${i + 1}`,
      skin: i % 8,
    }));
    return runner.audienceEnroll(entrants, at).effects;
  };

  /** Routes runner effects the way the platform would; returns follow-up effects. */
  const route = (effects: readonly Effect[], at: number): void => {
    const queue = [...effects];
    while (queue.length > 0) {
      const effect = queue.shift() as Effect;
      mix(JSON.stringify(effect));
      switch (effect.type) {
        case "audience.open":
          polls.set(effect.poll.pollId, { spec: effect.poll, openedAt: at });
          break;
        case "audience.close":
          queue.push(...deliverPoll(effect.pollId, at));
          break;
        case "audience.enroll":
          if (effect.open) {
            enroll = {
              openedAt: at,
              closesAt: effect.closesAtMs ?? null,
              cap: effect.cap ?? null,
            };
          } else {
            queue.push(...closeEnroll(at));
          }
          break;
        default:
          break;
      }
    }
  };

  const inputWindow = (player: PlayerId): number => {
    const view = runner.view({ role: "player", id: player }) as unknown;
    const deadline = readDeadline(view) ?? readDeadline(runner.view({ role: "stage" }) as unknown);
    if (deadline === null || deadline <= now) return defaultWindowMs;
    return deadline - now;
  };

  const inputSignature = (player: PlayerId, phaseName: string): string =>
    `${phaseName}|${readDeadline(runner.view({ role: "player", id: player }) as unknown) ?? "-"}`;

  /** Re-reads the state: phases, input windows, involvement, direct windows, bot schedule. */
  const observe = (): void => {
    const state = runner.state;
    const stage = runner.view({ role: "stage" }) as unknown;
    const phaseName = readPhase(stage);
    if (phase === null || phase.name !== phaseName) {
      if (phase !== null) {
        timeline.push({
          kind: "phase",
          phase: phase.name,
          startMs: rel(phase.start),
          endMs: rel(now),
        });
      }
      phase = { name: phaseName, start: now };
    }
    for (const seat of seats) {
      const has = runner.ended ? false : module.legalActions(state, seat.id).length > 0;
      const since = inputOpen.get(seat.id);
      if (has && since === undefined) inputOpen.set(seat.id, now);
      if (!has && since !== undefined) {
        timeline.push({ kind: "input", playerId: seat.id, startMs: rel(since), endMs: rel(now) });
        inputOpen.delete(seat.id);
      }
      // A new input window (another phase or deadline) re-rolls the reaction time within it.
      const sig = has ? inputSignature(seat.id, phaseName) : "";
      if (has && pending.has(seat.id) && pendingSig.get(seat.id) !== sig) pending.delete(seat.id);
      if (!has) {
        pending.delete(seat.id);
        idleUntilChange.delete(seat.id);
      } else if (!pending.has(seat.id)) {
        pendingSig.set(seat.id, sig);
        const blockedOn = idleUntilChange.get(seat.id);
        if (blockedOn === undefined || blockedOn !== state) {
          idleUntilChange.delete(seat.id);
          const frac = winMin + seatRng.float() * (winMax - winMin);
          pending.set(
            seat.id,
            now + Math.max(minReactionMs, Math.round(frac * inputWindow(seat.id))),
          );
        }
      }
      if (opts.involves !== undefined) {
        const inv = !runner.ended && opts.involves(state, seat.id);
        const invSince = involvedOpen.get(seat.id);
        if (inv && invSince === undefined) involvedOpen.set(seat.id, now);
        if (!inv && invSince !== undefined) {
          timeline.push({
            kind: "involved",
            playerId: seat.id,
            startMs: rel(invSince),
            endMs: rel(now),
          });
          involvedOpen.delete(seat.id);
        }
      }
    }
    if (opts.audienceDirectOpen !== undefined) {
      const open = !runner.ended && opts.audienceDirectOpen(state);
      if (open && directOpenSince === null) {
        directOpenSince = now;
        nextDirectAt = now + 1_000;
      }
      if (!open && directOpenSince !== null) {
        timeline.push({
          kind: "audience",
          what: "direct",
          id: `direct@${rel(directOpenSince)}`,
          startMs: rel(directOpenSince),
          endMs: rel(now),
        });
        directOpenSince = null;
        nextDirectAt = null;
      }
    }
  };

  const afterEvent = (effects: readonly Effect[]): void => {
    route(effects, now);
    mix(module.serialize(runner.state));
    if (opts.recordHashes === true) hashes.push(hash.toString(16));
    observe();
    opts.onStep?.({ state: runner.state, elapsed: rel(now), effects, runner: anyRunner });
  };

  afterEvent(runner.setupEffects);

  while (!runner.ended) {
    if (runner.stats.steps > maxSteps) {
      failure = `maxSteps: more than ${maxSteps} runner steps`;
      break;
    }
    if (now - t0 > maxDurationMs) {
      failure = `maxDuration: still running after ${maxDurationMs} ms`;
      break;
    }
    // The earliest thing that happens next.
    type EventKind = "runner" | "poll" | "enroll" | "seat" | "direct" | "host";
    const next = { at: Infinity, kind: null as EventKind | null, who: null as string | null };
    const offer = (t: number | null, k: EventKind, w: string | null = null): void => {
      if (t !== null && t < next.at) {
        next.at = t;
        next.kind = k;
        next.who = w;
      }
    };
    offer(runner.nextEventAt(), "runner");
    for (const [pollId, poll] of polls) {
      if (poll.spec.closeOn !== "event") offer(poll.spec.closesAtMs, "poll", pollId);
    }
    if (enroll?.closesAt != null) offer(enroll.closesAt, "enroll");
    for (const [player, t] of pending) offer(t, "seat", player);
    offer(nextDirectAt, "direct");

    if (next.kind === null) {
      // Nothing scheduled: the host moves things along (timerScale 0), or the game is stuck.
      if (!hostAdvance || module.onHostCommand === undefined) {
        failure = hostAdvance
          ? "stalled: nothing scheduled and no onHostCommand"
          : "stalled: nothing scheduled (timers are on, so the host does not advance)";
        break;
      }
      hostAdvanceAt ??= now + hostAdvanceMs;
      offer(hostAdvanceAt, "host");
    } else {
      hostAdvanceAt = null;
    }

    now = Math.max(now, next.at);
    const { kind, who } = next;
    const fired = runner.advance(now).effects;
    let effects: Effect[] = [...fired];
    switch (kind) {
      case "poll":
        // Timers that fell due may already have closed it; otherwise the platform closes it.
        route(effects, now);
        effects = who !== null && polls.has(who) ? deliverPoll(who, now) : [];
        break;
      case "enroll":
        route(effects, now);
        effects =
          enroll !== null && enroll.closesAt !== null && enroll.closesAt <= now
            ? closeEnroll(now)
            : [];
        break;
      case "seat": {
        const player: PlayerId = who ?? "";
        pending.delete(player);
        if (runner.ended || module.legalActions(runner.state, player).length === 0) break;
        const action = chooseAction(module, runner.state, player, seatRng, policy);
        if (action === null) {
          idleUntilChange.set(player, runner.state);
          break;
        }
        const res = runner.act(player, JSON.parse(JSON.stringify(action)) as unknown, now);
        actions++;
        if (!res.ok) {
          illegalActions++;
          if (illegalSamples.length < 5) {
            illegalSamples.push(`${player} ${JSON.stringify(action)} -> ${res.err ?? "?"}`);
          }
          idleUntilChange.set(player, runner.state);
        }
        effects.push(...res.effects);
        break;
      }
      case "direct": {
        nextDirectAt = now + 1_000;
        if (opts.audienceAction !== undefined) {
          for (let i = 0; i < 5; i++) {
            const audId = audRng.pick(audienceIds);
            const action = opts.audienceAction(runner.state, audId, audRng);
            if (action !== undefined && action !== null) {
              effects.push(...runner.audienceAction(audId, action, now).effects);
            }
          }
        }
        break;
      }
      case "host":
        hostAdvanceAt = null;
        effects.push(...runner.hostCommand({ c: "forceAdvance" }, now).effects);
        break;
      default:
        break;
    }
    afterEvent(effects);
  }

  // Close every open interval at the end.
  const end = now;
  if (phase !== null) {
    timeline.push({ kind: "phase", phase: phase.name, startMs: rel(phase.start), endMs: rel(end) });
  }
  for (const [player, since] of inputOpen) {
    timeline.push({ kind: "input", playerId: player, startMs: rel(since), endMs: rel(end) });
  }
  for (const [player, since] of involvedOpen) {
    timeline.push({ kind: "involved", playerId: player, startMs: rel(since), endMs: rel(end) });
  }
  for (const pollId of [...polls.keys()]) closePollTimeline(pollId, end);
  if (enroll !== null) {
    timeline.push({
      kind: "audience",
      what: "enroll",
      id: `enroll@${rel(enroll.openedAt)}`,
      startMs: rel(enroll.openedAt),
      endMs: rel(end),
    });
  }
  if (directOpenSince !== null) {
    timeline.push({
      kind: "audience",
      what: "direct",
      id: `direct@${rel(directOpenSince)}`,
      startMs: rel(directOpenSince),
      endMs: rel(end),
    });
  }
  timeline.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const durationMs = rel(end);
  const idle = idleGaps(
    timeline,
    seats.map((s) => s.id),
    durationMs,
    excludePhases,
  );
  const result: SimResult<S> = {
    seed: opts.seed,
    players: seats.length,
    ended: runner.ended,
    result: runner.result,
    durationMs,
    audienceIdleMaxMs: idle.audience,
    playerIdleMaxMs: idle.player,
    timeline,
    steps: runner.stats.steps,
    actions,
    illegalActions,
    illegalSamples,
    polls: pollsAnswered,
    fingerprint: hash.toString(16).padStart(8, "0"),
    hashes,
    finalState: runner.state,
  };
  if (failure !== undefined) result.failure = failure;
  return result;
}

function chooseAction<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  state: S,
  player: PlayerId,
  rng: Rng,
  policy: ActionPolicy,
): A | null {
  if (policy === "mixed" && rng.bool(0.5)) {
    const legal = module.legalActions(state, player);
    if (legal.length > 0) return rng.pick(legal);
  }
  return module.bot(state, player, rng);
}

/**
 * A plausible aggregate result for a poll answered by the sim audience (SPEC §4 shapes):
 * option tallies for vote/predict/quiz, a 50-bin histogram and mean for dial, correct counts
 * and the first 3 names for guess, a tap total for tap.
 */
export function pollResult(spec: PollSpec, audience: readonly AudId[], rng: Rng): PollResult {
  const total = audience.length;
  const base = { pollId: spec.pollId, kind: spec.kind, total };
  switch (spec.kind) {
    case "dial": {
      const tallies: Record<string, number> = {};
      let sum = 0;
      for (let i = 0; i < total; i++) {
        const v = rng.int(1001);
        sum += v;
        const bin = String(Math.min(49, Math.floor(v / 20)));
        tallies[bin] = (tallies[bin] ?? 0) + 1;
      }
      return { ...base, tallies, mean: total > 0 ? sum / total : 0 };
    }
    case "guess": {
      const correct = audience.filter(() => rng.bool(0.3));
      return {
        ...base,
        tallies: { correct: correct.length },
        firstCorrect: correct.slice(0, 3).map((audId) => ({ audId, name: audId })),
      };
    }
    case "tap": {
      let taps = 0;
      for (let i = 0; i < total; i++) taps += 5 + rng.int(16);
      return { ...base, tallies: { taps } };
    }
    default: {
      const options = spec.options ?? [];
      const tallies: Record<string, number> = {};
      for (const o of options) tallies[o.id] = 0;
      if (options.length > 0) {
        for (let i = 0; i < total; i++) {
          const pick = rng.pick(options).id;
          tallies[pick] = (tallies[pick] ?? 0) + 1;
        }
      }
      return { ...base, tallies };
    }
  }
}

function readPhase(view: unknown): string {
  if (typeof view === "object" && view !== null && "phase" in view) {
    const phase = (view as { phase: unknown }).phase;
    if (typeof phase === "string") return phase;
  }
  return "(none)";
}

function readDeadline(view: unknown): number | null {
  if (typeof view === "object" && view !== null && "deadline" in view) {
    const d = (view as { deadline: unknown }).deadline;
    if (typeof d === "number" && Number.isFinite(d)) return d;
  }
  return null;
}

/** Merges intervals and returns the longest uncovered stretch of `[0, span]`. */
export function longestGap(intervals: readonly Interval[], span: number): number {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .map((i) => ({ start: Math.max(0, i.start), end: Math.min(span, i.end) }))
    .sort((a, b) => a.start - b.start);
  let cursor = 0;
  let max = 0;
  for (const i of sorted) {
    if (i.start > cursor) max = Math.max(max, i.start - cursor);
    cursor = Math.max(cursor, i.end);
  }
  return Math.max(max, span - cursor);
}

function idleGaps(
  timeline: readonly TimelineEntry[],
  players: readonly PlayerId[],
  span: number,
  exclude: ReadonlySet<string>,
): { audience: number; player: number } {
  const excluded: Interval[] = [];
  const audience: Interval[] = [];
  const perPlayer = new Map<PlayerId, Interval[]>(players.map((p) => [p, []]));
  for (const e of timeline) {
    const iv = { start: e.startMs, end: e.endMs };
    if (e.kind === "phase" && exclude.has(e.phase)) excluded.push(iv);
    else if (e.kind === "audience") audience.push(iv);
    else if (e.kind === "input" || e.kind === "involved") perPlayer.get(e.playerId)?.push(iv);
  }
  let player = 0;
  for (const intervals of perPlayer.values()) {
    player = Math.max(player, longestGap([...intervals, ...excluded], span));
  }
  return { audience: longestGap([...audience, ...excluded], span), player };
}

// ---- Pacing report (G14) ---------------------------------------------------------------------

/** Options for {@link pacingReport}. */
export interface PacingOptions<S, O> extends Omit<SimOptions<S, O>, "seed" | "players"> {
  /** Seeds per player count: a count (`1..n`) or explicit seeds. Default 50. */
  seeds?: number | readonly number[];
  /** Player counts. Default: min, typical (rounded mean) and max from the manifest. */
  players?: readonly number[];
}

/** One game's line in the pacing report. */
export interface PacingGame {
  seed: number;
  players: number;
  ended: boolean;
  failure?: string;
  durationMs: number;
  audienceIdleMaxMs: number;
  playerIdleMaxMs: number;
}

/** Aggregates for one player count. */
export interface PacingGroup {
  players: number;
  games: number;
  medianMs: number;
  p90Ms: number;
  audienceIdleMaxMs: number;
  playerIdleMaxMs: number;
}

/** The G14 pacing report (`artifacts/verify/<id>-pacing.json`). */
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

/** The default player counts for pacing and contract runs: min, typical and max. */
export function defaultPlayerCounts(manifest: {
  minPlayers: number;
  maxPlayers: number;
}): number[] {
  const typical = Math.round((manifest.minPlayers + manifest.maxPlayers) / 2);
  return [...new Set([manifest.minPlayers, typical, manifest.maxPlayers])];
}

/** The seed list for a count or an explicit list. */
export function seedList(seeds: number | readonly number[]): number[] {
  return typeof seeds === "number" ? Array.from({ length: seeds }, (_, i) => i + 1) : [...seeds];
}

/** The q-quantile (nearest rank) of `values`. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
  return sorted[rank - 1] as number;
}

/**
 * Replays seeded games for each player count with the timed bot model and summarises pacing.
 */
export function pacingReport<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  opts: PacingOptions<S, O> = {},
): PacingReport {
  const counts = opts.players ?? defaultPlayerCounts(module.manifest);
  const seeds = seedList(opts.seeds ?? 50);
  const games: PacingGame[] = [];
  const groups: PacingGroup[] = [];
  let worst: { score: number; timeline: TimelineEntry[] } = { score: -1, timeline: [] };
  for (const players of counts) {
    const group: PacingGame[] = [];
    for (const seed of seeds) {
      const sim = simulateGame(module, { ...opts, seed, players });
      const line: PacingGame = {
        seed,
        players,
        ended: sim.ended,
        durationMs: sim.durationMs,
        audienceIdleMaxMs: sim.audienceIdleMaxMs,
        playerIdleMaxMs: sim.playerIdleMaxMs,
      };
      if (sim.failure !== undefined) line.failure = sim.failure;
      group.push(line);
      const score = Math.max(sim.audienceIdleMaxMs, sim.playerIdleMaxMs);
      if (score > worst.score) worst = { score, timeline: sim.timeline };
    }
    games.push(...group);
    const durations = group.map((g) => g.durationMs);
    groups.push({
      players,
      games: group.length,
      medianMs: quantile(durations, 0.5),
      p90Ms: quantile(durations, 0.9),
      audienceIdleMaxMs: Math.max(0, ...group.map((g) => g.audienceIdleMaxMs)),
      playerIdleMaxMs: Math.max(0, ...group.map((g) => g.playerIdleMaxMs)),
    });
  }
  return {
    game: module.manifest.id,
    estMinutes: [...module.manifest.estMinutes],
    games,
    groups,
    durationMs: Math.max(0, ...games.map((g) => g.durationMs)),
    audienceIdleMaxMs: Math.max(0, ...games.map((g) => g.audienceIdleMaxMs)),
    playerIdleMaxMs: Math.max(0, ...games.map((g) => g.playerIdleMaxMs)),
    timeline: worst.timeline,
  };
}

/** The G14 limits; every field has the DoD default. */
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

/** The verdict of {@link checkPacing}. */
export interface PacingVerdict {
  ok: boolean;
  failures: string[];
  checks: { duration: boolean; audienceIdle: boolean; playerIdle: boolean; ended: boolean };
}

/** Applies the G14 limits to a pacing report. */
export function checkPacing(report: PacingReport, limits: PacingLimits = {}): PacingVerdict {
  const [lo, hi] = limits.estMinutes ?? report.estMinutes;
  const p90Factor = limits.p90Factor ?? 1.25;
  const audLimit = limits.audienceIdleMaxMs ?? 30_000;
  const playerLimit = limits.playerIdleMaxMs ?? 45_000;
  const failures: string[] = [];
  const minute = 60_000;

  const unfinished = report.games.filter((g) => !g.ended);
  for (const g of unfinished.slice(0, 5)) {
    failures.push(`game seed ${g.seed} (${g.players}p) did not end: ${g.failure ?? "?"}`);
  }
  let duration = true;
  if (limits.skipDuration !== true) {
    for (const g of report.groups) {
      if (g.medianMs < lo * minute || g.medianMs > hi * minute) {
        duration = false;
        failures.push(
          `${g.players}p median ${(g.medianMs / minute).toFixed(2)} min is outside ${lo}-${hi} min`,
        );
      }
      if (g.p90Ms > hi * p90Factor * minute) {
        duration = false;
        failures.push(
          `${g.players}p p90 ${(g.p90Ms / minute).toFixed(2)} min exceeds ${hi} × ${p90Factor} min`,
        );
      }
    }
  }
  const audienceIdle = report.audienceIdleMaxMs <= audLimit;
  if (!audienceIdle) {
    failures.push(
      `audience idle gap ${(report.audienceIdleMaxMs / 1000).toFixed(1)} s exceeds ${audLimit / 1000} s`,
    );
  }
  const playerIdle = report.playerIdleMaxMs <= playerLimit;
  if (!playerIdle) {
    failures.push(
      `player idle gap ${(report.playerIdleMaxMs / 1000).toFixed(1)} s exceeds ${playerLimit / 1000} s`,
    );
  }
  const ended = unfinished.length === 0;
  return {
    ok: failures.length === 0,
    failures,
    checks: { duration, audienceIdle, playerIdle, ended },
  };
}
