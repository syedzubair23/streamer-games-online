/**
 * Pure pieces of the AudienceAggregator (ROADMAP M1-03): Seeds and pari-mutuel settlement,
 * the leaderboard, reaction batching, and each poll kind's scoring helpers.
 */
import { describe, expect, it } from "vitest";
import {
  bandPoints,
  createPoll,
  dialBin,
  guessPoints,
  impliedOdds,
  Leaderboard,
  parimutuel,
  ReactionAggregator,
  SeedLedger,
  SEEDS_FLOOR,
  SEEDS_START,
  speedBonus,
  type PollEnv,
  type Stake,
} from "../../src/index.ts";
import { FakeClock } from "../fake-clock.ts";

describe("seeds", () => {
  it("pari-mutuel splits the pool among winners in proportion to their stakes", () => {
    const stakes = new Map<string, Stake>([
      ["a", { option: "x", amount: 100 }],
      ["b", { option: "x", amount: 300 }],
      ["c", { option: "y", amount: 100 }],
      ["d", { option: "y", amount: 100 }],
      ["e", { option: "z", amount: 100 }],
    ]);
    // Pool 700, winning pool 400.
    const d = parimutuel(stakes, "x");
    expect(d.get("a")).toBe(Math.floor((100 * 700) / 400) - 100); // +75
    expect(d.get("b")).toBe(Math.floor((300 * 700) / 400) - 300); // +225
    expect(d.get("c")).toBe(-100);
    // Nothing is created: winnings never exceed the losing stakes.
    const sum = [...d.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(0);
    // Cancelled or nobody on the winner: refunds.
    expect([...parimutuel(stakes, null).values()]).toEqual([0, 0, 0, 0, 0]);
    expect([...parimutuel(stakes, "w").values()]).toEqual([0, 0, 0, 0, 0]);
  });

  it("the ledger starts at 1000 and never drops below 100", () => {
    const l = new SeedLedger();
    expect(l.balance("a")).toBe(SEEDS_START);
    expect(l.apply("a", -5_000)).toBe(SEEDS_FLOOR);
    expect(l.won("a")).toBe(SEEDS_FLOOR - SEEDS_START);
    expect(l.apply("a", 250.9)).toBe(350);
    expect([...l.ids()]).toEqual(["a"]);
  });

  it("implied odds are pool over option pool", () => {
    expect(impliedOdds({ a: 1, b: 3, c: 0 })).toEqual({ a: 4, b: 4 / 3, c: null });
  });
});

describe("leaderboard", () => {
  it("ranks by points plus Seeds won with shared places and a stable tie-break", () => {
    const lb = new Leaderboard();
    lb.addPoints("a", 100, "Ann");
    lb.addPoints("b", 100, "Bob");
    lb.addPoints("c", 40);
    lb.addPoints("c", -10); // ignored
    lb.addPoints("c", Number.NaN); // ignored
    lb.seeds.apply("c", 200); // +200 Seeds won → score 240
    lb.seeds.apply("b", -300); // losses do not subtract
    expect(lb.rows().map((r) => [r.audId, r.score, r.place])).toEqual([
      ["c", 240, 1],
      ["a", 100, 2],
      ["b", 100, 2],
    ]);
    expect(lb.top(1)).toHaveLength(1);
    expect(lb.top(-1)).toEqual([]);
    expect(lb.rowOf("b")).toMatchObject({ name: "Bob", seeds: 700, place: 2 });
    expect(lb.rowOf("c")?.name).toBe("c");
    expect(lb.rowOf("zzz")).toBeNull();
  });
});

describe("reactions", () => {
  it("batches counts every 500 ms and sends nothing when idle", () => {
    const clock = new FakeClock();
    const out: { at: number; counts: Record<string, number> }[] = [];
    const r = new ReactionAggregator(clock, (counts) => out.push({ at: clock.now(), counts }));
    expect(r.add("nope")).toBe(false);
    const t0 = clock.now();
    r.add("heart");
    r.add("heart");
    r.add("sad");
    expect(r.pending).toBe(3);
    clock.advance(499);
    expect(out).toEqual([]);
    clock.advance(1);
    expect(out).toEqual([{ at: t0 + 500, counts: { heart: 2, sad: 1 } }]);
    clock.advance(5_000);
    expect(out).toHaveLength(1);
    r.add("clap");
    r.dispose();
    clock.advance(1_000);
    expect(out).toHaveLength(1);
    expect(clock.pending).toBe(0);
  });
});

describe("poll kinds", () => {
  const env = (now = 0): PollEnv => ({ now, leaderboard: new Leaderboard(), predictStake: 100 });
  const voter = { audId: "a1", name: "A", teamId: "t1" };

  it("dial bins, bands, speed bonus and guess points", () => {
    expect([0, 20, 21, 500, 1000].map(dialBin)).toEqual([0, 0, 1, 24, 49]);
    const bands = [
      { within: 100, points: 10 },
      { within: 10, points: 50 },
    ];
    expect(bandPoints(505, 500, bands)).toBe(50);
    expect(bandPoints(590, 500, bands)).toBe(10);
    expect(bandPoints(700, 500, bands)).toBe(0);
    expect(speedBonus(0, 0, 10_000)).toBe(50);
    expect(speedBonus(10_000, 0, 10_000)).toBe(0);
    expect(speedBonus(20_000, 0, 10_000)).toBe(0);
    expect(speedBonus(5, 10, 10)).toBe(0);
    expect([0, 1, 7, 8, 30].map(guessPoints)).toEqual([100, 90, 30, 20, 20]);
  });

  it("each kind rejects the wrong input shape", () => {
    const opts = [{ id: "a", label: "A" }];
    const base = { prompt: "?", closesAtMs: 1_000, options: opts };
    for (const kind of ["vote", "predict", "quiz"] as const) {
      const p = createPoll({ ...base, pollId: kind, kind }, 0);
      expect(p.vote(voter, 3, env()).ok).toBe(false);
      expect(p.tap(voter, 1, env()).ok).toBe(false);
      expect(p.vote(voter, "a", env()).ok).toBe(true);
    }
    const dial = createPoll({ ...base, pollId: "d", kind: "dial" }, 0);
    expect(dial.vote(voter, "500", env()).ok).toBe(false);
    expect(dial.vote(voter, -1, env()).ok).toBe(false);
    const guess = createPoll({ ...base, pollId: "g", kind: "guess" }, 0);
    expect(guess.vote(voter, 5, env()).ok).toBe(false);
    expect(guess.vote(voter, "", env()).ok).toBe(false);
    // No accept list at all: every guess is wrong, never correct.
    expect(guess.vote(voter, "anything", env())).toMatchObject({ ok: true, changed: true });
    expect(guess.vote(voter, "again", env(2_000))).toMatchObject({ ok: true, changed: false });
    expect(guess.result().tallies).toEqual({ correct: 0 });
    const tap = createPoll({ ...base, pollId: "t", kind: "tap", teamSplit: true }, 0);
    expect(tap.vote(voter, "a", env()).ok).toBe(false);
    expect(tap.tap(voter, 0, env()).ok).toBe(false);
    expect(tap.tap(voter, 2.5, env()).ok).toBe(false);
    expect(tap.tap(voter, 3, env()).ok).toBe(true);
    expect(tap.result().byTeam).toEqual({ t1: { taps: 3 } });
    expect(tap.closedPublic().tallies).toEqual({ taps: 3 });
  });

  it("resolve is idempotent and tolerates missing or invalid answers", () => {
    const opts = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ];
    const base = { prompt: "?", closesAtMs: 1_000, options: opts };
    const e = env();
    const quiz = createPoll({ ...base, pollId: "q", kind: "quiz" }, 0);
    quiz.vote(voter, "a", e);
    expect(quiz.resolve({ type: "audience.resolve", pollId: "q" }, e).result.tallies).toEqual({});
    expect(quiz.resolve({ type: "audience.resolve", pollId: "q", correct: "zz" }, e).you.size).toBe(
      0,
    );
    expect(
      quiz.resolve({ type: "audience.resolve", pollId: "q", correct: "a" }, e).you.get("a1"),
    ).toEqual({
      correct: true,
      points: 100, // no speedBonus flag
    });
    expect(quiz.resolve({ type: "audience.resolve", pollId: "q", correct: "a" }, e).you.size).toBe(
      0,
    );
    expect(e.leaderboard.points("a1")).toBe(100);

    const dial = createPoll({ ...base, pollId: "d", kind: "dial" }, 0);
    dial.vote(voter, 10, e);
    expect(dial.resolve({ type: "audience.resolve", pollId: "d" }, e).you.size).toBe(0);
    expect(
      dial.resolve({ type: "audience.resolve", pollId: "d", target: 10 }, e).you.get("a1"),
    ).toEqual({
      correct: false,
      points: 0, // no bands
    });
    expect(dial.resolve({ type: "audience.resolve", pollId: "d", target: 10 }, e).you.size).toBe(0);

    const predict = createPoll({ ...base, pollId: "p", kind: "predict" }, 0);
    predict.vote(voter, "b", e);
    const cancelled = predict.resolve(
      { type: "audience.resolve", pollId: "p", correct: "nope" },
      e,
    );
    expect(cancelled.result.correct).toBeUndefined();
    expect(cancelled.you.get("a1")).toEqual({ seeds: SEEDS_START });

    const vote = createPoll({ ...base, pollId: "v", kind: "vote" }, 0);
    vote.vote(voter, "a", e);
    expect(vote.onClose(e).size).toBe(0);
    expect(
      vote.resolve({ type: "audience.resolve", pollId: "v", correct: "a" }, e).result,
    ).toMatchObject({
      correct: "a",
      tallies: { a: 1, b: 0 },
    });
    expect(
      vote.resolve({ type: "audience.resolve", pollId: "v" }, e).result.correct,
    ).toBeUndefined();

    const guess = createPoll(
      { ...base, pollId: "g", kind: "guess", accept: ["yes"], teamSplit: true },
      0,
    );
    guess.vote(voter, "yes", e);
    expect(guess.vote(voter, "yes", env(5_000))).toEqual({ ok: false, reason: "locked" });
    expect(guess.result().byTeam).toEqual({ t1: { correct: 1 } });
    expect(guess.onClose(e).get("a1")).toEqual({ correct: true, points: 100 });
    expect(guess.onClose(e).size).toBe(0);
  });
});
