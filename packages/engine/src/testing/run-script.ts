/**
 * `runScript`: drive a game module through a scripted sequence on a real {@link GameRunner}
 * with a virtual clock. It is how game rule tests (G3) read: "p1 answers, 3 s pass, the timer
 * fires, the audience result arrives, expect…", with every step checked and traced.
 *
 * ```ts
 * const { runner } = runScript(logic, [
 *   { timer: "intro" },
 *   { act: "p1", action: { type: "move", cell: 4 } },
 *   { act: "p1", action: { type: "move", cell: 0 }, expect: "illegal" },
 *   { check: ({ state }) => expect(state.moves).toBe(1) },
 * ], { players: 2, seed: 7 });
 * ```
 *
 * @module
 */
import type { AudId, PlayerId } from "@sg/shared";
import type {
  ActionCtx,
  Effect,
  GameHostCommand,
  GameModule,
  PollResult,
  Seat,
} from "../game-module.ts";
import { GameRunner, type RunnerError, type RunnerOptions, type RunnerResult } from "../runner.ts";

/** Seats `p1..pN` named "Player 1..N", colour slots `0..N-1`, optionally dealt into teams. */
export function makeSeats(count: number, opts: { teams?: readonly string[] } = {}): Seat[] {
  if (!Number.isInteger(count) || count < 0) throw new RangeError("makeSeats: bad count");
  const teams = opts.teams ?? [];
  return Array.from({ length: count }, (_, i) => {
    const seat: Seat = { id: `p${i + 1}`, name: `Player ${i + 1}`, seat: i, colorSlot: i % 8 };
    const team = teams.length > 0 ? teams[i % teams.length] : undefined;
    if (team !== undefined) seat.teamId = team;
    return seat;
  });
}

/** What an `act` step expects: success, a specific refusal, or anything. */
export type ActExpectation = "ok" | RunnerError | "any";

/** One scripted step. Times are ms relative to the script start (virtual clock). */
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

/** Passed to `check` steps. */
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

/** Script options: runner options with friendlier defaults. */
export interface ScriptOptions<O> extends Partial<Omit<RunnerOptions<O>, "players">> {
  /** A seat count (see {@link makeSeats}) or explicit seats. Default: the manifest minimum. */
  players?: number | readonly Seat[];
}

/** One traced step. */
export interface ScriptTraceEntry<S, A> {
  index: number;
  step: ScriptStep<S, A>;
  /** Virtual ms since start, after the step. */
  elapsed: number;
  result: RunnerResult;
}

/** The outcome of {@link runScript}. */
export interface ScriptRun<S, A, O, V> {
  runner: GameRunner<S, A, O, V>;
  state: S;
  /** Every effect (setup included), in order. */
  effects: Effect[];
  trace: ScriptTraceEntry<S, A>[];
  /** Virtual ms since start at the end of the script. */
  elapsed: number;
}

/** The script start time used when `now` is not given. */
export const SCRIPT_EPOCH = 1_000_000;

/**
 * Runs `script` against a fresh runner (dev mode, `botDelayMs` 0 unless given).
 *
 * @throws Error naming the step index when a step's expectation fails, a `timer` step names a
 *   timer that is not pending, or a `check` throws.
 */
export function runScript<S, A, O, V>(
  module: GameModule<S, A, O, V>,
  script: readonly ScriptStep<S, A>[],
  opts: ScriptOptions<O> = {},
): ScriptRun<S, A, O, V> {
  const start = opts.now ?? SCRIPT_EPOCH;
  const players =
    typeof opts.players === "number"
      ? makeSeats(opts.players)
      : opts.players !== undefined
        ? opts.players.map((p) => ({ ...p }))
        : makeSeats(module.manifest.minPlayers);
  const runner = new GameRunner(module, {
    ...opts,
    players,
    seed: opts.seed ?? 1,
    now: start,
    botDelayMs: opts.botDelayMs ?? 0,
  });
  const effects: Effect[] = [...runner.setupEffects];
  const trace: ScriptTraceEntry<S, A>[] = [];
  let now = start;
  let last: readonly Effect[] = runner.setupEffects;

  script.forEach((step, index) => {
    const fail = (msg: string): never => {
      throw new Error(`runScript step ${index} (${describeStep(step)}): ${msg}`);
    };
    const expectResult = (result: RunnerResult, want: ActExpectation): void => {
      if (want === "any") return;
      const got = result.ok ? "ok" : (result.err ?? "?");
      if (got !== want) fail(`expected ${want}, got ${got}`);
    };
    let result: RunnerResult;
    if ("act" in step) {
      result = runner.act(step.act, step.action, now, step.role);
      expectResult(result, step.expect ?? "ok");
    } else if ("wait" in step) {
      now += step.wait;
      result = runner.advance(now);
    } else if ("at" in step) {
      now = Math.max(now, start + step.at);
      result = runner.advance(now);
    } else if ("timer" in step) {
      const timer = runner.timers().find((t) => t.id === step.timer);
      if (timer === undefined) {
        const pending = runner.timers().map((t) => t.id);
        return fail(`timer not pending (pending: ${pending.join(", ") || "none"})`);
      }
      now = Math.max(now, timer.atMs);
      result = runner.advance(now);
    } else if ("next" in step) {
      const at = runner.nextEventAt();
      if (at === null) return fail("nothing is scheduled");
      now = Math.max(now, at);
      result = runner.advance(now);
    } else if ("host" in step) {
      result = runner.hostCommand(step.host, now);
      expectResult(result, step.expect ?? "ok");
    } else if ("audience" in step) {
      result = runner.audienceResult(step.audience, now);
    } else if ("enroll" in step) {
      result = runner.audienceEnroll(step.enroll, now);
    } else if ("audienceAction" in step) {
      result = runner.audienceAction(step.audienceAction.audId, step.audienceAction.action, now);
    } else if ("moderate" in step) {
      result = runner.moderation(step.moderate.itemId, step.moderate.approved, now);
    } else if ("leave" in step) {
      result = runner.playerLeave(step.leave, now);
    } else if ("rejoin" in step) {
      result = runner.playerRejoin(step.rejoin, now);
    } else if ("bot" in step) {
      result = runner.setBot(step.bot, step.on ?? true, now);
    } else if ("pause" in step) {
      result = runner.pause(now);
    } else if ("resume" in step) {
      result = runner.resume(now);
    } else {
      try {
        step.check({
          state: runner.state,
          runner: runner as unknown as GameRunner<S, A, unknown, unknown>,
          elapsed: now - start,
          effects,
          last,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      result = { ok: true, effects: [] };
    }
    effects.push(...result.effects);
    last = result.effects;
    trace.push({ index, step, elapsed: now - start, result });
  });

  return { runner, state: runner.state, effects, trace, elapsed: now - start };
}

function describeStep<S, A>(step: ScriptStep<S, A>): string {
  const key = Object.keys(step)[0] ?? "?";
  if ("act" in step) return `act ${step.act}`;
  if ("timer" in step) return `timer ${step.timer}`;
  if ("wait" in step) return `wait ${step.wait}`;
  return key;
}
