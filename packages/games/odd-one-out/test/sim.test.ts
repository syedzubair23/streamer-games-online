/**
 * Bot simulation (DOD G5) for Odd One Out: 1,000 seeded games with the timed bot model across
 * every player count (4–10), every major option preset and every room shape that changes the
 * rules (the family filter, a seated host, timerScale 0). Zero exceptions, zero illegal bot
 * actions, every game ends within the spec's 1,000 max steps, and every invariant holds after
 * every step:
 *
 * - `hidden.odd` is never empty during a round (spec "Invariants");
 * - exactly one clue per player per pass: never two, and all of them once the clue passes end
 *   (unless a said word ended the round early);
 * - the scores always equal the sum of the finished rounds' points;
 * - `deadline` is null only for an input phase at timerScale 0.
 *
 * Fairness (symmetric game: the odd ones are drawn at random): no seat's win rate exceeds
 * 1.25 / N per player count; a shared first place counts as a fraction of a win for each. The
 * 1,000 sim games alone are too few to tell a 1.25 / N seat from noise at 10 seats, so the
 * fairness check adds 160 × (N − 1) bot-takeover playouts per player count on the real runner
 * (about 3.5 standard deviations of margin per seat).
 */
import { describe, expect, it } from "vitest";
import { GameRunner } from "@sg/engine";
import { makeSeats, simulateGame } from "@sg/engine/testing";
import {
  createOddOneOut,
  INPUT_PHASES,
  involves,
  logic,
  PHASES,
  ROUND_PHASES,
  type OddOneOutModule,
  type OooOptions,
  type OooState,
} from "../src/logic/index.ts";
import { fixtureContent } from "../src/scenarios.ts";
import { content } from "./helpers.ts";

const MAX_STEPS = 1_000;

const PRESETS: Partial<OooOptions>[] = [
  {},
  { variant: "undercover" },
  { oddCount: "2", clueRounds: "1" },
  { rounds: 8, clueRounds: "3", clueSec: 10, discussSec: 20 },
  { audienceSecret: "off", oddCount: "1", clueSec: 60, discussSec: 180, rounds: 2 },
  { variant: "undercover", oddCount: "2", clueRounds: "2" },
];

interface Variant {
  name: string;
  module: OddOneOutModule;
  timerScale: 0 | 1;
}

const VARIANTS: Variant[] = [
  { name: "default", module: logic, timerScale: 1 },
  { name: "family", module: createOddOneOut({ contentFilter: "family" }), timerScale: 1 },
  { name: "host seated", module: createOddOneOut({ hostSeated: true }), timerScale: 1 },
  { name: "timerScale 0", module: logic, timerScale: 0 },
];

const SAID: readonly string[] = ["said-word", "odd-said-word"];

/** The spec invariants for one state; returns the problems. */
function invariantProblems(s: OooState, timerScale: number): string[] {
  const out: string[] = [];
  if (!PHASES.includes(s.phase)) out.push(`unknown phase ${s.phase}`);
  if (ROUND_PHASES.includes(s.phase) && s.hidden.odd.length === 0) out.push("hidden.odd is empty");
  if (ROUND_PHASES.includes(s.phase) && s.hidden.odd.length !== s.oddCount) {
    out.push(`${s.hidden.odd.length} odd ones, oddCount ${s.oddCount}`);
  }
  const seen = new Set<string>();
  for (const c of s.clues) {
    const k = `${c.by}#${c.pass}`;
    if (seen.has(k)) out.push(`two clues from ${c.by} in pass ${c.pass}`);
    seen.add(k);
  }
  const afterClues = ROUND_PHASES.indexOf(s.phase) > ROUND_PHASES.indexOf("clues");
  const early = s.roundResult !== undefined && SAID.includes(s.roundResult.outcome);
  if (afterClues && !early && s.clues.length !== s.players.length * s.passes) {
    out.push(`${s.clues.length} clues after the passes (want ${s.players.length * s.passes})`);
  }
  const awarded = s.history.reduce(
    (sum, r) => sum + Object.values(r.points).reduce((a, b) => a + b, 0),
    0,
  );
  const total = Object.values(s.scores).reduce((a, b) => a + b, 0);
  if (awarded !== total) out.push(`scores total ${total} but rounds awarded ${awarded}`);
  const noTimer = INPUT_PHASES.includes(s.phase) && timerScale === 0;
  if ((s.deadline === null) !== noTimer) out.push(`deadline ${s.deadline} in ${s.phase}`);
  return out;
}

describe("G5: bot simulation", () => {
  const wins = new Map<number, number[]>();
  const games = new Map<number, number>();

  it("1,000 seeded games: no exceptions, no illegal actions, all end within 1,000 steps, invariants hold", () => {
    const problems: string[] = [];
    let maxSteps = 0;
    for (let i = 0; i < 1000; i++) {
      const n = 4 + (i % 7);
      const preset = PRESETS[Math.floor(i / 7) % PRESETS.length] as Partial<OooOptions>;
      const variant = VARIANTS[Math.floor(i / 42) % VARIANTS.length] as Variant;
      const label = `game ${i} (${variant.name}, ${n}p, ${JSON.stringify(preset)})`;
      const sim = simulateGame(variant.module, {
        seed: i + 1,
        players: n,
        options: preset,
        timerScale: variant.timerScale,
        content: () => content(),
        maxSteps: MAX_STEPS,
        involves,
        dev: i % 10 === 0,
        onStep: ({ state }) => {
          if (problems.length >= 10) return;
          for (const p of invariantProblems(state, variant.timerScale))
            problems.push(`${label}: ${p}`);
        },
      });
      maxSteps = Math.max(maxSteps, sim.steps);
      if (!sim.ended) problems.push(`${label}: did not end (${sim.failure ?? "?"})`);
      if (sim.illegalActions > 0) {
        problems.push(`${label}: ${sim.illegalActions} illegal: ${sim.illegalSamples.join("; ")}`);
      }
      const ranking = sim.result?.ranking ?? [];
      const first = ranking.filter((r) => r.place === 1).map((r) => Number(r.id.slice(1)) - 1);
      const row = wins.get(n) ?? Array.from({ length: n }, () => 0);
      for (const seat of first) row[seat] = (row[seat] ?? 0) + 1 / first.length;
      wins.set(n, row);
      games.set(n, (games.get(n) ?? 0) + 1);
    }
    expect(problems).toEqual([]);
    expect(maxSteps).toBeLessThanOrEqual(MAX_STEPS);
  }, 3_600_000);

  it("fairness: no seat wins more than 1.25 / N of the games at any player count", () => {
    for (let n = 4; n <= 10; n++) {
      const row = wins.get(n) ?? Array.from({ length: n }, () => 0);
      const playouts = 160 * (n - 1);
      for (let i = 0; i < playouts; i++) {
        const runner = new GameRunner(logic, {
          players: makeSeats(n),
          seed: `fair:${n}:${i}`,
          now: 0,
          content: fixtureContent(),
          dev: false,
          botDelayMs: 800,
        });
        for (const p of runner.players) runner.setBot(p.id, true, 0);
        for (let guard = 0; !runner.ended && guard < 5_000; guard++) {
          const at = runner.nextEventAt();
          if (at === null) break;
          runner.advance(at);
        }
        expect(runner.ended).toBe(true);
        expect(runner.stats.botIllegal).toBe(0);
        const first = (runner.result?.ranking ?? []).filter((r) => r.place === 1);
        for (const f of first) {
          const seat = Number(f.id.slice(1)) - 1;
          row[seat] = (row[seat] ?? 0) + 1 / first.length;
        }
      }
      wins.set(n, row);
      games.set(n, (games.get(n) ?? 0) + playouts);
    }
    const over: string[] = [];
    for (const [n, row] of wins) {
      const count = games.get(n) ?? 1;
      row.forEach((w, seat) => {
        if (w / count > 1.25 / n) {
          over.push(`${n}p seat ${seat}: ${(w / count).toFixed(3)} > ${(1.25 / n).toFixed(3)}`);
        }
      });
    }
    expect(wins.size).toBe(7);
    expect(over).toEqual([]);
  }, 3_600_000);
});
