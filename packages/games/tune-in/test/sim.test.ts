/**
 * DOD G5 bot simulation for Tune In:
 *
 * - 1,001 seeded bot games across every player count (2–12) and every major option preset,
 *   with the timed bot model and a simulated audience: 0 exceptions, 0 illegal actions, every
 *   game ends within the spec's 2,000 steps, and the spec invariants (the dial is always in
 *   0–1000; scores never decrease; plus the target in 50–950) hold after every step;
 * - fairness in the symmetric setups: no seat (FFA) or team (teams mode) wins more than
 *   `1.25 / N` of its games (shared wins count as a fraction), over enough games per player
 *   count for the bound to be meaningful.
 */
import { simulateGame, type SimStepInfo } from "@sg/engine/testing";
import { describe, expect, it } from "vitest";
import { tuneIn, type TiOptions, type TiState } from "../src/logic/index.ts";
import { MAX_STEPS, PRESETS, testContent } from "./fixtures.ts";

/** Asserts the spec invariants after every step; tracks the previous scores. */
function invariantChecker(label: string): (info: SimStepInfo<TiState>) => void {
  let prev: Record<string, number> = {};
  return ({ state }) => {
    const fail = (msg: string): never => {
      throw new Error(`${label}: ${msg} (phase ${state.phase}, turn ${state.turn})`);
    };
    if (!Number.isInteger(state.dial) || state.dial < 0 || state.dial > 1000)
      fail(`dial ${state.dial}`);
    for (const [id, d] of Object.entries(state.hidden.ffaDials)) {
      if (!Number.isInteger(d.v) || d.v < 0 || d.v > 1000) fail(`${id} dial ${d.v}`);
    }
    if (state.hidden.target < 50 || state.hidden.target > 950)
      fail(`target ${state.hidden.target}`);
    for (const [id, score] of Object.entries(state.scores)) {
      if (score < (prev[id] ?? 0)) fail(`score of ${id} fell from ${prev[id]} to ${score}`);
    }
    if (state.turn > state.maxTurns) fail(`turn ${state.turn} beyond cap ${state.maxTurns}`);
    prev = { ...state.scores };
  };
}

describe("G5: 1,001 seeded bot games", () => {
  const counts = Array.from({ length: 11 }, (_, i) => i + 2);
  for (const players of counts) {
    it(`${players} players × ${PRESETS.length} presets × 13 seeds`, () => {
      let maxSteps = 0;
      for (const [p, preset] of PRESETS.entries()) {
        for (let s = 1; s <= 13; s++) {
          const seed = players * 10_000 + p * 100 + s;
          const label = `${players}p preset ${p} seed ${seed}`;
          const r = simulateGame(tuneIn, {
            seed,
            players,
            options: preset,
            content: testContent,
            maxSteps: MAX_STEPS,
            onStep: invariantChecker(label),
          });
          expect(r.ended, `${label}: ${r.failure ?? ""}`).toBe(true);
          expect(r.illegalActions, `${label}: ${r.illegalSamples.join("; ")}`).toBe(0);
          expect(r.steps).toBeLessThanOrEqual(MAX_STEPS);
          expect(r.result?.ranking.length).toBeGreaterThan(0);
          maxSteps = Math.max(maxSteps, r.steps);
        }
      }
      expect(maxSteps).toBeLessThanOrEqual(MAX_STEPS);
    }, 300_000);
  }
});

/** Fractional first-place share per ranked id over `games` games. */
function winRates(
  players: number,
  options: Partial<TiOptions>,
  games: number,
): Record<string, number> {
  const wins: Record<string, number> = {};
  for (let g = 1; g <= games; g++) {
    const r = simulateGame(tuneIn, {
      seed: 500_000 + players * 10_000 + g,
      players,
      options,
      content: testContent,
      maxSteps: MAX_STEPS,
      dev: false,
    });
    if (!r.ended || r.result === null) throw new Error(`fairness game ${g} did not end`);
    const first = r.result.ranking.filter((x) => x.place === 1);
    for (const f of first) wins[f.id] = (wins[f.id] ?? 0) + 1 / first.length;
  }
  return Object.fromEntries(Object.entries(wins).map(([id, w]) => [id, w / games]));
}

describe("G5: fairness", () => {
  const ffa: [number, number][] = [
    [2, 400],
    [3, 800],
    [4, 800],
    [6, 1000],
    [9, 1000],
    [12, 1500],
  ];
  for (const [players, games] of ffa) {
    it(`FFA ${players} players: no seat wins more than 1.25/${players} (${games} games)`, () => {
      const rates = winRates(players, { mode: "ffa" }, games);
      expect(Object.keys(rates)).toHaveLength(players);
      for (const [id, rate] of Object.entries(rates)) {
        expect(rate, `${id} wins ${(rate * 100).toFixed(1)}%`).toBeLessThanOrEqual(1.25 / players);
      }
    }, 300_000);
  }
  for (const players of [4, 7, 12]) {
    it(`teams ${players} players: neither team wins more than 62.5% (600 games)`, () => {
      const rates = winRates(players, { mode: "teams" }, 600);
      expect(Object.keys(rates).sort()).toEqual(["sky", "tomato"]);
      for (const [id, rate] of Object.entries(rates)) {
        expect(rate, `${id} wins ${(rate * 100).toFixed(1)}%`).toBeLessThanOrEqual(0.625);
      }
    }, 300_000);
  }
});
