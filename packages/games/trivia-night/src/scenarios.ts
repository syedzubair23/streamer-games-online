/**
 * Trivia Night scenarios (SPEC §14, `docs/specs/trivia-night.md` "Scenarios"): every visible
 * Classic state as a named, deterministic scenario for `/dev/scenario`. States are reached by
 * **driving the real module** on a {@link GameRunner} (setup, timers, actions, audience
 * results), never by hand-writing state, so every scenario is a state the game can really be in.
 *
 * Scenarios run with no content (client side), so the game plays its built-in questions. A
 * scenario that needs a particular question ("Geography at Q5", "the answer is C") searches the
 * seed's sub-seeds for a deal that has it: deterministic for a given seed.
 *
 * Audience tallies are platform data (SPEC §4), not game state; scenarios that show them pass
 * them as a `tally` fx (`{ pollId, kind, total, tallies }`) for the Stage to replay.
 *
 * `bluff-pick` and `bluff-reveal` arrive with Bluff mode (ROADMAP M4-01b).
 *
 * @module
 */
import type { PlayerId } from "@sg/shared";
import {
  EMPTY_CONTENT,
  GameRunner,
  type ContentAccess,
  type Effect,
  type GameHostCommand,
  type PollResult,
  type ScenarioRegistry,
  type Seat,
  type ViewerKey,
} from "@sg/engine";
import {
  POLL_GRACE_MS,
  triviaNight,
  type TnAction,
  type TnOptions,
  type TnPhase,
  type TnState,
  type TnView,
} from "./logic/index.ts";

export { GAME_ID } from "./logic/index.ts";

/** Scenario clock origin (server ms). */
export const SCENARIO_NOW = 1_000_000;

/** Seat names used by the scenarios (display names are at most 16 characters). */
export const SCENARIO_NAMES: readonly string[] = Object.freeze([
  "Maple",
  "Juniper",
  "Clover",
  "Basil",
  "Hazel",
  "Rowan",
  "Willow",
  "Sorrel",
  "Fennel",
  "Aster",
]);

/** `n` scenario seats, optionally dealt round-robin into room teams. */
export function scenarioSeats(n: number, teams?: readonly string[]): Seat[] {
  return Array.from({ length: n }, (_, i) => {
    const seat: Seat = {
      id: `p${i + 1}`,
      name: SCENARIO_NAMES[i] ?? `Player ${i + 1}`,
      seat: i,
      colorSlot: i % 8,
    };
    const team = teams?.[i % teams.length];
    if (team !== undefined) seat.teamId = team;
    return seat;
  });
}

/** Options for {@link TableDriver}. */
export interface TableOptions {
  seed: number | string;
  /** A seat count (see {@link scenarioSeats}) or explicit seats. */
  players: number | readonly Seat[];
  teams?: { id: string; name: string; colorSlot: number }[];
  options?: Partial<TnOptions>;
  /** Audience size the runner reports to the game. Default 800. */
  audience?: number;
  content?: ContentAccess;
  streamDelaySec?: number;
  timerScale?: 0 | 0.75 | 1 | 1.5 | 2;
}

/** How a scripted player answers: right, wrong, a specific option, or not at all. */
export type Answer = "right" | "wrong" | 0 | 1 | 2 | 3 | null;

/** Share of the wrong audience answers per wrong option, in order. */
const WRONG_SPLIT = [0.5, 0.3, 0.2] as const;

/**
 * Drives a real Trivia Night game on a {@link GameRunner} with a virtual clock. Used by the
 * scenarios and by the tests. Every step throws if the game refuses it, so a scenario can
 * never silently build an unreachable state.
 */
export class TableDriver {
  readonly runner: GameRunner<TnState, TnAction, TnOptions, TnView>;
  now: number;
  /** The effects of the latest driver step (server times; `timer.*` never appear). */
  last: Effect[] = [];
  /**
   * Every effect so far, setup included. Early audience closes (and the resolves behind them)
   * are held by the runner for the minimum audience window, so they show up here later.
   */
  readonly log: Effect[] = [];

  constructor(opts: TableOptions) {
    this.now = SCENARIO_NOW;
    this.runner = new GameRunner(triviaNight, {
      players:
        typeof opts.players === "number"
          ? scenarioSeats(opts.players)
          : opts.players.map((p) => ({ ...p })),
      ...(opts.teams !== undefined ? { teams: opts.teams } : {}),
      seed: opts.seed,
      now: this.now,
      ...(opts.options !== undefined ? { options: opts.options } : {}),
      timerScale: opts.timerScale ?? 1,
      streamDelaySec: opts.streamDelaySec ?? 3,
      content: opts.content ?? EMPTY_CONTENT,
      audienceCount: opts.audience ?? 800,
      botDelayMs: 0,
    });
    this.log.push(...this.runner.setupEffects);
  }

  /** The current state. */
  get state(): TnState {
    return this.runner.state;
  }

  /** Advances the virtual clock by `ms`, firing due timers. */
  wait(ms: number): this {
    this.now += ms;
    this.last = this.runner.advance(this.now).effects;
    this.log.push(...this.last);
    return this;
  }

  /** Advances to the current phase's deadline (plus `extra` ms). */
  toDeadline(extra = 0): this {
    const d = this.state.deadline;
    if (d === null) throw new Error(`trivia-night driver: no deadline in ${this.state.phase}`);
    return this.wait(Math.max(0, d - this.now) + extra);
  }

  /** A seat action, `gapMs` after the previous event. Throws when refused. */
  act(id: PlayerId, action: TnAction, gapMs = 700): this {
    this.now += gapMs;
    const res = this.runner.act(id, action, this.now);
    this.last = res.effects;
    this.log.push(...this.last);
    if (!res.ok) {
      throw new Error(
        `trivia-night driver: ${id} ${JSON.stringify(action)} refused (${res.err ?? "?"}) in ${this.state.phase}`,
      );
    }
    return this;
  }

  /** A host command. Throws when refused. */
  host(cmd: GameHostCommand): this {
    const res = this.runner.hostCommand(cmd, this.now);
    this.last = res.effects;
    this.log.push(...this.last);
    if (!res.ok) throw new Error(`trivia-night driver: host ${cmd.c} refused (${res.err ?? "?"})`);
    return this;
  }

  /** Delivers an audience result. */
  audience(result: Omit<PollResult, "pollId"> & { pollId: string | null }): this {
    if (result.pollId === null) throw new Error("trivia-night driver: no such poll open");
    this.last = this.runner.audienceResult({ ...result, pollId: result.pollId }, this.now).effects;
    this.log.push(...this.last);
    return this;
  }

  /** Ends the intro. */
  skipIntro(): this {
    if (this.state.phase !== "intro") throw new Error("trivia-night driver: not in intro");
    return this.toDeadline();
  }

  /** From `category` (or `read`) to the open answer window. */
  toAnswer(): this {
    if (this.state.phase === "category") this.toDeadline();
    if (this.state.phase === "read") this.toDeadline();
    if (this.state.phase !== "answer") {
      throw new Error(`trivia-night driver: not answering (${this.state.phase})`);
    }
    return this;
  }

  /** The option a scripted {@link Answer} stands for in the current (or showdown) question. */
  choiceFor(a: Exclude<Answer, null>): 0 | 1 | 2 | 3 {
    if (typeof a === "number") return a;
    const correct =
      this.state.phase === "showdown-answer"
        ? (this.state.hidden.showdownCorrect ?? 0)
        : (this.state.hidden.correct ?? 0);
    return (a === "right" ? correct : (correct + 1) % 4) as 0 | 1 | 2 | 3;
  }

  /** Scripted locks in order, `gapMs` apart. */
  answers(plan: Readonly<Record<PlayerId, Answer>>, gapMs = 1_500): this {
    for (const [id, a] of Object.entries(plan)) {
      if (a === null) continue;
      this.act(id, { type: "answer", choice: this.choiceFor(a) }, gapMs);
    }
    return this;
  }

  /**
   * The audience quiz result for the current question: `total` answers, `rightPct` percent on
   * the correct option and the rest spread over the others.
   */
  quiz(total: number, rightPct: number): this {
    const correct = this.state.hidden.correct ?? 0;
    const right = Math.round((total * rightPct) / 100);
    const tallies: Record<string, number> = { [String(correct)]: right };
    const wrong = [0, 1, 2, 3].filter((i) => i !== correct);
    let left = total - right;
    wrong.forEach((w, i) => {
      const n = i === wrong.length - 1 ? left : Math.round((total - right) * (WRONG_SPLIT[i] ?? 0));
      tallies[String(w)] = n;
      left -= n;
    });
    return this.audience({ pollId: this.state.polls.quiz, kind: "quiz", total, tallies });
  }

  /**
   * Plays the current question from `category` to its reveal: the scripted locks, then the
   * deadline (when someone did not lock) and the audience quiz result.
   */
  playToReveal(plan: Readonly<Record<PlayerId, Answer>>, quiz: [number, number] = [400, 60]): this {
    this.toAnswer().answers(plan);
    if (!this.state.answerClosed) this.toDeadline();
    if (this.state.phase === "answer") this.quiz(quiz[0], quiz[1]);
    if (this.state.phase !== "reveal") {
      throw new Error(`trivia-night driver: expected reveal (${this.state.phase})`);
    }
    return this;
  }

  /** Plays the current question and leaves its reveal. */
  playQuestion(plan: Readonly<Record<PlayerId, Answer>>, quiz?: [number, number]): this {
    return this.playToReveal(plan, quiz).toDeadline();
  }

  /**
   * Lets the current phase run out: its deadline, plus the poll grace in `lifeline-vote` (the
   * vote waits that long for its result).
   */
  step(): this {
    return this.toDeadline(this.state.phase === "lifeline-vote" ? POLL_GRACE_MS : 0);
  }

  /** Advances phase by phase until `phase` (throws after `guard` steps). */
  toPhase(phase: TnPhase, guard = 20): this {
    for (let i = 0; i < guard && this.state.phase !== phase; i++) this.step();
    if (this.state.phase !== phase) throw new Error(`trivia-night driver: never reached ${phase}`);
    return this;
  }
}

/** A seed variant whose deal satisfies `ok` (deterministic: tries `seed`, `seed:1`, …). */
export function findSeed(
  seed: number,
  opts: Omit<TableOptions, "seed">,
  ok: (s: TnState) => boolean,
): string {
  for (let k = 0; k < 400; k++) {
    const variant = k === 0 ? String(seed) : `${seed}:${k}`;
    if (ok(new TableDriver({ ...opts, seed: variant }).state)) return variant;
  }
  throw new Error("trivia-night scenarios: no seed variant has the wanted deal");
}

function tally(
  pollId: string | null,
  kind: string,
  total: number,
  tallies: Record<string, number>,
): { name: string; data: unknown } {
  return { name: "tally", data: { pollId, kind, total, tallies } };
}

const player = (id: PlayerId): ViewerKey => ({ role: "player", id });

/**
 * Five players of different strength (Maple sharp, Hazel struggling). Question `i` (1-based)
 * varies the pattern so streaks, misses and a no-answer all show.
 */
function fivePlan(i: number): Record<PlayerId, Answer> {
  return {
    p1: "right",
    p2: i % 3 === 0 ? "wrong" : "right",
    p3: i % 2 === 0 ? "right" : "wrong",
    p4: i === 2 ? "right" : "wrong",
    p5: i === 3 ? "right" : null,
  };
}

/** The five-player table used by the Q5 scenarios (Geography at Q5). */
function fiveTable(seed: number): TableDriver {
  const opts = { players: 5 } as const;
  const variant = findSeed(seed, opts, (s) => s.hidden.queue[4]?.category === "Geography");
  return new TableDriver({ ...opts, seed: variant }).skipIntro();
}

/** Plays Q1–Q4 and stops at the scoreboard after Q4. */
function toScoreboard(d: TableDriver): TableDriver {
  for (let i = 1; i <= 4; i++) d.playQuestion(fivePlan(i), [420, 55 + i * 3]);
  if (d.state.phase !== "scoreboard")
    throw new Error("trivia-night scenarios: expected scoreboard");
  return d;
}

/** From the Q4 scoreboard through the lifeline vote (Hazel gets the 50/50) into the Showdown. */
function toShowdown(d: TableDriver): TableDriver {
  d.toDeadline(); // scoreboard -> lifeline-vote
  d.wait(6_000).audience({
    pollId: d.state.polls.vote,
    kind: "vote",
    total: 380,
    tallies: { p1: 20, p2: 30, p3: 60, p4: 90, p5: 180 },
  });
  if (d.state.phase !== "showdown") throw new Error("trivia-night scenarios: expected showdown");
  return d;
}

/** Plays the Showdown: the lower player keeps a cool head, the other one is steamed. */
function playShowdown(d: TableDriver): TableDriver {
  d.toDeadline(); // predict -> answer
  const [low, high] = d.state.showdown?.players ?? ["p5", "p4"];
  d.act(low, { type: "answer", choice: d.choiceFor("right") }, 2_600);
  d.act(high, { type: "answer", choice: d.choiceFor("wrong") }, 1_400);
  if (d.state.phase !== "showdown-verdict") {
    throw new Error("trivia-night scenarios: expected verdict");
  }
  return d;
}

/** Q5's category card, after the Q4 break (Showdown played). */
function toQ5(seed: number): TableDriver {
  return playShowdown(toShowdown(toScoreboard(fiveTable(seed)))).toDeadline();
}

/** The Trivia Night scenario registry. */
export const scenarios: ScenarioRegistry<TnState> = {
  category: {
    id: "category",
    description: 'Category card "Geography", Q5 of 12',
    build: ({ seed }) => {
      const d = toQ5(seed);
      return {
        state: d.state,
        fx: [{ name: "category", data: { index: 5, category: "Geography" } }],
      };
    },
    anim: { name: "flip", durationMs: 600 },
  },
  answering: {
    id: "answering",
    description: "Q5 answer phase, 3 of 5 locked, 11 s left",
    build: ({ seed }) => {
      const d = toQ5(seed).toAnswer();
      d.answers({ p1: "right", p3: "wrong", p2: "right" }, 1_800);
      const left = (d.state.deadline ?? d.now) - d.now;
      if (left > 11_000) d.wait(left - 11_000);
      return {
        state: d.state,
        viewer: player("p4"),
        fx: [tally(d.state.polls.quiz, "quiz", 512, {})],
      };
    },
  },
  reveal: {
    id: "reveal",
    description: "Correct = C, audience 64% right",
    build: ({ seed }) => {
      const opts = { players: 5 } as const;
      const variant = findSeed(seed, opts, (s) => s.hidden.queue[2]?.correct === 2);
      const d = new TableDriver({ ...opts, seed: variant }).skipIntro();
      d.playQuestion(fivePlan(1)).playQuestion(fivePlan(2));
      d.playToReveal({ p1: "right", p2: "right", p3: 0, p4: 1, p5: "right" }, [500, 64]);
      return { state: d.state, fx: [{ name: "reveal", data: { index: 3, correct: 2 } }] };
    },
    anim: { name: "reveal", durationMs: 1200 },
  },
  scoreboard: {
    id: "scoreboard",
    description: "After Q4 with streaks (Steamed chips show from Q5: see answering)",
    build: ({ seed }) => {
      const d = toScoreboard(fiveTable(seed));
      return { state: d.state, fx: [{ name: "scores", data: { index: 4 } }] };
    },
    anim: { name: "scores", durationMs: 1000 },
  },
  showdown: {
    id: "showdown",
    description: "Kettle face-off, predict tally 70/30",
    build: ({ seed }) => {
      const d = toShowdown(toScoreboard(fiveTable(seed))).wait(5_000);
      const [low, high] = d.state.showdown?.players ?? ["p5", "p4"];
      return {
        state: d.state,
        fx: [tally(d.state.polls.predict, "predict", 300, { [low]: 210, [high]: 90 })],
      };
    },
  },
  "showdown-verdict": {
    id: "showdown-verdict",
    description: "Loser steamed",
    build: ({ seed }) => {
      const d = playShowdown(toShowdown(toScoreboard(fiveTable(seed))));
      return {
        state: d.state,
        fx: [{ name: "steam", data: { losers: d.state.showdown?.verdict ?? [] } }],
      };
    },
    anim: { name: "steam", durationMs: 1500 },
  },
  final: {
    id: "final",
    description: "Winner + audience MVP",
    build: ({ seed }) => {
      const d = new TableDriver({ seed, players: 5 }).skipIntro();
      for (let guard = 0; guard < 60 && d.state.phase !== "final"; guard++) {
        const phase = d.state.phase;
        if (phase === "category") d.playQuestion(fivePlan(d.state.index + 1), [450, 58]);
        else if (phase === "showdown") playShowdown(d).toDeadline();
        else d.step();
      }
      if (d.state.phase !== "final")
        throw new Error("trivia-night final scenario: game did not end");
      return {
        state: d.state,
        fx: [
          { name: "win", data: { winners: d.state.winners } },
          { name: "audienceMvp", data: { name: "QuizWhiz42", score: 1240 } },
        ],
      };
    },
    anim: { name: "win", durationMs: 2000 },
  },

  // ---- extra visible states (registered for dev and tests; not in the spec table) ----
  intro: {
    id: "intro",
    description: "Game start: how-to-play card",
    build: ({ seed }) => ({ state: new TableDriver({ seed, players: 5 }).state }),
  },
  read: {
    id: "read",
    description: "Question card shown, answers still hidden",
    build: ({ seed }) => ({
      state: new TableDriver({ seed, players: 5 }).skipIntro().toDeadline().state,
    }),
  },
  "answering-player-locked": {
    id: "answering-player-locked",
    description: "Phone after locking in (Locked in!)",
    build: ({ seed }) => {
      const d = new TableDriver({ seed, players: 5 }).skipIntro().toAnswer();
      d.answers({ p1: "right", p2: "wrong" });
      return { state: d.state, viewer: player("p1") };
    },
  },
  "reveal-player": {
    id: "reveal-player",
    description: "Phone after the reveal: tick and points",
    build: ({ seed }) => {
      const d = new TableDriver({ seed, players: 5 }).skipIntro();
      d.playQuestion(fivePlan(1)).playToReveal(fivePlan(2));
      return { state: d.state, viewer: player("p1") };
    },
  },
  "lifeline-vote": {
    id: "lifeline-vote",
    description: "Chat votes who gets a 50/50",
    build: ({ seed }) => {
      const d = toScoreboard(fiveTable(seed)).toDeadline().wait(4_000);
      return {
        state: d.state,
        fx: [tally(d.state.polls.vote, "vote", 260, { p1: 10, p2: 25, p3: 45, p4: 70, p5: 110 })],
      };
    },
  },
  "answering-lifeline": {
    id: "answering-lifeline",
    description: "The lifeline recipient's phone: two options removed",
    build: ({ seed }) => {
      const d = toQ5(seed).toAnswer();
      return { state: d.state, viewer: player(d.state.lifeline.recipient ?? "p5") };
    },
  },
  "steamed-answering": {
    id: "steamed-answering",
    description: "Q5 with the Showdown loser Steamed (steam chip on the plate)",
    build: ({ seed }) => {
      const d = toQ5(seed).toAnswer();
      const loser = d.state.showdown?.verdict?.[0] ?? Object.keys(d.state.steamed)[0] ?? "p4";
      return { state: d.state, viewer: player(loser) };
    },
  },
  "answering-no-timer": {
    id: "answering-no-timer",
    description: "timerScale 0: no countdown, speed bonus off",
    build: ({ seed }) => {
      const d = new TableDriver({ seed, players: 4, timerScale: 0 });
      d.host({ c: "forceAdvance" }).host({ c: "forceAdvance" }).host({ c: "forceAdvance" });
      return { state: d.state };
    },
  },
  "team-reveal": {
    id: "team-reveal",
    description: "Team mode: plurality answers per team",
    build: ({ seed }) => {
      const d = new TableDriver({
        seed,
        players: scenarioSeats(6, ["tomato", "sky"]),
        teams: [
          { id: "tomato", name: "Tomato", colorSlot: 0 },
          { id: "sky", name: "Sky", colorSlot: 1 },
        ],
      }).skipIntro();
      d.playToReveal({
        p1: "right",
        p3: "right",
        p5: "wrong",
        p2: "wrong",
        p4: "wrong",
        p6: "right",
      });
      return { state: d.state, fx: [{ name: "reveal" }] };
    },
  },
};
