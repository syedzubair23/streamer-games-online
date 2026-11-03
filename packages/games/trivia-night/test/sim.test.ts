/**
 * DOD G5 bot simulation for Trivia Night (Classic):
 *
 * - 1,050 seeded bot games across every player count (1–10) and every major option preset,
 *   with the timed bot model and a simulated audience: 0 exceptions, 0 illegal actions, every
 *   game ends within the spec's 1,500 steps, and the spec invariants hold after every step (at
 *   most one lock per player per question, and it never changes; scores never fall; team scores
 *   are their members' sums; Steamed lasts 1–2 questions; the question number stays in range);
 * - team-mode games (room teams) under the same checks;
 * - fairness: the game is symmetric, so no seat wins more than `1.25 / N` of its games.
 */
import type { Seat } from "@sg/engine";
import { makeSeats, simulateGame, type SimStepInfo } from "@sg/engine/testing";
import { describe, expect, it } from "vitest";
import {
  involves,
  triviaNight,
  type Lock,
  type TnOptions,
  type TnState,
} from "../src/logic/index.ts";
import { MAX_STEPS, PRESETS, testContent } from "./fixtures.ts";

/** Asserts the spec invariants after every step; tracks the previous step. */
function invariantChecker(label: string): (info: SimStepInfo<TnState>) => void {
  let prevScores: Record<string, number> = {};
  let prevLocks: { index: number; phase: string; answers: Record<string, Lock> } | null = null;
  return ({ state }) => {
    const fail = (msg: string): never => {
      throw new Error(`${label}: ${msg} (phase ${state.phase}, Q${state.index})`);
    };
    const locks = state.phase.startsWith("showdown")
      ? state.hidden.showdownAnswers
      : state.hidden.answers;
    const list = state.phase.startsWith("showdown")
      ? (state.showdown?.answered ?? [])
      : state.answered;
    if (new Set(list).size !== list.length) fail(`duplicate lock in ${JSON.stringify(list)}`);
    if (list.length !== Object.keys(locks).length) fail("answered list and locks disagree");
    if (
      prevLocks !== null &&
      prevLocks.index === state.index &&
      prevLocks.phase.startsWith("showdown") === state.phase.startsWith("showdown")
    ) {
      for (const [id, lock] of Object.entries(prevLocks.answers)) {
        const now = locks[id];
        if (now !== undefined && (now.choice !== lock.choice || now.at !== lock.at))
          fail(`${id} changed its lock`);
      }
    }
    prevLocks = { index: state.index, phase: state.phase, answers: { ...locks } };
    for (const lock of Object.values(locks)) {
      if (!Number.isInteger(lock.choice) || lock.choice < 0 || lock.choice > 3)
        fail(`choice ${lock.choice}`);
    }
    for (const [id, score] of Object.entries(state.scores)) {
      if (score < (prevScores[id] ?? 0))
        fail(`score of ${id} fell from ${prevScores[id]} to ${score}`);
    }
    prevScores = { ...state.scores };
    for (const t of state.teams) {
      const sum = t.members.reduce((a, m) => a + (state.scores[m] ?? 0), 0);
      if ((state.teamScores[t.id] ?? 0) !== sum)
        fail(`team ${t.id} score ${state.teamScores[t.id]} ≠ ${sum}`);
    }
    for (const [id, s] of Object.entries(state.steamed)) {
      if (s.questionsLeft !== 1 && s.questionsLeft !== 2) fail(`${id} steamed ${s.questionsLeft}`);
    }
    if (state.index < 0 || state.index > state.total)
      fail(`index ${state.index} of ${state.total}`);
    if (state.showdown !== undefined && state.showdown.players[0] === state.showdown.players[1]) {
      fail("showdown against oneself");
    }
  };
}

function check(
  label: string,
  players: number | readonly Seat[],
  options: Partial<TnOptions>,
  seed: number,
): number {
  const r = simulateGame(triviaNight, {
    seed,
    players,
    options,
    content: testContent,
    maxSteps: MAX_STEPS,
    involves,
    onStep: invariantChecker(label),
  });
  expect(r.ended, `${label}: ${r.failure ?? ""}`).toBe(true);
  expect(r.illegalActions, `${label}: ${r.illegalSamples.join("; ")}`).toBe(0);
  expect(r.steps).toBeLessThanOrEqual(MAX_STEPS);
  expect(r.result?.ranking.length).toBeGreaterThan(0);
  return r.steps;
}

describe("G5: 1,050 seeded bot games", () => {
  for (let players = 1; players <= 10; players++) {
    it(`${players} players × ${PRESETS.length} presets × 15 seeds`, () => {
      let maxSteps = 0;
      for (const [p, preset] of PRESETS.entries()) {
        for (let s = 1; s <= 15; s++) {
          const seed = players * 10_000 + p * 100 + s;
          maxSteps = Math.max(
            maxSteps,
            check(`${players}p preset ${p} seed ${seed}`, players, preset, seed),
          );
        }
      }
      expect(maxSteps).toBeLessThanOrEqual(MAX_STEPS);
    }, 900_000);
  }

  it("team mode (2–4 room teams, 2–10 players) under the same checks", () => {
    const teamSets = [
      ["tomato", "sky"],
      ["tomato", "sky", "sunflower"],
      ["tomato", "sky", "sunflower", "mint"],
    ];
    let games = 0;
    for (const teams of teamSets) {
      for (let players = Math.max(2, teams.length); players <= 10; players += 2) {
        for (let s = 1; s <= 6; s++) {
          check(
            `teams ${teams.length} ${players}p seed ${s}`,
            makeSeats(players, { teams }),
            {},
            700_000 + players * 100 + s,
          );
          games += 1;
        }
      }
    }
    expect(games).toBeGreaterThan(60);
  }, 900_000);
});

/** Fractional first-place share per seat over `games` games. */
function winRates(players: number, games: number): Record<string, number> {
  const wins: Record<string, number> = {};
  for (let g = 1; g <= games; g++) {
    const r = simulateGame(triviaNight, {
      seed: 500_000 + players * 10_000 + g,
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
  const counts: [number, number][] = [
    [2, 600],
    [3, 800],
    [4, 800],
    [6, 900],
    [8, 1000],
    [10, 1200],
  ];
  for (const [players, games] of counts) {
    it(`${players} players: no seat wins more than 1.25/${players} (${games} games)`, () => {
      const rates = winRates(players, games);
      expect(Object.keys(rates).length).toBeGreaterThanOrEqual(players - 1);
      for (const [id, rate] of Object.entries(rates)) {
        expect(rate, `${id} wins ${(rate * 100).toFixed(1)}%`).toBeLessThanOrEqual(1.25 / players);
      }
    }, 900_000);
  }
});
