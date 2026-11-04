/**
 * DOD G5 bot simulation for Doodle (Guess mode and Team Doodle):
 *
 * - 1,008 seeded bot games across every player count (3–12) and every major option preset,
 *   plus Team Doodle for 4–12 players, with the timed bot model and a simulated audience:
 *   0 exceptions, 0 illegal actions, every game ends within the spec's 20,000 steps, and the
 *   spec invariants hold after every step (`drawing.points ≤ 20000`, at most 600 strokes; the
 *   feed never contains the text of a correct guess, nor the word; the feed keeps at most 30
 *   entries; scores never decrease);
 * - fairness in the symmetric setups: no seat (FFA) or team wins more than `1.25 / N` of its
 *   games (shared wins count as a fraction).
 */
import { simulateGame, type SimStepInfo } from "@sg/engine/testing";
import { describe, expect, it } from "vitest";
import {
  FEED_MAX,
  MAX_POINTS,
  MAX_STROKES,
  containsAnswer,
  logic,
  matchGuess,
  type DoodleModule,
  type DoodleOptions,
  type DoodleState,
} from "../src/logic/index.ts";
import { MAX_STEPS, PRESETS, TEAMS, teamDoodle, testContent } from "./fixtures.ts";

/** The word the feed must never show at this step (the live word, or the one being revealed). */
function currentWord(state: DoodleState): { w: string; alt: string[] } | null {
  if (state.hidden.word !== undefined) return state.hidden.word;
  if (state.reveal !== null) return { w: state.reveal.word, alt: state.reveal.alt };
  return null;
}

/** Asserts the spec invariants after every step; tracks the previous scores. */
function invariantChecker(label: string): (info: SimStepInfo<DoodleState>) => void {
  let prev: Record<string, number> = {};
  return ({ state }) => {
    const fail = (msg: string): never => {
      throw new Error(`${label}: ${msg} (phase ${state.phase}, turn ${state.turn})`);
    };
    if (state.drawing.points > MAX_POINTS) fail(`drawing has ${state.drawing.points} points`);
    if (state.drawing.strokes.length > MAX_STROKES) fail("more than 600 strokes");
    const counted = state.drawing.strokes.reduce((n, s) => n + s.pts.length / 2, 0);
    if (counted !== state.drawing.points) fail(`points ${state.drawing.points} != ${counted}`);
    if (state.feed.length > FEED_MAX) fail(`feed has ${state.feed.length} entries`);
    const word = currentWord(state);
    for (const f of state.feed) {
      if (f.correct === true && f.text !== undefined) fail("a correct feed entry carries text");
      if (word !== null && f.text !== undefined && f.insider !== true) {
        if (matchGuess(f.text, word) === "correct") fail(`feed shows a correct guess "${f.text}"`);
        if (containsAnswer(f.text, word)) fail(`feed shows the word in "${f.text}"`);
      }
    }
    for (const [id, score] of Object.entries(state.scores)) {
      if (score < (prev[id] ?? 0)) fail(`score of ${id} fell from ${prev[id]} to ${score}`);
    }
    prev = { ...state.scores };
  };
}

function play(
  module: DoodleModule,
  players: number,
  options: Partial<DoodleOptions>,
  seed: number,
): number {
  const label = `${players}p seed ${seed} ${JSON.stringify(options)}`;
  const r = simulateGame(module, {
    seed,
    players,
    options,
    content: testContent,
    maxSteps: MAX_STEPS,
    onStep: invariantChecker(label),
  });
  expect(r.ended, `${label}: ${r.failure ?? ""}`).toBe(true);
  expect(r.illegalActions, `${label}: ${r.illegalSamples.join("; ")}`).toBe(0);
  expect(r.steps).toBeLessThanOrEqual(MAX_STEPS);
  expect(r.result?.ranking.length).toBeGreaterThan(0);
  return r.steps;
}

describe("G5: 1,008 seeded bot games", () => {
  for (let players = 3; players <= 12; players++) {
    it(`${players} players × ${PRESETS.length} presets × 15 seeds (+ Team Doodle)`, () => {
      let games = 0;
      let maxSteps = 0;
      for (const [p, preset] of PRESETS.entries()) {
        for (let s = 1; s <= 15; s++) {
          maxSteps = Math.max(
            maxSteps,
            play(logic, players, preset, players * 10_000 + p * 100 + s),
          );
          games++;
        }
      }
      if (players >= 4) {
        const teams = teamDoodle();
        for (let s = 1; s <= 12; s++) {
          maxSteps = Math.max(maxSteps, play(teams, players, {}, players * 10_000 + 900 + s));
          games++;
        }
      }
      expect(games).toBe(players >= 4 ? 102 : 90);
      expect(maxSteps).toBeLessThanOrEqual(MAX_STEPS);
    }, 900_000);
  }
});

/** Fractional first-place share per ranked id over `games` games. */
function winRates(
  module: DoodleModule,
  players: number,
  games: number,
  base: number,
): Record<string, number> {
  const wins: Record<string, number> = {};
  for (let g = 1; g <= games; g++) {
    const r = simulateGame(module, {
      seed: base + players * 10_000 + g,
      players,
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
    [3, 900],
    [4, 900],
    [5, 1000],
    [8, 1200],
    [12, 1500],
  ];
  for (const [players, games] of ffa) {
    it(`FFA ${players} players: no seat wins more than 1.25/${players} (${games} games)`, () => {
      const rates = winRates(logic, players, games, 500_000);
      expect(Object.keys(rates)).toHaveLength(players);
      for (const [id, rate] of Object.entries(rates)) {
        expect(rate, `${id} wins ${(rate * 100).toFixed(1)}%`).toBeLessThanOrEqual(1.25 / players);
      }
    }, 900_000);
  }
  for (const players of [4, 6, 12]) {
    it(`Team Doodle ${players} players: neither team wins more than 62.5% (600 games)`, () => {
      const rates = winRates(teamDoodle(), players, 600, 700_000);
      expect(Object.keys(rates).sort()).toEqual([...TEAMS].sort());
      for (const [id, rate] of Object.entries(rates)) {
        expect(rate, `${id} wins ${(rate * 100).toFixed(1)}%`).toBeLessThanOrEqual(0.625);
      }
    }, 900_000);
  }
});
