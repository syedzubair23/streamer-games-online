/**
 * The sim runner: the timed bot model, the simulated audience, the timeline and the pacing
 * report (ROADMAP M0-04 `sim.ts`, DOD G5/G14). Includes the Accept's expected-to-fail case: a
 * fixture with a 60 s phase and no audience interaction fails the audience-idle check.
 */
import { createRng, type AudId, type PlayerId } from "@sg/shared";
import { describe, expect, it } from "vitest";
import type { Ctx, GameModule, SetupContext, Step } from "../src/game-module.ts";
import {
  checkPacing,
  defaultPlayerCounts,
  longestGap,
  pacingReport,
  pollResult,
  quantile,
  seedList,
  simulateGame,
} from "../src/testing/sim.ts";
import { makeProbe } from "./fixtures/probe.ts";
import { slowThink, THINK_MS } from "./fixtures/slow-think.ts";
import { tictactoe } from "./fixtures/tictactoe/index.ts";

describe("timed bot model", () => {
  it("every bot acts between 25% and 70% of its input window, never instantly", () => {
    const window = 15_000 + 3_000; // turnSec 15 × timerScale 1 + 3 s stream delay
    let inputs = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const sim = simulateGame(tictactoe, { seed, players: 2 });
      expect(sim.ended).toBe(true);
      expect(sim.illegalActions).toBe(0);
      for (const e of sim.timeline) {
        if (e.kind !== "input") continue;
        inputs++;
        const len = e.endMs - e.startMs;
        expect(len).toBeGreaterThanOrEqual(0.25 * window - 1);
        expect(len).toBeLessThanOrEqual(0.7 * window + 1);
      }
    }
    expect(inputs).toBeGreaterThan(100);
  });

  it("honours a custom bot window", () => {
    const sim = simulateGame(tictactoe, { seed: 3, players: 2, botWindow: [0.9, 0.9] });
    const first = sim.timeline.find((e) => e.kind === "input");
    expect(first && first.endMs - first.startMs).toBe(Math.round(0.9 * 18_000));
  });

  it("is deterministic: same seed, same fingerprint; different seed, different game", () => {
    const a = simulateGame(tictactoe, { seed: 11, players: 2, recordHashes: true });
    const b = simulateGame(tictactoe, { seed: 11, players: 2, recordHashes: true });
    const c = simulateGame(tictactoe, { seed: 12, players: 2 });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.hashes.length).toBeGreaterThan(5);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });

  it("runs timerScale 0 games with the simulated host's forceAdvance", () => {
    const sim = simulateGame(tictactoe, { seed: 2, players: 2, timerScale: 0 });
    expect(sim.ended).toBe(true);
    expect(sim.illegalActions).toBe(0);
  });

  it("reports a stalled game instead of spinning", () => {
    const sim = simulateGame(makeProbe(), { seed: 1, players: 1 });
    expect(sim.ended).toBe(false);
    expect(sim.failure).toMatch(/stalled/);
  });

  it("reports a runaway game at maxSteps", () => {
    const sim = simulateGame(tictactoe, { seed: 1, players: 2, maxSteps: 3 });
    expect(sim.ended).toBe(false);
    expect(sim.failure).toMatch(/maxSteps/);
  });

  it("calls onStep after every event with the live state", () => {
    const phases: string[] = [];
    simulateGame(tictactoe, {
      seed: 1,
      players: 2,
      onStep: ({ state }) => phases.push(state.phase),
    });
    expect(phases[0]).toBe("intro");
    expect(phases).toContain("turn");
    expect(phases.at(-1)).toBe("result");
  });

  it("re-rolls the reaction time when a new input window opens", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const sim = simulateGame(twoWindows, { seed, players: 1 });
      expect(sim.ended).toBe(true);
      // Scheduled in window "a" (60 s), the action would land after window "b" (10 s) closed.
      expect(sim.finalState.actedIn).toBe("b");
    }
  });
});

describe("simulated audience", () => {
  it("answers every poll with 50 bots, in the SPEC §4 result shapes", () => {
    const rng = createRng(1);
    const aud: AudId[] = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const vote = pollResult(
      {
        pollId: "v",
        kind: "vote",
        prompt: "",
        options: [
          { id: "x", label: "X" },
          { id: "y", label: "Y" },
        ],
        closesAtMs: 0,
      },
      aud,
      rng,
    );
    expect(vote.total).toBe(50);
    expect((vote.tallies["x"] ?? 0) + (vote.tallies["y"] ?? 0)).toBe(50);
    const dial = pollResult({ pollId: "d", kind: "dial", prompt: "", closesAtMs: 0 }, aud, rng);
    expect(Object.values(dial.tallies).reduce((a, b) => a + b, 0)).toBe(50);
    expect(Object.keys(dial.tallies).every((k) => Number(k) >= 0 && Number(k) < 50)).toBe(true);
    expect(dial.mean).toBeGreaterThan(0);
    const guess = pollResult(
      { pollId: "g", kind: "guess", prompt: "", closesAtMs: 0, accept: ["cat"] },
      aud,
      rng,
    );
    expect(guess.firstCorrect?.length).toBeLessThanOrEqual(3);
    expect(guess.tallies["correct"]).toBeGreaterThan(0);
    const tap = pollResult({ pollId: "t", kind: "tap", prompt: "", closesAtMs: 0 }, aud, rng);
    expect(tap.tallies["taps"]).toBeGreaterThanOrEqual(250);
  });

  it("closes deadline polls at closesAtMs and delivers results to the game", () => {
    const sim = simulateGame(tictactoe, { seed: 5, players: 2 });
    expect(sim.polls).toBeGreaterThanOrEqual(5);
    const chat = sim.timeline.filter((e) => e.kind === "audience" && e.id.startsWith("chat-"));
    expect(chat.length).toBeGreaterThan(3);
    // Every early close is held for the minimum window: 3 s delay + 5 s.
    for (const e of chat) expect(e.endMs - e.startMs).toBeGreaterThanOrEqual(8_000);
  });

  it("drives enrolment and direct audience actions, and counts both as audience interaction", () => {
    const sim = simulateGame(rallyLite, {
      seed: 1,
      players: 1,
      audienceDirectOpen: (s) => s.phase === "race",
      audienceAction: (_s, _aud, rng) => ({ nudge: rng.int(3) }),
    });
    expect(sim.ended).toBe(true);
    expect(sim.finalState.entrants).toBe(10);
    expect(sim.finalState.nudges).toBeGreaterThan(20);
    const kinds = sim.timeline
      .filter((e) => e.kind === "audience")
      .map((e) => e.kind === "audience" && e.what);
    expect(kinds).toContain("enroll");
    expect(kinds).toContain("direct");
    expect(sim.audienceIdleMaxMs).toBeLessThan(2_000);
  });

  it("counts a reveal involving a player's content against player idle", () => {
    const without = simulateGame(slowThink, { seed: 1, players: 2 });
    const withReveal = simulateGame(slowThink, {
      seed: 1,
      players: 2,
      involves: (s) => s.phase === "think",
    });
    expect(withReveal.playerIdleMaxMs).toBeLessThan(without.playerIdleMaxMs);
    expect(withReveal.timeline.some((e) => e.kind === "involved")).toBe(true);
  });
});

describe("pacing report", () => {
  it("outputs { durationMs, audienceIdleMaxMs, playerIdleMaxMs, timeline } per game", () => {
    const sim = simulateGame(tictactoe, { seed: 1, players: 2 });
    expect(sim.durationMs).toBeGreaterThan(0);
    expect(sim.audienceIdleMaxMs).toBeGreaterThanOrEqual(0);
    expect(sim.playerIdleMaxMs).toBeGreaterThanOrEqual(0);
    expect(sim.timeline.some((e) => e.kind === "phase" && e.phase === "turn")).toBe(true);
  });

  it("tictactoe passes G14 over 50 seeds at every player count", () => {
    const report = pacingReport(tictactoe, { seeds: 50 });
    expect(report.games).toHaveLength(50);
    expect(report.groups).toHaveLength(1);
    const verdict = checkPacing(report);
    expect(verdict.failures).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(report.audienceIdleMaxMs).toBeLessThanOrEqual(30_000);
    expect(report.timeline.length).toBeGreaterThan(0);
  });

  it("EXPECTED FAIL: a 60 s phase with no audience interaction fails the audience-idle check", () => {
    const report = pacingReport(slowThink, { seeds: 10, players: [2] });
    const verdict = checkPacing(report);
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.audienceIdle).toBe(false);
    expect(report.audienceIdleMaxMs).toBeGreaterThanOrEqual(THINK_MS);
    expect(verdict.failures.join("\n")).toMatch(/audience idle gap 6\d\.\d s exceeds 30 s/);
  });

  it("flags durations outside estMinutes and unfinished games", () => {
    const report = pacingReport(tictactoe, { seeds: 5 });
    const tooLong = checkPacing(report, { estMinutes: [10, 12] });
    expect(tooLong.checks.duration).toBe(false);
    expect(tooLong.failures[0]).toMatch(/median .* outside 10-12 min/);
    const tooShort = checkPacing(report, { estMinutes: [0.1, 0.5] });
    expect(tooShort.failures.join()).toMatch(/p90/);
    expect(checkPacing(report, { estMinutes: [10, 12], skipDuration: true }).ok).toBe(true);
    const stuck = pacingReport(makeProbe(), { seeds: 2, players: [1] });
    const verdict = checkPacing(stuck, { skipDuration: true });
    expect(verdict.checks.ended).toBe(false);
    expect(verdict.failures[0]).toMatch(/did not end: stalled/);
  });

  it("helpers: longestGap, quantile, seeds, player counts", () => {
    expect(longestGap([], 100)).toBe(100);
    expect(
      longestGap(
        [
          { start: 10, end: 20 },
          { start: 15, end: 40 },
          { start: 70, end: 90 },
        ],
        100,
      ),
    ).toBe(30);
    expect(longestGap([{ start: 0, end: 100 }], 100)).toBe(0);
    expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(quantile([], 0.5)).toBe(0);
    expect(seedList(3)).toEqual([1, 2, 3]);
    expect(seedList([7, 9])).toEqual([7, 9]);
    expect(defaultPlayerCounts({ minPlayers: 3, maxPlayers: 8 })).toEqual([3, 6, 8]);
    expect(defaultPlayerCounts({ minPlayers: 2, maxPlayers: 2 })).toEqual([2]);
  });
});

// ---- a tiny enrol + direct-action fixture ------------------------------------------------------

interface RallyState {
  phase: "enroll" | "race" | "final";
  deadline: number | null;
  entrants: number;
  nudges: number;
  players: PlayerId[];
}

const rallyLite: GameModule<RallyState, never, Record<string, never>, RallyState> = {
  manifest: {
    ...tictactoe.manifest,
    id: "rally-lite" as typeof tictactoe.manifest.id,
    minPlayers: 1,
    maxPlayers: 2,
    audience: { direct: true },
  },
  optionSpecs: [],
  parseAction: () => null,
  setup(ctx: SetupContext<Record<string, never>>): Step<RallyState> {
    return {
      state: {
        phase: "enroll",
        deadline: null,
        entrants: 0,
        nudges: 0,
        players: ctx.players.map((p) => p.id),
      },
      effects: [{ type: "audience.enroll", open: true, closesAtMs: ctx.now + 5_000, cap: 10 }],
    };
  },
  onAction: (s) => ({ state: s }),
  onAudienceEnroll(s, entrants, ctx: Ctx) {
    return {
      state: { ...s, phase: "race", entrants: entrants.length },
      effects: [{ type: "timer.set", id: "finish", atMs: ctx.now + 20_000 }],
    };
  },
  onAudienceAction(s) {
    return { state: { ...s, nudges: s.nudges + 1 } };
  },
  onTimer(s) {
    return {
      state: { ...s, phase: "final" },
      effects: [
        { type: "end", result: { ranking: s.players.map((id) => ({ id, score: 0, place: 1 })) } },
      ],
    };
  },
  view: (s) => s,
  legalActions: () => [],
  bot: () => null,
  serialize: (s) => JSON.stringify(s),
  deserialize: (d) => JSON.parse(d) as RallyState,
};

// ---- two back-to-back input windows ------------------------------------------------------------

interface TwoState {
  phase: "a" | "b" | "done";
  deadline: number | null;
  actedIn: string | null;
  players: PlayerId[];
}

const twoWindows: GameModule<TwoState, { type: "go" }, Record<string, never>, TwoState> = {
  manifest: { ...tictactoe.manifest, id: "two" as typeof tictactoe.manifest.id, minPlayers: 1 },
  optionSpecs: [],
  parseAction: (raw) =>
    typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "go"
      ? { type: "go" }
      : null,
  setup: (ctx) => ({
    state: {
      phase: "a",
      deadline: ctx.now + 60_000,
      actedIn: null,
      players: ctx.players.map((p) => p.id),
    },
    effects: [{ type: "timer.set", id: "a", atMs: ctx.now + 2_000 }],
  }),
  onAction: (s) => (s.phase === "done" ? { state: s } : { state: { ...s, actedIn: s.phase } }),
  onTimer: (s, id, ctx) =>
    id === "a"
      ? {
          state: { ...s, phase: "b", deadline: ctx.now + 10_000 },
          effects: [{ type: "timer.set", id: "b", atMs: ctx.now + 10_000 }],
        }
      : {
          state: { ...s, phase: "done", deadline: null },
          effects: [
            {
              type: "end",
              result: { ranking: s.players.map((id) => ({ id, score: 0, place: 1 })) },
            },
          ],
        },
  view: (s) => s,
  legalActions: (s) => (s.phase !== "done" && s.actedIn === null ? [{ type: "go" }] : []),
  bot: (s) => (s.phase !== "done" && s.actedIn === null ? { type: "go" } : null),
  serialize: (s) => JSON.stringify(s),
  deserialize: (d) => JSON.parse(d) as TwoState,
};
