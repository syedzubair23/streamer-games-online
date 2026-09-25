/**
 * Bot simulation (DOD G5) for Quip Clash: 1,000 seeded games with the timed bot model across
 * every player count (3–8), every major option preset and every room shape that changes the
 * rules (team mode with 3 and 4 teams, the 2-team fallback, reveal-review moderation, the family
 * filter, timerScale 0). Zero exceptions, zero illegal bot actions, every game ends within the
 * spec's 400 max steps, and every spec invariant holds after every step:
 *
 * - the sum of the authors' `playerShare` in a matchup is 1 (or both 0.5); in Last Quip it is 1;
 * - scores never decrease;
 * - `deadline` is set if and only if the phase is an input phase and timerScale is not 0.
 *
 * Fairness (symmetric game): no seat's win rate exceeds 1.25 / N, measured per player count over
 * the sim games plus bot-takeover playouts on the real runner.
 */
import { describe, expect, it } from "vitest";
import { GameRunner, type Effect, type PollSpec, type Seat } from "@sg/engine";
import { makeSeats, pollResult, simulateGame } from "@sg/engine/testing";
import { createRng } from "@sg/shared";
import {
  createQuipClash,
  INPUT_PHASES,
  involves,
  logic,
  PHASES,
  type QcOptions,
  type QcState,
  type QuipClashModule,
} from "../src/logic/index.ts";
import { content, roomTeams, teamSeats } from "./helpers.ts";

const MAX_STEPS = 400;

const PRESETS: Partial<QcOptions>[] = [
  {},
  { rounds: "2" },
  { safetyQuip: false, audienceWeight: 0 },
  { audienceWeight: 50, answerSec: 45, voteSec: 10 },
  { answerSec: 180, voteSec: 40, packs: ["quip-core", "quip-spicy"] },
];

interface Variant {
  name: string;
  module: QuipClashModule;
  seats: (n: number) => Seat[];
  timerScale?: 0 | 1;
  /** Solo games count towards seat fairness. */
  solo: boolean;
}

const VARIANTS: Variant[] = [
  { name: "solo", module: logic, seats: (n) => makeSeats(n), solo: true },
  { name: "3 teams", module: logic, seats: (n) => teamSeats(n, ["t1", "t2", "t3"]), solo: false },
  {
    name: "4 teams",
    module: logic,
    seats: (n) => teamSeats(n, n >= 4 ? ["t1", "t2", "t3", "t4"] : ["t1", "t2", "t3"]),
    solo: false,
  },
  {
    name: "2 teams (solo fallback)",
    module: logic,
    seats: (n) => teamSeats(n, ["t1", "t2"]),
    solo: true,
  },
  {
    name: "moderation",
    module: createQuipClash({ moderation: "reveal-review" }),
    seats: (n) => makeSeats(n),
    solo: true,
  },
  {
    name: "family",
    module: createQuipClash({ contentFilter: "family" }),
    seats: (n) => makeSeats(n),
    solo: true,
  },
  { name: "timerScale 0", module: logic, seats: (n) => makeSeats(n), timerScale: 0, solo: true },
];

/** Checks the spec invariants between two consecutive states; returns the problems. */
function invariantProblems(prev: QcState | null, s: QcState, timerScale: number): string[] {
  const out: string[] = [];
  if (!PHASES.includes(s.phase)) out.push(`unknown phase ${s.phase}`);
  const wantDeadline = INPUT_PHASES.includes(s.phase) && timerScale !== 0;
  if ((s.deadline !== null) !== wantDeadline) {
    out.push(`deadline ${s.deadline} in ${s.phase} (timerScale ${timerScale})`);
  }
  for (const [pid, r] of Object.entries(s.results)) {
    const shares = Object.values(r.playerShare);
    const sum = shares.reduce((a, b) => a + b, 0);
    const bothHalf = shares.length === 2 && shares.every((x) => x === 0.5);
    if (!bothHalf && shares.length > 0 && Math.abs(sum - 1) > 1e-9) {
      out.push(`${pid}: playerShare sums to ${sum}`);
    }
  }
  if (prev !== null) {
    for (const [a, v] of Object.entries(prev.scores)) {
      if ((s.scores[a] ?? 0) < v) out.push(`score of ${a} decreased ${v} -> ${s.scores[a]}`);
    }
  }
  const awarded = Object.values(s.results).reduce(
    (sum, r) => sum + Object.values(r.points).reduce((a, b) => a + b, 0),
    0,
  );
  const total = Object.values(s.scores).reduce((a, b) => a + b, 0);
  if (awarded !== total) out.push(`scores total ${total} but results awarded ${awarded}`);
  return out;
}

/** Winner (place 1) seat index of a finished game, for solo games. */
const winnerSeat = (seats: readonly Seat[], rankingFirst: string | undefined): number =>
  seats.findIndex((s) => s.id === rankingFirst);

describe("G5: bot simulation", () => {
  const wins = new Map<number, number[]>();
  const record = (n: number, seat: number): void => {
    const row = wins.get(n) ?? Array.from({ length: n }, () => 0);
    if (seat >= 0) row[seat] = (row[seat] ?? 0) + 1;
    wins.set(n, row);
  };

  it("1,000 seeded games: no exceptions, no illegal actions, all end within 400 steps, invariants hold", () => {
    const problems: string[] = [];
    let maxSteps = 0;
    for (let i = 0; i < 1000; i++) {
      const n = 3 + (i % 6);
      const preset = PRESETS[Math.floor(i / 6) % PRESETS.length] as Partial<QcOptions>;
      const variant = VARIANTS[Math.floor(i / 30) % VARIANTS.length] as Variant;
      const seats = variant.seats(n);
      const timerScale = variant.timerScale ?? 1;
      let prev: QcState | null = null;
      const label = `game ${i} (${variant.name}, ${n}p, ${JSON.stringify(preset)})`;
      const sim = simulateGame(variant.module, {
        seed: i + 1,
        players: seats,
        options: preset,
        timerScale,
        content: () => content(),
        maxSteps: MAX_STEPS,
        involves,
        dev: i % 10 === 0,
        onStep: ({ state }) => {
          if (problems.length < 10) {
            for (const p of invariantProblems(prev, state, timerScale))
              problems.push(`${label}: ${p}`);
          }
          prev = state;
        },
      });
      maxSteps = Math.max(maxSteps, sim.steps);
      if (!sim.ended) problems.push(`${label}: did not end (${sim.failure ?? "?"})`);
      if (sim.illegalActions > 0)
        problems.push(`${label}: illegal ${sim.illegalSamples.join("; ")}`);
      if (sim.steps > MAX_STEPS) problems.push(`${label}: ${sim.steps} steps`);
      const authors = new Set(seats.map((s) => s.teamId ?? s.id));
      const teamMode = !variant.solo;
      const expected = teamMode ? authors.size : seats.length;
      if (sim.result?.ranking.length !== expected) problems.push(`${label}: ranking size`);
      if (variant.solo && preset === PRESETS[0])
        record(n, winnerSeat(seats, sim.result?.ranking[0]?.id));
    }
    expect(problems).toEqual([]);
    expect(maxSteps).toBeLessThanOrEqual(MAX_STEPS);
  }, 600_000);

  it("fairness: no seat wins more than 1.25 / N of games (N = 3..8)", () => {
    // Games per N keep the 1.25 / N bound at least 3 standard errors above 1 / N.
    const GAMES: Record<number, number> = { 3: 450, 4: 600, 5: 750, 6: 900, 7: 1050, 8: 1200 };
    for (let n = 3; n <= 8; n++) {
      for (let seed = 1; seed <= (GAMES[n] as number); seed++) {
        const { ranking } = playout(logic, makeSeats(n), 100_000 * n + seed);
        record(n, winnerSeat(makeSeats(n), ranking[0]));
      }
      const row = wins.get(n) as number[];
      const games = row.reduce((a, b) => a + b, 0);
      const bound = 1.25 / n;
      for (const [seat, w] of row.entries()) {
        expect(w / games, `${n}p seat ${seat}: ${w}/${games}`).toBeLessThanOrEqual(bound);
      }
    }
  }, 600_000);

  it("fairness in team mode: no team wins more than 1.25 / N", () => {
    for (const teams of [3, 4]) {
      const ids = roomTeams(teams).map((t) => t.id);
      const tally: Record<string, number> = {};
      const games = 900;
      for (let seed = 1; seed <= games; seed++) {
        const { ranking } = playout(
          logic,
          teamSeats(teams * 2, ids),
          7_000_000 + seed,
          roomTeams(teams),
        );
        const first = ranking[0] as string;
        tally[first] = (tally[first] ?? 0) + 1;
      }
      for (const id of ids)
        expect((tally[id] ?? 0) / games, `team ${id}`).toBeLessThanOrEqual(1.25 / teams);
    }
  }, 600_000);
});

/**
 * A fast bot-vs-bot playout on the real runner: every seat plays `bot()` at once whenever it has
 * something to do (passes over the seats until nobody acts), a simulated audience answers every
 * poll when it closes, and the clock jumps from event to event.
 */
function playout(
  module: QuipClashModule,
  seats: Seat[],
  seed: number,
  teams: { id: string; name: string; colorSlot: number }[] = [],
): { ranking: string[] } {
  const runner = new GameRunner(module, {
    players: seats,
    teams,
    seed,
    now: 0,
    content: content(),
    audienceCount: 50,
    dev: false,
  });
  const rng = createRng(`playout:${seed}`);
  const botRng = rng.fork("bots");
  const audience = Array.from({ length: 50 }, (_, i) => `aud${i}`);
  const polls = new Map<string, PollSpec>();
  let result: string[] | null = null;
  let now = 0;
  const route = (effects: readonly Effect[]): void => {
    const queue = [...effects];
    while (queue.length > 0) {
      const e = queue.shift() as Effect;
      if (e.type === "audience.open") polls.set(e.poll.pollId, e.poll);
      if (e.type === "audience.close") {
        const spec = polls.get(e.pollId);
        polls.delete(e.pollId);
        if (spec !== undefined) {
          queue.push(...runner.audienceResult(pollResult(spec, audience, rng), now).effects);
        }
      }
      if (e.type === "end") result = e.result.ranking.map((r) => String(r.id));
    }
  };
  route(runner.setupEffects);
  for (let i = 0; i < 3000 && result === null; i++) {
    let acted = true;
    while (acted && result === null) {
      acted = false;
      for (const s of seats) {
        const action = module.bot(runner.state, s.id, botRng);
        if (action === null) continue;
        const r = runner.act(s.id, action, now);
        if (!r.ok) throw new Error(`playout ${seed}: illegal ${JSON.stringify(action)}`);
        route(r.effects);
        acted = true;
      }
    }
    if (result !== null) break;
    const at = runner.nextEventAt();
    if (at === null) throw new Error(`playout ${seed}: stalled in ${runner.state.phase}`);
    now = at;
    route(runner.advance(at).effects);
  }
  if (result === null) throw new Error(`playout ${seed}: did not end`);
  return { ranking: result };
}
