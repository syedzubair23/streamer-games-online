/**
 * Tune In scenarios (SPEC §14, `docs/specs/tune-in.md` "Scenarios"): every visible state as a
 * named, deterministic scenario for `/dev/scenario`. States are reached by **driving the real
 * module** on a {@link GameRunner} (setup, timers, actions, audience results), never by
 * hand-writing state, so every scenario is a state the game can actually be in.
 *
 * Audience tallies are platform data (SPEC §4), not game state; scenarios that show them pass
 * them as a `tally` fx (`{ pollId, kind, total, tallies?, mean?, hideLive? }`) for the Stage to
 * replay.
 *
 * @module
 */
import { createRng, type PlayerId, type Rng } from "@sg/shared";
import {
  EMPTY_CONTENT,
  GameRunner,
  type ContentAccess,
  type PollResult,
  type ScenarioRegistry,
  type Seat,
  type ViewerKey,
} from "@sg/engine";
import {
  botClue,
  ffaGuessers,
  stealers,
  teamGuessers,
  tuneIn,
  type TiAction,
  type TiOptions,
  type TiState,
  type TiView,
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
  "Linden",
  "Poppy",
]);

/** `n` scenario seats (no room teams: the game splits them into Tomato and Sky). */
export function scenarioSeats(n: number): Seat[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    name: SCENARIO_NAMES[i] ?? `Player ${i + 1}`,
    seat: i,
    colorSlot: i % 8,
  }));
}

/** Options for {@link TableDriver}. */
export interface TableOptions {
  seed: number;
  /** A seat count (see {@link scenarioSeats}) or explicit seats. */
  players: number | readonly Seat[];
  options?: Partial<TiOptions>;
  /** Audience size the runner reports to the game. Default 800. */
  audience?: number;
  content?: ContentAccess;
  streamDelaySec?: number;
  timerScale?: 0 | 0.75 | 1 | 1.5 | 2;
}

/** Points → a dial offset from the target that scores exactly those points (R2). */
const OFFSET_FOR_POINTS: Record<number, number> = { 4: 10, 3: 50, 2: 100, 0: 300 };

/**
 * Drives a real Tune In game on a {@link GameRunner} with a virtual clock. Used by the
 * scenarios and by the tests. Every step throws if the game refuses it, so a scenario can
 * never silently build an unreachable state.
 */
export class TableDriver {
  readonly runner: GameRunner<TiState, TiAction, TiOptions, TiView>;
  now: number;

  constructor(opts: TableOptions) {
    this.now = SCENARIO_NOW;
    this.runner = new GameRunner(tuneIn, {
      players:
        typeof opts.players === "number"
          ? scenarioSeats(opts.players)
          : opts.players.map((p) => ({ ...p })),
      seed: opts.seed,
      now: this.now,
      ...(opts.options !== undefined ? { options: opts.options } : {}),
      timerScale: opts.timerScale ?? 1,
      streamDelaySec: opts.streamDelaySec ?? 3,
      content: opts.content ?? EMPTY_CONTENT,
      audienceCount: opts.audience ?? 800,
      botDelayMs: 0,
    });
  }

  /** The current state. */
  get state(): TiState {
    return this.runner.state;
  }

  /** Advances the virtual clock by `ms`, firing due timers. */
  wait(ms: number): this {
    this.now += ms;
    this.runner.advance(this.now);
    return this;
  }

  /** Advances to the current phase's deadline (plus `extra` ms). */
  toDeadline(extra = 0): this {
    const d = this.state.deadline;
    if (d === null) throw new Error(`tune-in driver: no deadline in ${this.state.phase}`);
    return this.wait(Math.max(0, d - this.now) + extra);
  }

  /** A seat action, `gapMs` after the previous event. Throws when refused. */
  act(id: PlayerId, action: TiAction, gapMs = 700): this {
    this.now += gapMs;
    const res = this.runner.act(id, action, this.now);
    if (!res.ok) {
      throw new Error(
        `tune-in driver: ${id} ${JSON.stringify(action)} refused (${res.err ?? "?"}) in ${this.state.phase}`,
      );
    }
    return this;
  }

  /** Delivers an audience result for a poll of this turn. */
  audience(result: Omit<PollResult, "pollId"> & { pollId: string | null }): this {
    if (result.pollId === null) throw new Error("tune-in driver: no such poll open");
    this.runner.audienceResult({ ...result, pollId: result.pollId }, this.now);
    return this;
  }

  /** Ends the intro. */
  skipIntro(): this {
    if (this.state.phase !== "intro") throw new Error("tune-in driver: not in intro");
    return this.toDeadline();
  }

  /** The audience card vote closes with these counts, `afterMs` into the pick. */
  voteCard(counts: [number, number], afterMs = 2_000): this {
    this.wait(afterMs);
    return this.audience({
      pollId: this.state.polls.card,
      kind: "vote",
      total: counts[0] + counts[1],
      tallies: { "0": counts[0], "1": counts[1] },
    });
  }

  /** The psychic submits a valid clue (the bot's, unless given). */
  clue(text?: string, afterMs = 4_000): this {
    return this.act(
      this.state.psychic,
      { type: "clue", text: text ?? botClue(this.state, null) },
      afterMs,
    );
  }

  /** A dial value scoring exactly `points` for the current target (R2). */
  dialFor(points: 0 | 2 | 3 | 4, sign: 1 | -1 = 1): number {
    const off = OFFSET_FOR_POINTS[points] as number;
    const t = this.state.hidden.target;
    const v = t + sign * off;
    return v >= 0 && v <= 1000 ? v : t - sign * off;
  }

  /** The audience dial poll closes with `total` guesses around `mean`. */
  dialResult(total: number, mean: number, rng?: Rng): this {
    return this.audience({
      pollId: this.state.polls.dial,
      kind: "dial",
      total,
      tallies: histogram(total, mean, rng ?? createRng(`hist:${total}:${mean}`)),
      mean,
    });
  }

  /** Teams: the first guesser sets the dial to `v` and locks. */
  teamGuess(v: number): this {
    const who = teamGuessers(this.state)[0];
    if (who === undefined) throw new Error("tune-in driver: no guesser");
    return this.act(who, { type: "setDial", v }, 3_000).act(who, { type: "lock" });
  }

  /** Plays one teams turn from its card pick to the end of `turn-score`, scoring `points`. */
  playTeamTurn(points: 0 | 2 | 3 | 4): this {
    this.voteCard([60, 40]).clue();
    this.teamGuess(this.dialFor(points));
    if (this.state.phase === "steal") this.toDeadline();
    if (this.state.awaitingDial) this.dialResult(0, 500);
    if (this.state.phase !== "reveal") throw new Error("tune-in driver: expected reveal");
    return this.toDeadline().toDeadline();
  }
}

/** A 50-bin dial histogram of `total` guesses clustered around `mean` (SPEC §4 dial shape). */
export function histogram(total: number, mean: number, rng: Rng): Record<string, number> {
  const bins: Record<string, number> = {};
  for (let i = 0; i < total; i++) {
    const spread = (rng.float() + rng.float() + rng.float() + rng.float() - 2) * 180;
    const v = Math.min(1000, Math.max(0, Math.round(mean + spread)));
    const bin = String(Math.min(49, Math.floor(v / 20)));
    bins[bin] = (bins[bin] ?? 0) + 1;
  }
  return bins;
}

function tally(
  pollId: string | null,
  kind: string,
  total: number,
  extra: Record<string, unknown> = {},
): { name: string; data: unknown } {
  return { name: "tally", data: { pollId, kind, total, ...extra } };
}

const player = (id: PlayerId): ViewerKey => ({ role: "player", id });

/** Teams table (6 seats) at the card pick of turn 1. */
function teamsCardPick(seed: number, options: Partial<TiOptions> = {}): TableDriver {
  return new TableDriver({ seed, players: 6, options }).skipIntro();
}

/** Teams table in the guess phase of turn 1. */
function teamsGuess(seed: number, options: Partial<TiOptions> = {}): TableDriver {
  return teamsCardPick(seed, options).voteCard([110, 90]).clue();
}

/**
 * Points for the `final` scenario's turns: Tomato climbs to 7 (3 + 4), Sky to 6 (3 + 3) and
 * then wins 10–7 with a bullseye once Tomato sits on 7.
 */
function finalPlan(state: TiState): 0 | 3 | 4 {
  const tomato = state.scores["tomato"] ?? 0;
  const sky = state.scores["sky"] ?? 0;
  if (state.activeTeam === "tomato") return tomato < 3 ? 3 : tomato === 3 ? 4 : 0;
  if (sky < 6) return 3;
  return tomato === 7 ? 4 : 0;
}

/** The Tune In scenario registry. */
export const scenarios: ScenarioRegistry<TiState> = {
  "card-pick": {
    id: "card-pick",
    description: "Two cards shown, audience voting 55/45",
    build: ({ seed }) => {
      const d = teamsCardPick(seed);
      return {
        state: d.state,
        fx: [tally(d.state.polls.card, "vote", 200, { tallies: { "0": 110, "1": 90 } })],
      };
    },
  },
  "clue-writing": {
    id: "clue-writing",
    description: "Psychic writing; phone shows the target wedge",
    build: ({ seed }) => {
      const d = teamsCardPick(seed).voteCard([110, 90]).wait(6_000);
      return { state: d.state, viewer: player(d.state.psychic) };
    },
  },
  "clue-bet": {
    id: "clue-bet",
    description: "Psychic writing, result bet 30/50/20",
    build: ({ seed }) => {
      const d = teamsCardPick(seed).voteCard([110, 90]).wait(9_000);
      return {
        state: d.state,
        fx: [
          tally(d.state.polls.bet, "predict", 240, {
            tallies: { bullseye: 72, close: 120, miss: 48 },
          }),
        ],
      };
    },
  },
  guessing: {
    id: "guessing",
    description: 'Team dial at 612, hidden heatmap ("800 dialled in")',
    build: ({ seed }) => {
      const d = teamsGuess(seed);
      const guesser = teamGuessers(d.state)[0] as PlayerId;
      d.act(guesser, { type: "setDial", v: 612 }, 3_000);
      return {
        state: d.state,
        viewer: player(guesser),
        fx: [tally(d.state.polls.dial, "dial", 800, { hideLive: true })],
      };
    },
    anim: { name: "needle", durationMs: 800 },
  },
  "heatmap-bloom": {
    id: "heatmap-bloom",
    description: "The lock moment with 800 simulated guesses",
    build: ({ seed }) => {
      const d = teamsGuess(seed, { steal: false });
      const target = d.state.hidden.target;
      const pollId = d.state.polls.dial;
      d.teamGuess(d.dialFor(3));
      const mean = Math.min(950, Math.max(50, target - 40));
      return {
        state: d.state,
        fx: [
          tally(pollId, "dial", 800, {
            tallies: histogram(800, mean, createRng(`bloom:${seed}`)),
            mean,
          }),
        ],
      };
    },
    anim: { name: "bloom", durationMs: 1200 },
  },
  steal: {
    id: "steal",
    description: "Other team picking a side",
    build: ({ seed }) => {
      const d = teamsGuess(seed);
      d.teamGuess(d.dialFor(2));
      const [first, second] = stealers(d.state) as [PlayerId, PlayerId];
      d.act(first, { type: "steal", side: "left" });
      return { state: d.state, viewer: player(second) };
    },
  },
  reveal: {
    id: "reveal",
    description: "Shutter open, 3-point hit, audience beat the team",
    build: ({ seed }) => {
      const d = teamsGuess(seed, { steal: false });
      const target = d.state.hidden.target;
      d.teamGuess(d.dialFor(3));
      d.dialResult(800, target + 8, createRng(`reveal:${seed}`));
      return { state: d.state, fx: [{ name: "reveal" }, { name: "chatBeatYou" }] };
    },
    anim: { name: "reveal", durationMs: 1400 },
  },
  "ffa-reveal": {
    id: "ffa-reveal",
    description: "6 FFA dials revealed as coloured pins",
    build: ({ seed }) => {
      const d = new TableDriver({ seed, players: 6, options: { mode: "ffa" } }).skipIntro();
      d.voteCard([70, 50]).clue();
      const points = [4, 3, 2, 0, 3] as const;
      ffaGuessers(d.state).forEach((id, i) => {
        const pts = points[i % points.length] as 0 | 2 | 3 | 4;
        d.act(id, { type: "setDial", v: d.dialFor(pts, i % 2 === 0 ? 1 : -1) }, 1_500);
        d.act(id, { type: "lock" }, 400);
      });
      if (d.state.awaitingDial) d.dialResult(640, d.state.hidden.target + 90);
      return { state: d.state, fx: [{ name: "reveal" }] };
    },
    anim: { name: "reveal", durationMs: 1400 },
  },
  final: {
    id: "final",
    description: "Team Sky wins 10-7",
    build: ({ seed }) => {
      const d = new TableDriver({ seed, players: 6, options: { steal: false } }).skipIntro();
      for (let guard = 0; guard < 12 && d.state.phase !== "final"; guard++) {
        d.playTeamTurn(finalPlan(d.state));
      }
      if (d.state.phase !== "final") throw new Error("tune-in final scenario: game did not end");
      return { state: d.state, fx: [{ name: "win", data: { winners: d.state.winners } }] };
    },
    anim: { name: "win", durationMs: 2000 },
  },

  // ---- extra visible states (registered for dev and tests; not in the spec table) ----
  intro: {
    id: "intro",
    description: "Game start: how-to-play card, Tomato vs Sky",
    build: ({ seed }) => ({ state: new TableDriver({ seed, players: 6 }).state }),
  },
  "card-pick-psychic": {
    id: "card-pick-psychic",
    description: "Too few votes: the psychic picks the card on their phone",
    build: ({ seed }) => {
      const d = teamsCardPick(seed).voteCard([2, 1]);
      return { state: d.state, viewer: player(d.state.psychic) };
    },
  },
  "ffa-guessing": {
    id: "ffa-guessing",
    description: "FFA guess: each phone tunes its own private dial",
    build: ({ seed }) => {
      const d = new TableDriver({ seed, players: 4, options: { mode: "ffa" } }).skipIntro();
      d.voteCard([30, 50]).clue();
      const [a, b] = ffaGuessers(d.state) as [PlayerId, PlayerId];
      d.act(a, { type: "setDial", v: 380 }, 2_000).act(a, { type: "lock" });
      d.act(b, { type: "setDial", v: 720 }, 1_000);
      return { state: d.state, viewer: player(b) };
    },
  },
  "turn-score": {
    id: "turn-score",
    description: "Scores tick up after a bullseye",
    build: ({ seed }) => {
      const d = teamsGuess(seed, { steal: false });
      d.teamGuess(d.dialFor(4));
      d.dialResult(500, d.state.hidden.target + 150);
      d.toDeadline();
      return { state: d.state };
    },
  },
};
