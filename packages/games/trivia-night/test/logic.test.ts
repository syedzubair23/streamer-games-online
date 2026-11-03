/**
 * DOD G3 rule tests for Trivia Night, Classic mode (ROADMAP M4-01): every Classic rule (R1–R8,
 * R14 `classic`) and test case (T1–T5, T9, T10, T12, T13) of `docs/specs/trivia-night.md` has a
 * test named with its number. Bluff mode (R9–R13, T6–T8, T11) is ROADMAP M4-01b.
 *
 * Tests drive the real module on a `GameRunner` through the scenarios' `TableDriver` (virtual
 * clock, stream delay 3 s) unless they check a pure rule function directly.
 */
import {
  TriviaMcItemSchema,
  TRIVIA_OPTION_MAX,
  TRIVIA_QUESTION_MAX,
  createRng,
  type PlayerId,
} from "@sg/shared";
import {
  EMPTY_CONTENT,
  createTiming,
  defaultOptions,
  resolveScenario,
  type PollResult,
  type SetupContext,
} from "@sg/engine";
import { fakeContent, markAllUsed, simulateGame } from "@sg/engine/testing";
import { describe, expect, it } from "vitest";
import {
  AUDIENCE_MIN,
  BOT_ACCURACY,
  CATEGORY_MS,
  COOL_HEAD_POINTS,
  FALLBACK_QUESTIONS,
  LIFELINE_MS,
  READ_BASE_MS,
  READ_MAX_MS,
  READ_PER_CHAR_MS,
  REVEAL_MS,
  SCOREBOARD_MS,
  SHOWDOWN_PREDICT_MS,
  botAction,
  botChoice,
  bottomTwo,
  canAnswer,
  clamp01,
  daysFromCivil,
  drawQuestions,
  finalRanking,
  involves,
  isExpired,
  lifelineRecipient,
  manifest,
  optionSpecs,
  parseAction,
  percentages,
  pluralityAnswer,
  rankEntries,
  readMs,
  scoreAnswer,
  showdownVerdict,
  speedBonus,
  streakBonus,
  takeBest,
  targetDifficulty,
  teamTotals,
  triviaNight,
  viewFor,
  type McItem,
  type TnOptions,
} from "../src/logic/index.ts";
import {
  scenarioSeats,
  scenarios,
  TableDriver,
  type Answer,
  type TableOptions,
} from "../src/scenarios.ts";
import { CATEGORIES, GENERAL_PACK, fixtureItems, testContent } from "./fixtures.ts";
import { actx, ctxAt, effectsOf, fxNames, secrecyProblems } from "./helpers.ts";

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

type TableInit = Partial<Omit<TableOptions, "players">> & { players: TableOptions["players"] };

function table(init: TableInit): TableDriver {
  return new TableDriver({ seed: 1, content: testContent(), ...init });
}

/**
 * Plays scripted questions (and Showdowns: the lower player right, the other wrong) until the
 * reveal of question `upTo` has been left, or the game reached `final`.
 */
function playAll(
  d: TableDriver,
  upTo: number,
  plan: (i: number) => Record<PlayerId, Answer>,
): void {
  for (let guard = 0; guard < 200; guard++) {
    const { phase, lastReveal } = d.state;
    if (phase === "final") return;
    if ((lastReveal?.index ?? 0) >= upTo && phase !== "reveal") return;
    if (phase === "category") d.playQuestion(plan(d.state.index + 1));
    else if (d.state.phase === "showdown") {
      d.toDeadline();
      const [a, b] = d.state.showdown?.players ?? [];
      if (a !== undefined) d.act(a, { type: "answer", choice: d.choiceFor("right") }, 1000);
      if (b !== undefined && (d.state.phase as string) === "showdown-answer") {
        d.act(b, { type: "answer", choice: d.choiceFor("wrong") }, 1000);
      }
    } else d.step();
  }
}

const all = (ids: readonly string[], a: Answer): Record<PlayerId, Answer> =>
  Object.fromEntries(ids.map((id) => [id, a]));

/** Whether the runner holds an early close of `pollId` (SPEC §4 minimum audience window). */
const closing = (d: TableDriver, pollId: string | null): boolean =>
  d.runner.openPolls().some((p) => p.spec.pollId === pollId && p.closing);

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i + 1}`);

function setupCtx(
  options: Partial<TnOptions>,
  extra: Partial<SetupContext<TnOptions>> = {},
): SetupContext<TnOptions> {
  return {
    players: scenarioSeats(4),
    teams: [],
    options: { ...(defaultOptions(optionSpecs) as unknown as TnOptions), ...options },
    rng: createRng(3),
    now: 1_000_000,
    timing: createTiming({ timerScale: 1, streamDelaySec: 3 }),
    content: testContent(),
    audienceCount: 50,
    ...extra,
  };
}

const item = (over: Partial<McItem> & { id: string }): McItem => ({
  q: `Question ${over.id}?`,
  options: ["a1", "b2", "c3", "d4"],
  correct: 0,
  category: "General",
  difficulty: 1,
  source: "https://example.com/q",
  ...over,
});

// ---------------------------------------------------------------------------------------------
// Manifest, options, content
// ---------------------------------------------------------------------------------------------

describe("manifest and options", () => {
  it("R14: the manifest follows the spec header and the mode option plays classic", () => {
    expect(manifest).toMatchObject({
      id: "trivia-night",
      minPlayers: 1,
      maxPlayers: 10,
      tickHz: 0,
      renderMode: "on-demand",
      teamSupport: "optional",
      audience: { quiz: true, predict: true, vote: true },
      estMinutes: [8, 15],
      howToPlay: [
        "Answer on your phone. Faster = more points",
        "Bottom two face The Kettle showdown",
        "Chat plays along on its own leaderboard",
      ],
    });
    for (const step of manifest.howToPlay) expect(step.length).toBeLessThanOrEqual(60);
    const defaults = defaultOptions(optionSpecs);
    expect(defaults).toEqual({
      mode: "classic",
      packs: ["trivia-general"],
      questions: 12,
      answerSec: 20,
      speedScoring: true,
      showdown: true,
      lifeline: true,
      difficulty: "curve",
    });
    const byKey = Object.fromEntries(optionSpecs.map((o) => [o.key, o]));
    expect(byKey["questions"]).toMatchObject({ kind: "int", min: 6, max: 20 });
    expect(byKey["answerSec"]).toMatchObject({ kind: "seconds", min: 10, max: 40 });
    expect(byKey["packs"]).toMatchObject({ kind: "pack", packKind: "trivia-mc", multi: true });
    const d = table({ players: 3 });
    expect(d.state.mode).toBe("classic");
    expect(viewFor(d.state, { role: "stage" }).mode).toBe("classic");
  });

  it("built-in questions satisfy the trivia-mc schema and the question-writing rules", () => {
    expect(FALLBACK_QUESTIONS).toHaveLength(48);
    const ids = new Set<string>();
    for (const q of FALLBACK_QUESTIONS) {
      expect(TriviaMcItemSchema.safeParse(q).success, q.id).toBe(true);
      expect(q.q.length).toBeLessThanOrEqual(TRIVIA_QUESTION_MAX);
      for (const o of q.options) expect(o.length).toBeLessThanOrEqual(TRIVIA_OPTION_MAX);
      expect(q.q).not.toMatch(/\bnot\b/i);
      ids.add(q.id);
    }
    expect(ids.size).toBe(48);
    for (const c of CATEGORIES) {
      for (const diff of [1, 2, 3]) {
        expect(
          FALLBACK_QUESTIONS.filter((q) => q.category === c && q.difficulty === diff),
        ).toHaveLength(2);
      }
    }
  });

  it("test fixture strings never contain one another (secrecy fuzz precondition)", () => {
    const items = [...fixtureItems("g", 6), ...fixtureItems("s", 2)];
    const strings = items.flatMap((i) => [i.id, i.q, ...i.options, i.source]);
    const unique = [...new Set(strings)];
    expect(unique).toHaveLength(strings.length);
    const clashes: string[] = [];
    for (const a of unique) {
      for (const b of unique) if (a !== b && b.includes(a)) clashes.push(`${a} in ${b}`);
    }
    expect(clashes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// R1: the deal
// ---------------------------------------------------------------------------------------------

describe("R1 deal", () => {
  it("R1: a game has `questions` questions, 12 by default", () => {
    expect(table({ players: 2 }).state.total).toBe(12);
    expect(table({ players: 2, options: { questions: 6 } }).state.total).toBe(6);
    expect(table({ players: 2, options: { questions: 20 } }).state.total).toBe(20);
    expect(table({ players: 2, options: { questions: 99 } }).state.total).toBe(20);
  });

  it("R1: the difficulty curve: first third easy, middle medium, last third hard", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const q = table({ players: 3, seed }).state.hidden.queue;
      expect(q.map((x) => x.difficulty)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
    }
    expect(targetDifficulty(0, 7, "curve")).toBe(1);
    expect(targetDifficulty(3, 7, "curve")).toBe(2);
    expect(targetDifficulty(6, 7, "curve")).toBe(3);
    const easy = table({ players: 3, options: { difficulty: "easy" } }).state.hidden.queue;
    expect(easy.every((x) => x.difficulty === 1)).toBe(true);
    const hard = table({ players: 3, options: { difficulty: "hard" } }).state.hidden.queue;
    expect(hard.every((x) => x.difficulty === 3)).toBe(true);
  });

  it("R1: questions come only from the selected packs", () => {
    const general = table({ players: 2 }).state.hidden.queue;
    expect(general.every((x) => x.id.startsWith("fx-g"))).toBe(true);
    const science = table({ players: 2, options: { packs: ["trivia-science"] } }).state.hidden
      .queue;
    expect(science.every((x) => x.id.startsWith("fx-s"))).toBe(true);
  });

  it("R1: the nearest difficulty fills a slot when the target runs out, in another category", () => {
    const pool = [
      item({ id: "a", difficulty: 3, category: "X" }),
      item({ id: "b", difficulty: 2, category: "X" }),
      item({ id: "c", difficulty: 1, category: "Y" }),
    ];
    expect(takeBest(pool, 1, ["Y"])?.id).toBe("b");
    expect(takeBest(pool, 1, ["X"])?.id).toBe("c");
    expect(takeBest(pool, 1, ["X"])?.id).toBe("a");
    expect(takeBest(pool, 1, [])).toBeUndefined();
  });

  it("R1: built-in questions top up short packs; used items are reused only as a last resort", () => {
    const tiny = fakeContent([
      { ...GENERAL_PACK, items: fixtureItems("g", 1).slice(0, 5) } as typeof GENERAL_PACK,
    ]);
    const draw = drawQuestions({
      content: tiny,
      packs: ["trivia-general"],
      count: 12,
      difficulty: "curve",
      showdowns: 2,
      rng: createRng(5),
      now: 0,
    });
    expect(draw.queue).toHaveLength(12);
    expect(draw.queue.filter((q) => q.id.startsWith("fb-")).length).toBeGreaterThanOrEqual(7);
    expect(draw.showdown).toHaveLength(2);
    expect(draw.spares).toHaveLength(3);
    // Every item already used: the game still gets a full deal (from used items).
    const content = testContent();
    markAllUsed(content, "trivia-mc", [...fixtureItems("g", 6), ...FALLBACK_QUESTIONS]);
    const reused = drawQuestions({
      content,
      packs: ["trivia-general"],
      count: 12,
      difficulty: "curve",
      showdowns: 0,
      rng: createRng(5),
      now: 0,
    });
    expect(reused.queue).toHaveLength(12);
    // An empty library still plays the built-in questions (client scenarios, missing packs).
    const bare = table({ players: 2, content: EMPTY_CONTENT }).state.hidden.queue;
    expect(bare).toHaveLength(12);
    expect(bare.every((q) => q.id.startsWith("fb-"))).toBe(true);
  });

  it("R1 edge case: a question whose validUntil has passed is skipped at setup", () => {
    const day = 86_400_000;
    const now = daysFromCivil(2030, 6, 15) * day + 1000;
    const expired = item({ id: "old", validUntil: "2030-06-14" });
    const today = item({ id: "today", validUntil: "2030-06-15" });
    const future = item({ id: "new", validUntil: "2031-01-01" });
    expect(isExpired(expired.validUntil, now)).toBe(true);
    expect(isExpired(today.validUntil, now)).toBe(false);
    expect(isExpired(future.validUntil, now)).toBe(false);
    expect(isExpired(undefined, now)).toBe(false);
    expect(isExpired("15/06/2030", now)).toBe(true);
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(daysFromCivil(2000, 3, 1)).toBe(11_017);
    const pack = {
      ...GENERAL_PACK,
      items: [expired, today, future, ...fixtureItems("g", 2)],
    } as typeof GENERAL_PACK;
    const content = fakeContent([pack]);
    for (let seed = 1; seed <= 10; seed++) {
      const draw = drawQuestions({
        content,
        packs: ["trivia-general"],
        count: 20,
        difficulty: "curve",
        showdowns: 2,
        rng: createRng(seed),
        now,
      });
      const all = [...draw.queue, ...draw.showdown, ...draw.spares].map((q) => q.id);
      expect(all).not.toContain("old");
    }
  });
});

describe("T10 no repeats, no back-to-back categories", () => {
  it("T10: no question repeats within a session given the used set, and categories alternate", () => {
    const content = testContent();
    const seen = new Set<string>();
    // Five games in one room session: each marks what it played as used.
    for (let game = 0; game < 5; game++) {
      const d = new TableDriver({ seed: 100 + game, players: 4, content });
      const deal = [...d.state.hidden.queue];
      for (const q of deal) {
        expect(seen.has(q.id), `game ${game} repeats ${q.id}`).toBe(false);
        seen.add(q.id);
      }
      for (let i = 1; i < deal.length; i++) {
        expect(deal[i]?.category, `game ${game} Q${i + 1}`).not.toBe(deal[i - 1]?.category);
      }
      for (const q of deal) content.markUsed("trivia-mc", q.id);
    }
    // Fuzz: categories never repeat back to back across seeds and presets.
    for (let seed = 1; seed <= 60; seed++) {
      const q = table({ players: 2, seed, options: { questions: 6 + (seed % 15) } }).state.hidden
        .queue;
      for (let i = 1; i < q.length; i++) expect(q[i]?.category).not.toBe(q[i - 1]?.category);
    }
  });

  it("T10: played question ids are the only pack ids left in the final state", () => {
    const d = table({ players: 3 }).skipIntro();
    playAll(d, 12, (i) => all(ids(3), i % 2 === 0 ? "right" : "wrong"));
    d.toPhase("final");
    expect(d.state.hidden.queue).toEqual([]);
    expect(d.state.hidden.spares).toEqual([]);
    expect(d.state.hidden.showdownQueue).toEqual([]);
    expect(d.state.played).toHaveLength(12);
    expect(new Set(d.state.played.map((p) => p.id)).size).toBe(12);
  });
});

// ---------------------------------------------------------------------------------------------
// R2: phases
// ---------------------------------------------------------------------------------------------

describe("R2 question phases", () => {
  it("R2: category (1800) → read (2500 + 40/char, max 6000) → answer (input 20 s) → reveal (4000)", () => {
    const d = table({ players: 2 });
    expect(d.state.phase).toBe("intro");
    d.skipIntro();
    expect(d.state.phase).toBe("category");
    expect(d.state.index).toBe(1);
    expect(d.state.deadline).toBe(d.now + CATEGORY_MS);
    const stage = () => d.runner.view({ role: "stage" });
    expect(stage().category).toBe(d.state.current?.category);
    expect(stage().q).toBeNull();
    expect(stage().options).toBeNull();
    d.toDeadline();
    expect(d.state.phase).toBe("read");
    const q = d.state.current?.q ?? "";
    expect(d.state.deadline).toBe(
      d.now + Math.min(READ_MAX_MS, READ_BASE_MS + READ_PER_CHAR_MS * q.length),
    );
    expect(stage().q).toBe(q);
    expect(stage().options).toBeNull();
    d.toDeadline();
    expect(d.state.phase).toBe("answer");
    expect(d.state.deadline).toBe(d.now + 20_000 + 3_000);
    expect(stage().options).toEqual(d.state.hidden.item?.options);
    const open = effectsOf(d.last, "audience.open")[0];
    expect(open?.poll).toMatchObject({
      kind: "quiz",
      closesAtMs: d.state.deadline,
      speedBonus: true,
      options: [0, 1, 2, 3].map((i) => ({ id: String(i), label: d.state.hidden.item?.options[i] })),
    });
    const quizId = d.state.polls.quiz;
    d.answers({ p1: "right", p2: "wrong" }).quiz(100, 50);
    expect(d.state.phase).toBe("reveal");
    expect(d.state.deadline).toBe(d.now + REVEAL_MS);
    // The early close (and the resolve behind it) waits out the minimum audience window.
    d.wait(5_000);
    expect(effectsOf(d.log, "audience.resolve").find((e) => e.pollId === quizId)).toMatchObject({
      correct: String(d.state.lastReveal?.correct),
    });
    expect(readMs("x".repeat(200), READ_BASE_MS, READ_PER_CHAR_MS, READ_MAX_MS)).toBe(READ_MAX_MS);
    expect(readMs("abcd", READ_BASE_MS, READ_PER_CHAR_MS, READ_MAX_MS)).toBe(2_660);
  });

  it("R2: the answer window scales with answerSec and timerScale and carries the stream delay", () => {
    const d = table({ players: 1, options: { answerSec: 30 }, timerScale: 1.5, streamDelaySec: 5 });
    d.skipIntro().toAnswer();
    expect(d.state.deadline).toBe(d.now + 45_000 + 5_000);
    expect(d.state.answerWindow).toEqual({ windowMs: 45_000, delayMs: 5_000 });
  });
});

// ---------------------------------------------------------------------------------------------
// R3: answering
// ---------------------------------------------------------------------------------------------

describe("R3 answering", () => {
  it("R3: each player locks one of 4 options and the first submission is final", () => {
    const d = table({ players: 2 }).skipIntro().toAnswer();
    d.act("p1", { type: "answer", choice: 2 });
    expect(d.state.hidden.answers["p1"]?.choice).toBe(2);
    expect(d.state.answered).toEqual(["p1"]);
    expect(() => d.act("p1", { type: "answer", choice: 3 })).toThrow(/ILLEGAL/);
    expect(d.state.hidden.answers["p1"]?.choice).toBe(2);
    expect(triviaNight.legalActions(d.state, "p1")).toEqual([]);
    expect(triviaNight.legalActions(d.state, "p2")).toHaveLength(4);
  });

  it("R3: the phase ends early once every connected player has answered", () => {
    const d = table({ players: 3 }).skipIntro().toAnswer();
    d.act("p1", { type: "answer", choice: 0 });
    d.runner.playerLeave("p3", d.now);
    expect(d.state.answerClosed).toBe(false);
    d.act("p2", { type: "answer", choice: 1 });
    expect(d.state.answerClosed).toBe(true);
    expect(d.state.deadline).toBeNull();
    expect(closing(d, d.state.polls.quiz)).toBe(true);
    // A disconnect that leaves only answered players ends it too.
    const e = table({ players: 3 }).skipIntro().toAnswer();
    e.act("p1", { type: "answer", choice: 0 }).act("p2", { type: "answer", choice: 0 });
    e.runner.playerLeave("p3", e.now);
    expect(e.state.answerClosed).toBe(true);
    // Nobody connected at all: the window runs to its deadline.
    const f = table({ players: 1 }).skipIntro().toAnswer();
    f.runner.playerLeave("p1", f.now);
    expect(f.state.answerClosed).toBe(false);
    f.runner.playerRejoin("p1", f.now);
    expect(f.state.players[0]?.connected).toBe(true);
  });

  it("R3: the answer time is receivedAt − answerOpenedAt in server time", () => {
    const d = table({ players: 2 }).skipIntro().toAnswer();
    const opened = d.state.openedAt as number;
    d.act("p1", { type: "answer", choice: d.choiceFor("right") }, 3_210);
    d.act("p2", { type: "answer", choice: d.choiceFor("right") }, 1_000);
    d.quiz(10, 50);
    expect(d.state.hidden.answers["p1"]?.at).toBe(opened + 3_210);
    expect(d.state.lastReveal?.perPlayer["p1"]?.ms).toBe(3_210);
    expect(d.state.lastReveal?.perPlayer["p2"]?.ms).toBe(4_210);
  });

  it("R3 edge case: an answer after the deadline is rejected (the server time decides)", () => {
    const d = table({ players: 2 }).skipIntro().toAnswer();
    const state = d.state;
    const late = triviaNight.onAction(
      state,
      { type: "answer", choice: 1 },
      actx((state.deadline as number) + 1, "p1"),
    );
    expect(late.state).toBe(state);
    expect(fxNames(late.effects)).toEqual(["illegal"]);
    const onTime = triviaNight.onAction(
      state,
      { type: "answer", choice: 1 },
      actx(state.deadline as number, "p1"),
    );
    expect(onTime.state.hidden.answers["p1"]).toBeDefined();
    // Through the runner the deadline timer fires first, so the late lock is refused.
    d.wait(23_001);
    expect(d.runner.act("p1", { type: "answer", choice: 1 }, d.now).err).toBe("ILLEGAL");
  });

  it("R3: seats that may not act and non-players are refused without a state change", () => {
    const d = table({ players: 2 }).skipIntro();
    expect(d.runner.act("p1", { type: "answer", choice: 0 }, d.now).err).toBe("ILLEGAL");
    d.toAnswer();
    const s = d.state;
    for (const who of [actx(d.now, "p1", "host"), actx(d.now, "zz")]) {
      const r = triviaNight.onAction(s, { type: "answer", choice: 0 }, who);
      expect(r.state).toBe(s);
      expect(fxNames(r.effects)).toEqual(["illegal"]);
    }
    expect(canAnswer(s, "zz", null)).toBe(false);
  });

  it("R3: parseAction accepts exactly { type: 'answer', choice: 0..3 }", () => {
    expect(parseAction({ type: "answer", choice: 3 })).toEqual({ type: "answer", choice: 3 });
    for (const bad of [
      null,
      [],
      "answer",
      { type: "answer" },
      { type: "answer", choice: 4 },
      { type: "answer", choice: 1.5 },
      { type: "answer", choice: "1" },
      { type: "lie", text: "x" },
      { type: "pick", optionId: "a" },
    ]) {
      expect(parseAction(bad)).toBeNull();
    }
    const hostile = {
      get type(): string {
        throw new Error("boom");
      },
    };
    expect(parseAction(hostile)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// R4: scoring
// ---------------------------------------------------------------------------------------------

describe("R4 scoring", () => {
  it("T1: speed bonus math, stream-delay compensation and timerScale 1.5", () => {
    // timerScale 1, answerSec 20, stream delay 3 s: window 20 s.
    expect(speedBonus(0, 20_000, 3_000)).toBe(500);
    expect(speedBonus(3_000, 20_000, 3_000)).toBe(500);
    expect(speedBonus(13_000, 20_000, 3_000)).toBe(250);
    expect(speedBonus(23_000, 20_000, 3_000)).toBe(0);
    expect(speedBonus(30_000, 20_000, 3_000)).toBe(0);
    expect(speedBonus(3_001, 20_000, 3_000)).toBe(500);
    expect(speedBonus(3_021, 20_000, 3_000)).toBe(499);
    // timerScale 1.5: window 30 s.
    expect(speedBonus(18_000, 30_000, 3_000)).toBe(250);
    expect(speedBonus(10_500, 30_000, 3_000)).toBe(375);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    // Integrated at timerScale 1.5.
    const d = table({ players: 3, timerScale: 1.5, options: { answerSec: 20 } })
      .skipIntro()
      .toAnswer();
    expect(d.state.answerWindow).toEqual({ windowMs: 30_000, delayMs: 3_000 });
    d.act("p1", { type: "answer", choice: d.choiceFor("right") }, 2_000);
    d.act("p2", { type: "answer", choice: d.choiceFor("right") }, 16_000);
    d.toDeadline().quiz(20, 40);
    expect(d.state.lastReveal?.perPlayer["p1"]).toMatchObject({
      ok: true,
      points: 1_000,
      speed: 500,
    });
    expect(d.state.lastReveal?.perPlayer["p2"]).toMatchObject({
      ok: true,
      points: 750,
      speed: 250,
    });
    expect(d.state.lastReveal?.perPlayer["p3"]).toMatchObject({ ok: false, points: 0, ms: -1 });
  });

  it("R4: correct scores 500 plus the speed bonus; wrong or missing scores 0 and resets the streak", () => {
    expect(
      scoreAnswer({ correct: false, t: 0, window: null, streakBefore: 3, steamed: false }),
    ).toEqual({
      points: 0,
      speed: 0,
      streak: 0,
      streakAfter: 0,
      halved: false,
    });
    expect(
      scoreAnswer({
        correct: true,
        t: 0,
        window: { windowMs: 20_000, delayMs: 3_000 },
        streakBefore: 0,
        steamed: false,
      }),
    ).toMatchObject({ points: 1_000, streakAfter: 1 });
    const d = table({ players: 2, options: { speedScoring: false } }).skipIntro();
    d.playQuestion({ p1: "right", p2: "right" });
    d.playQuestion({ p1: "wrong", p2: "right" });
    d.playToReveal({ p1: "right", p2: null });
    expect(d.state.streaks).toEqual({ p1: 1, p2: 0 });
    expect(d.state.scores).toEqual({ p1: 1_000, p2: 1_100 });
    expect(d.state.lastReveal?.perPlayer["p2"]).toMatchObject({
      ok: false,
      points: 0,
      choice: null,
    });
    expect(effectsOf(d.last, "score")[0]?.deltas).toEqual({ p1: 500 });
  });

  it("T2: the streak bonus is +100 per consecutive correct answer beyond the first, capped at +300", () => {
    expect([1, 2, 3, 4, 5, 9].map(streakBonus)).toEqual([0, 100, 200, 300, 300, 300]);
    expect(streakBonus(0)).toBe(0);
    const d = table({ players: 1, options: { speedScoring: false } }).skipIntro();
    const points: number[] = [];
    for (let i = 0; i < 6; i++) {
      d.playToReveal({ p1: "right" });
      points.push(d.state.lastReveal?.perPlayer["p1"]?.points ?? -1);
      d.step();
      if (d.state.phase === "scoreboard") d.step();
    }
    expect(points).toEqual([500, 600, 700, 800, 800, 800]);
    expect(d.state.stats.bestStreak["p1"]).toBe(6);
  });

  it("T13: with timerScale 0 correct answers score a flat 500 and no speed bonus is computed", () => {
    const d = table({ players: 2, timerScale: 0 });
    expect(d.state.speedBonusOn).toBe(false);
    expect(d.runner.view({ role: "host" }).hostNote).toBe("Speed bonus off (no timer)");
    expect(d.runner.view({ role: "stage" }).hostNote).toBeNull();
    expect(d.runner.view({ role: "stage" }).speedBonus).toBe(false);
    expect(d.state.deadline).not.toBeNull(); // pacing still runs on its own
    d.skipIntro().toDeadline().toDeadline();
    expect(d.state.phase).toBe("answer");
    expect(d.state.deadline).toBeNull();
    expect(d.state.answerWindow).toBeNull();
    const poll = effectsOf(d.last, "audience.open")[0]?.poll;
    expect(poll).toMatchObject({ kind: "quiz", closeOn: "event", speedBonus: false });
    d.act("p1", { type: "answer", choice: d.choiceFor("right") }, 100);
    d.act("p2", { type: "answer", choice: d.choiceFor("right") }, 9_000);
    d.quiz(20, 50);
    expect(d.state.lastReveal?.perPlayer["p1"]).toMatchObject({ points: 500, speed: 0 });
    expect(d.state.lastReveal?.perPlayer["p2"]).toMatchObject({ points: 500, speed: 0 });
    expect(speedBonus(1_000, 0, 3_000)).toBe(0);
    // The host advances an open answer window with no timer.
    const e = table({ players: 2, timerScale: 0 }).skipIntro().toDeadline().toDeadline();
    e.act("p1", { type: "answer", choice: 0 });
    e.host({ c: "forceAdvance" });
    expect(e.state.answerClosed).toBe(true);
    expect(effectsOf(e.last, "audience.close")).toHaveLength(1);
    // With speedScoring off the host note says so without blaming the timer.
    const f = table({ players: 1, options: { speedScoring: false } });
    expect(f.runner.view({ role: "host" }).hostNote).toBe("Speed bonus off");
  });
});

// ---------------------------------------------------------------------------------------------
// R5: the Showdown
// ---------------------------------------------------------------------------------------------

/** Four players: p4 last, p3 third after four questions (speed scoring off: exact numbers). */
function kettleTable(init: Partial<TableInit> = {}): TableDriver {
  const d = table({
    players: 4,
    options: { speedScoring: false, lifeline: false },
    ...init,
  }).skipIntro();
  for (let i = 1; i <= 4; i++) {
    d.playQuestion({ p1: "right", p2: "right", p3: i === 1 ? "right" : "wrong", p4: "wrong" });
  }
  expect(d.state.phase).toBe("scoreboard");
  return d;
}

describe("R5 Showdown", () => {
  it("R5: after Q4 and Q8 with 3+ players the bottom two face off while a 12 s predict poll runs", () => {
    const d = kettleTable();
    d.step();
    expect(d.state.phase).toBe("showdown");
    expect(d.state.showdown?.players).toEqual(["p4", "p3"]);
    expect(d.state.deadline).toBe(d.now + SHOWDOWN_PREDICT_MS);
    const poll = effectsOf(d.last, "audience.open")[0]?.poll;
    expect(poll).toMatchObject({
      kind: "predict",
      prompt: "Who stays cool?",
      closesAtMs: d.state.deadline,
      options: [
        { id: "p4", label: "Basil" },
        { id: "p3", label: "Clover" },
      ],
    });
    expect(fxNames(d.last)).toContain("kettle");
    expect(d.runner.view({ role: "stage" }).showdown?.q).toBeUndefined();
    d.toDeadline();
    expect(d.state.phase).toBe("showdown-answer");
    expect(d.state.deadline).toBe(d.now + 10_000 + 3_000);
    expect(effectsOf(d.last, "audience.close")[0]?.pollId).toBe(d.state.polls.predict);
    expect(d.runner.view({ role: "stage" }).showdown?.q?.options).toHaveLength(4);
    // Only the two showdown players may answer.
    expect(d.runner.act("p1", { type: "answer", choice: 0 }, d.now).err).toBe("ILLEGAL");
    expect(triviaNight.legalActions(d.state, "p1")).toEqual([]);
    expect(triviaNight.legalActions(d.state, "p4")).toHaveLength(4);
    d.act("p4", { type: "answer", choice: d.choiceFor("right") }, 2_000);
    expect(d.state.phase).toBe("showdown-answer");
    d.act("p3", { type: "answer", choice: d.choiceFor("right") }, 1_000);
    expect(d.state.phase).toBe("showdown-verdict");
    // Both right: the slower (p3) loses.
    expect(d.state.showdown?.verdict).toEqual(["p3"]);
    expect(d.state.showdown?.winner).toBe("p4");
    // Q8 runs another one; after Q12 there is none.
    d.step();
    playAll(d, 8, () => ({ p1: "right", p2: "right", p3: "wrong", p4: "wrong" }));
    expect(d.state.played.length).toBeGreaterThanOrEqual(8);
    const e = kettleTable({ options: { speedScoring: false, lifeline: false, questions: 12 } });
    let showdowns = 0;
    for (let guard = 0; guard < 80 && e.state.phase !== "final"; guard++) {
      if (e.state.phase === "showdown") showdowns += 1;
      if (e.state.phase === "category") e.playQuestion(all(ids(4), "right"));
      else e.step();
    }
    expect(showdowns).toBe(2);
  });

  it("R5: no Showdown with fewer than 3 players or with the option off (edge case: solo)", () => {
    for (const init of [
      { players: 2 },
      { players: 1 },
      { players: 4, options: { showdown: false } },
    ] as TableInit[]) {
      const d = table(init).skipIntro();
      const phases = new Set<string>();
      for (let guard = 0; guard < 80 && d.state.phase !== "final"; guard++) {
        phases.add(d.state.phase);
        if (d.state.phase === "category")
          d.playQuestion(all(ids(typeof init.players === "number" ? init.players : 0), "right"));
        else d.step();
      }
      expect(phases.has("showdown")).toBe(false);
      expect(d.state.hidden.showdownQueue).toEqual([]);
    }
  });

  it("T3: showdown selection breaks score ties by the slower total answer time", () => {
    expect(
      bottomTwo([
        { id: "a", seat: 0, score: 100, totalMs: 5_000 },
        { id: "b", seat: 1, score: 0, totalMs: 9_000 },
        { id: "c", seat: 2, score: 0, totalMs: 12_000 },
        { id: "d", seat: 3, score: 0, totalMs: 3_000 },
      ]),
    ).toEqual(["c", "b"]);
    expect(
      bottomTwo([
        { id: "a", seat: 0, score: 0, totalMs: 1 },
        { id: "b", seat: 1, score: 0, totalMs: 1 },
        { id: "c", seat: 2, score: 5, totalMs: 1 },
      ]),
    ).toEqual(["b", "a"]);
    expect(() => bottomTwo([{ id: "a", seat: 0, score: 0, totalMs: 0 }])).toThrow(RangeError);
    // Integrated: everyone wrong (all on 0): the two slowest face the kettle; a missed answer
    // counts its full window.
    const d = table({ players: 4, options: { lifeline: false } }).skipIntro();
    for (let i = 1; i <= 4; i++) {
      d.toAnswer();
      d.act("p1", { type: "answer", choice: d.choiceFor("wrong") }, 1_000);
      d.act("p2", { type: "answer", choice: d.choiceFor("wrong") }, 3_000);
      d.act("p3", { type: "answer", choice: d.choiceFor("wrong") }, 8_000);
      d.toDeadline().quiz(10, 30).step();
    }
    d.step();
    expect(d.state.phase).toBe("showdown");
    expect(d.state.showdown?.players).toEqual(["p4", "p3"]);
  });

  it("T3: the verdict matrix covers all four right/wrong combinations", () => {
    const a = (ok: boolean, ms = 1_000) => ({ id: "a", ok, ms });
    const b = (ok: boolean, ms = 2_000) => ({ id: "b", ok, ms });
    expect(showdownVerdict(a(true), b(false))).toEqual({ losers: ["b"], winner: "a" });
    expect(showdownVerdict(a(false), b(true))).toEqual({ losers: ["a"], winner: "b" });
    expect(showdownVerdict(a(false), b(false))).toEqual({ losers: ["a", "b"], winner: null });
    expect(showdownVerdict(a(true), b(true))).toEqual({ losers: ["b"], winner: "a" });
    expect(showdownVerdict(a(true, 3_000), b(true))).toEqual({ losers: ["a"], winner: "b" });
    expect(showdownVerdict(a(true, 2_000), b(true, 2_000))).toEqual({ losers: ["b"], winner: "a" });
    // Integrated: both wrong → both steamed, the predict resolves with no winner (refund).
    const d = kettleTable();
    d.step().toDeadline();
    d.act("p4", { type: "answer", choice: d.choiceFor("wrong") }, 1_000);
    d.act("p3", { type: "answer", choice: d.choiceFor("wrong") }, 1_000);
    expect(d.state.showdown?.verdict).toEqual(["p4", "p3"]);
    expect(d.state.showdown?.winner).toBeNull();
    expect(d.state.steamed).toEqual({ p4: { questionsLeft: 2 }, p3: { questionsLeft: 2 } });
    const resolve = effectsOf(d.last, "audience.resolve")[0];
    expect(resolve?.pollId).toBe(d.state.polls.predict);
    expect(resolve?.correct).toBeUndefined();
    expect(effectsOf(d.last, "score")).toEqual([]);
    // One missing answer counts as wrong (deadline).
    const e = kettleTable();
    e.step().toDeadline();
    e.act("p4", { type: "answer", choice: e.choiceFor("wrong") }, 1_000);
    e.toDeadline();
    expect(e.state.phase).toBe("showdown-verdict");
    expect(e.state.showdown?.verdict).toEqual(["p4", "p3"]);
    expect(e.state.showdown?.results?.["p3"]).toEqual({ ok: false, ms: -1, choice: null });
  });

  it("T4: the Showdown winner gets +750; Steamed ×0.5 lasts exactly the next 2 questions, right or wrong", () => {
    const d = kettleTable();
    const before = { ...d.state.scores };
    d.step().toDeadline();
    d.act("p4", { type: "answer", choice: d.choiceFor("right") }, 1_000);
    d.act("p3", { type: "answer", choice: d.choiceFor("wrong") }, 1_000);
    expect(d.state.showdown?.winner).toBe("p4");
    expect(d.state.scores["p4"]).toBe((before["p4"] ?? 0) + COOL_HEAD_POINTS);
    expect(effectsOf(d.last, "score")[0]?.deltas).toEqual({ p4: 750 });
    expect(effectsOf(d.last, "audience.resolve")[0]).toMatchObject({ correct: "p4" });
    expect(fxNames(d.last)).toEqual(expect.arrayContaining(["steam", "coolHead"]));
    expect(d.state.steamed).toEqual({ p3: { questionsLeft: 2 } });
    d.step(); // verdict -> Q5
    // Q5: p3 right → half points (no streak before: 500 → 250).
    d.playToReveal({ p1: "right", p2: "right", p3: "right", p4: "right" });
    expect(d.state.lastReveal?.perPlayer["p3"]).toMatchObject({
      ok: true,
      points: 250,
      halved: true,
    });
    expect(d.state.lastReveal?.perPlayer["p4"]).toMatchObject({ points: 500, halved: false });
    expect(d.state.steamed["p3"]).toEqual({ questionsLeft: 1 });
    expect(d.state.lastReveal?.cooledOff).toEqual([]);
    d.step();
    // Q6: p3 wrong → 0, and the status expires with "Cooled off!".
    d.playToReveal({ p1: "right", p2: "right", p3: "wrong", p4: "right" });
    expect(d.state.lastReveal?.perPlayer["p3"]).toMatchObject({
      ok: false,
      points: 0,
      halved: false,
    });
    expect(d.state.steamed["p3"]).toBeUndefined();
    expect(d.state.lastReveal?.cooledOff).toEqual(["p3"]);
    expect(fxNames(d.last)).toContain("cooledOff");
    d.step();
    // Q7: full points again.
    d.playToReveal({ p1: "right", p2: "right", p3: "right", p4: "right" });
    expect(d.state.lastReveal?.perPlayer["p3"]).toMatchObject({ points: 500, halved: false });
    // Steamed halves the whole question score, streak included.
    expect(
      scoreAnswer({
        correct: true,
        t: 0,
        window: { windowMs: 20_000, delayMs: 3_000 },
        streakBefore: 2,
        steamed: true,
      }),
    ).toMatchObject({ points: 600, speed: 500, streak: 200, halved: true });
  });
});

// ---------------------------------------------------------------------------------------------
// R6: the lifeline
// ---------------------------------------------------------------------------------------------

/** Four players at the Q4 scoreboard with p4 on the lowest score. */
function lifelineTable(init: Partial<TableInit> = {}): TableDriver {
  const d = table({
    players: 4,
    options: { speedScoring: false, showdown: false },
    ...init,
  }).skipIntro();
  for (let i = 1; i <= 4; i++) {
    d.playQuestion({
      p1: "right",
      p2: i % 2 ? "right" : "wrong",
      p3: i === 1 ? "right" : "wrong",
      p4: "wrong",
    });
  }
  d.step();
  expect(d.state.phase).toBe("lifeline-vote");
  return d;
}

const votes = (d: TableDriver, tallies: Record<string, number>, extra: Partial<PollResult> = {}) =>
  d.audience({
    pollId: d.state.polls.vote,
    kind: "vote",
    total: Object.values(tallies).reduce((a, b) => a + b, 0),
    tallies,
    ...extra,
  });

describe("R6 lifeline", () => {
  it("R6: once per game after Q4 a 12 s audience vote over all players picks the plurality player", () => {
    const d = lifelineTable();
    expect(d.state.deadline).toBe(d.now + LIFELINE_MS);
    const poll = effectsOf(d.last, "audience.open")[0]?.poll;
    expect(poll).toMatchObject({
      kind: "vote",
      prompt: "Give a 50/50 to…",
      closesAtMs: d.state.deadline,
    });
    expect(poll?.options?.map((o) => o.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(d.state.lifeline.status).toBe("voting");
    // Tie between p3 and p4: the lower score (p4) gets it.
    votes(d, { p1: 1, p3: 10, p4: 10 });
    expect(d.state.lifeline).toEqual({ status: "granted", recipient: "p4", question: 5 });
    expect(fxNames(d.last)).toContain("lifeline");
    expect(d.state.phase).toBe("category");
    expect(d.state.index).toBe(5);
    expect(
      lifelineRecipient({ a: 2, b: 2 }, [
        { id: "a", seat: 1, score: 5 },
        { id: "b", seat: 0, score: 5 },
      ]),
    ).toBe("b");
    expect(lifelineRecipient({}, [{ id: "a", seat: 0, score: 0 }])).toBeNull();
    // It never runs again.
    playAll(d, 8, () => all(ids(4), "right"));
    expect(d.state.lifeline.status).toBe("granted");
  });

  it("T5: the lifeline removes two wrong options on the recipient's phone only, for the next question", () => {
    const d = lifelineTable();
    votes(d, { p4: 9 });
    const correct = d.state.hidden.correct as number;
    const removed = d.state.hidden.lifelineRemoved?.remove as [number, number];
    expect(d.state.hidden.lifelineRemoved?.player).toBe("p4");
    expect(removed).toHaveLength(2);
    expect(removed).not.toContain(correct);
    expect(removed[0]).toBeLessThan(removed[1]);
    const youRemoved = (id: string) => d.runner.view({ role: "player", id }).you?.removed ?? null;
    expect(youRemoved("p4")).toBeNull(); // category: options not shown yet
    d.toAnswer();
    expect(youRemoved("p4")).toEqual(removed);
    for (const other of ["p1", "p2", "p3"]) expect(youRemoved(other)).toBeNull();
    for (const viewer of [{ role: "stage" }, { role: "host" }, { role: "audience" }] as const) {
      const v = d.runner.view(viewer);
      expect(v.you).toBeNull();
      expect(JSON.stringify(v)).not.toContain("removed");
    }
    expect(d.runner.view({ role: "stage" }).options).toEqual(d.state.hidden.item?.options);
    // The bot playing the recipient never picks a removed option.
    for (let s = 0; s < 50; s++) {
      const a = botAction(d.state, "p4", createRng(s));
      expect(removed).not.toContain(a?.choice);
    }
    d.answers(all(ids(4), "right")).quiz(10, 50);
    expect(youRemoved("p4")).toEqual(removed);
    d.step();
    expect(d.state.index).toBe(6);
    expect(d.state.hidden.lifelineRemoved).toBeUndefined();
    d.toAnswer();
    expect(youRemoved("p4")).toBeNull();
  });

  it("R6: the vote counts only with at least audienceMin voters (or the platform's counted flag)", () => {
    const low = lifelineTable();
    votes(low, { p2: AUDIENCE_MIN - 1 });
    expect(low.state.lifeline).toEqual({ status: "none", recipient: null, question: null });
    const flagged = lifelineTable();
    votes(flagged, { p2: 2 }, { counted: true } as Partial<PollResult>);
    expect(flagged.state.lifeline.recipient).toBe("p2");
    const unflagged = lifelineTable();
    votes(unflagged, { p2: 200 }, { counted: false } as Partial<PollResult>);
    expect(unflagged.state.lifeline.status).toBe("none");
    // No result at all: the vote times out after its grace.
    const silent = lifelineTable();
    silent.step();
    expect(silent.state.lifeline.status).toBe("none");
    expect(silent.state.phase).toBe("category");
    // The host can cut it short.
    const host = lifelineTable();
    host.host({ c: "forceAdvance" });
    expect(host.state.lifeline.status).toBe("none");
    expect(host.runner.openPolls().find((p) => p.spec.kind === "vote")?.closing).toBe(true);
  });

  it("R6: no lifeline when the option is off or with one player (edge case: solo)", () => {
    for (const init of [
      { players: 4, options: { lifeline: false } },
      { players: 1 },
    ] as TableInit[]) {
      const d = table(init).skipIntro();
      const n = typeof init.players === "number" ? init.players : 0;
      for (let i = 1; i <= 4; i++) d.playQuestion(all(ids(n), "right"));
      expect(d.state.phase).toBe("scoreboard");
      d.step();
      expect(d.state.phase).not.toBe("lifeline-vote");
      expect(d.state.lifeline.status).toBe("unused");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// R7: breaks and team mode
// ---------------------------------------------------------------------------------------------

describe("R7 breaks and teams", () => {
  it("R7: scoreboard breaks (4000) come after questions 4, 8 and 12", () => {
    const d = table({ players: 2 }).skipIntro();
    const breaks: number[] = [];
    for (let guard = 0; guard < 80 && d.state.phase !== "final"; guard++) {
      if (d.state.phase === "scoreboard") {
        breaks.push(d.state.index);
        expect(d.state.deadline).toBe(d.now + SCOREBOARD_MS);
        expect(fxNames(d.last)).toContain("scores");
      }
      if (d.state.phase === "category") d.playQuestion(all(ids(2), "right"));
      else d.step();
    }
    expect(breaks).toEqual([4, 8, 12]);
    const view = d.runner.view({ role: "stage" });
    expect(view.chatVsPlayers.chatPct).toBe(60);
    expect(view.chatVsPlayers.playersPct).toBe(100);
  });

  const TEAMS = [
    { id: "tomato", name: "Tomato", colorSlot: 0 },
    { id: "sky", name: "Sky", colorSlot: 1 },
    { id: "sunflower", name: "Sunflower", colorSlot: 2 },
  ];

  it("R7: in team mode a team's score is the sum of its members' and its answer is their plurality", () => {
    const d = table({
      players: scenarioSeats(6, ["tomato", "sky"]),
      teams: TEAMS,
      options: { speedScoring: false },
    }).skipIntro();
    // Edge case: the empty team (Sunflower) is excluded.
    expect(d.state.teams.map((t) => t.id)).toEqual(["tomato", "sky"]);
    expect(d.state.teams[0]?.members).toEqual(["p1", "p3", "p5"]);
    d.toAnswer();
    // Tomato: p1 right (first), p3 wrong, p5 silent → tie, earliest vote (p1) wins → right.
    // Sky: p2 wrong, p4 wrong, p6 right → plurality wrong.
    d.answers({ p1: "right", p3: "wrong", p2: "wrong", p4: "wrong", p6: "right" });
    expect(d.state.answerClosed).toBe(false);
    d.toDeadline().quiz(30, 50);
    const r = d.state.lastReveal;
    const correct = d.state.hidden.correct as number;
    expect(r?.teamAnswers).toEqual({ tomato: correct, sky: (correct + 1) % 4 });
    expect(r?.perPlayer["p1"]?.points).toBe(500);
    expect(r?.perPlayer["p3"]).toMatchObject({ ok: true, points: 500, choice: (correct + 1) % 4 });
    expect(r?.perPlayer["p5"]).toMatchObject({ ok: false, points: 0 });
    expect(r?.perPlayer["p6"]).toMatchObject({ ok: false, points: 0 });
    expect(d.state.teamScores).toEqual({ tomato: 1_000, sky: 0 });
    expect(effectsOf(d.last, "score")[0]?.deltas).toEqual({ tomato: 1_000 });
    expect(d.runner.view({ role: "stage" }).standings.map((s) => s.id)).toEqual(["tomato", "sky"]);
    expect(pluralityAnswer([])).toBeNull();
    expect(
      pluralityAnswer([
        { choice: 2, at: 5 },
        { choice: 1, at: 3 },
        { choice: 2, at: 9 },
      ]),
    ).toBe(2);
    expect(
      pluralityAnswer([
        { choice: 2, at: 5 },
        { choice: 1, at: 3 },
      ]),
    ).toBe(1);
    expect(
      pluralityAnswer([
        { choice: 1, at: 7 },
        { choice: 3, at: 2 },
        { choice: 1, at: 4 },
        { choice: 3, at: 9 },
      ]),
    ).toBe(3);
    expect(teamTotals([{ id: "t", members: ["a", "b"] }], { a: 3, b: 4 })).toEqual({ t: 7 });
  });

  it("R7: the team answer is fixed when every member has locked", () => {
    const d = table({ players: scenarioSeats(4, ["tomato", "sky"]), teams: TEAMS })
      .skipIntro()
      .toAnswer();
    d.answers({ p1: "right", p2: "wrong", p3: "right" });
    expect(d.state.answerClosed).toBe(false);
    d.answers({ p4: "wrong" });
    expect(d.state.answerClosed).toBe(true);
  });

  it("R7: team mode needs every seat on a team and two non-empty teams", () => {
    const partial = scenarioSeats(4, ["tomato", "sky"]);
    delete partial[3]?.teamId;
    expect(table({ players: partial, teams: TEAMS }).state.teams).toEqual([]);
    expect(table({ players: scenarioSeats(3, ["tomato"]), teams: TEAMS }).state.teams).toEqual([]);
    // Teams the room did not describe get their id as name.
    const odd = table({ players: scenarioSeats(4, ["red", "blue"]), teams: [] }).state.teams;
    expect(odd.map((t) => [t.id, t.name, t.colorSlot])).toEqual([
      ["red", "red", 0],
      ["blue", "blue", 1],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// R8: the end
// ---------------------------------------------------------------------------------------------

describe("R8 end", () => {
  it("R8: ranking by score; ties by lower total correct-answer time, then by seat", () => {
    expect(
      rankEntries([
        { id: "a", score: 10, correctMs: 900, seat: 0 },
        { id: "b", score: 10, correctMs: 500, seat: 1 },
        { id: "c", score: 20, correctMs: 9_000, seat: 2 },
        { id: "d", score: 10, correctMs: 500, seat: 0 },
      ]),
    ).toEqual([
      { id: "c", score: 20, place: 1 },
      { id: "d", score: 10, place: 2 },
      { id: "b", score: 10, place: 3 },
      { id: "a", score: 10, place: 4 },
    ]);
    // Integrated: equal scores, p2 answers faster every time → p2 first.
    const d = table({ players: 2, options: { questions: 6, speedScoring: false } }).skipIntro();
    for (let i = 0; i < 6; i++) {
      d.toAnswer();
      d.act("p2", { type: "answer", choice: d.choiceFor("right") }, 1_000);
      d.act("p1", { type: "answer", choice: d.choiceFor("right") }, 1_000);
      d.quiz(10, 70).step();
      if (d.state.phase === "scoreboard") d.step();
      if (d.state.phase === "lifeline-vote") d.step();
    }
    expect(d.state.phase).toBe("final");
    expect(d.state.winners).toEqual(["p2"]);
    expect(fxNames(d.last)).toContain("win");
    d.step();
    const end = effectsOf(d.last, "end")[0];
    expect(end?.result.ranking).toEqual([
      { id: "p2", score: 4_200, place: 1 },
      { id: "p1", score: 4_200, place: 2 },
    ]);
    expect(end?.result.highlights).toEqual(
      expect.arrayContaining([
        { label: "6 right in a row", playerId: "p2" },
        { label: "Chat 70% · Players 100%" },
      ]),
    );
    expect(d.runner.ended).toBe(true);
    expect(finalRanking(d.state)[0]?.id).toBe("p2");
  });

  it("R8: team mode ranks teams (and a Cool Head highlight names the winner)", () => {
    const d = table({
      players: scenarioSeats(6, ["tomato", "sky"]),
      teams: [
        { id: "tomato", name: "Tomato", colorSlot: 0 },
        { id: "sky", name: "Sky", colorSlot: 1 },
      ],
      options: { questions: 6 },
    }).skipIntro();
    playAll(d, 6, () => ({
      p1: "right",
      p3: "right",
      p5: "right",
      p2: "wrong",
      p4: "wrong",
      p6: "wrong",
    }));
    d.toPhase("final").step();
    const end = effectsOf(d.last, "end")[0];
    expect(end?.result.ranking.map((r) => r.id)).toEqual(["tomato", "sky"]);
    expect(end?.result.highlights?.some((h) => h.label === "Cool Head")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Host commands, reconnects, robustness
// ---------------------------------------------------------------------------------------------

describe("host commands and robustness", () => {
  it("forceAdvance moves every phase on", () => {
    const d = table({ players: 4, options: { speedScoring: false } });
    const seen: string[] = [];
    for (let guard = 0; guard < 200 && !d.runner.ended; guard++) {
      seen.push(d.state.phase);
      if (d.state.phase === "answer" && d.state.answered.length === 0) {
        d.act("p1", { type: "answer", choice: 0 });
      }
      d.host({ c: "forceAdvance" });
    }
    expect(d.runner.ended).toBe(true);
    expect(new Set(seen)).toEqual(
      new Set([
        "intro",
        "category",
        "read",
        "answer",
        "reveal",
        "scoreboard",
        "lifeline-vote",
        "showdown",
        "showdown-answer",
        "showdown-verdict",
        "final",
      ]),
    );
  });

  it("skipItem swaps the current question for a spare, or voids it when none is left", () => {
    const d = table({ players: 2 }).skipIntro().toAnswer();
    const first = d.state.current?.id as string;
    d.act("p1", { type: "answer", choice: 0 });
    d.host({ c: "skipItem", itemId: "not-this-one" });
    expect(d.state.current?.id).toBe(first);
    const quizId = d.state.polls.quiz;
    d.host({ c: "skipItem", itemId: first });
    expect(closing(d, quizId)).toBe(true);
    expect(fxNames(d.last)).toContain("skipped");
    expect(d.state.phase).toBe("category");
    expect(d.state.index).toBe(1);
    expect(d.state.current?.id).not.toBe(first);
    expect(d.state.hidden.answers).toEqual({});
    expect(d.state.played.map((p) => p.id)).not.toContain(first);
    expect(d.state.total).toBe(12);
    // Spares run out: the question is voided and the game gets shorter.
    for (let i = 0; i < 3; i++) d.host({ c: "skipItem", itemId: d.state.current?.id as string });
    expect(d.state.total).toBe(11);
    expect(d.state.index).toBe(1);
    // Not skippable outside category/read/answer.
    d.toAnswer()
      .answers(all(ids(2), "right"))
      .quiz(5, 5);
    const s = d.state;
    d.host({ c: "skipItem", itemId: s.current?.id as string });
    expect(d.state).toBe(s);
  });

  it("the game ends early when voided questions empty the queue", () => {
    const d = table({ players: 1, options: { questions: 6 } }).skipIntro();
    for (let guard = 0; guard < 40 && d.state.phase !== "final"; guard++) {
      d.host({ c: "skipItem", itemId: d.state.current?.id as string });
    }
    expect(d.state.phase).toBe("final");
    expect(d.state.total).toBe(0);
  });

  it("the quiz result is waited for briefly after an early end, then the reveal runs without it", () => {
    const d = table({ players: 2 }).skipIntro().toAnswer();
    d.answers(all(ids(2), "right"));
    expect(d.state.phase).toBe("answer");
    expect(d.state.answerClosed).toBe(true);
    d.wait(14_000);
    expect(d.state.phase).toBe("reveal");
    expect(d.state.lastReveal?.audiencePct).toBeUndefined();
    // A quiz result that arrives before the window closes is kept for the reveal.
    const e = table({ players: 2 }).skipIntro().toAnswer();
    e.quiz(100, 25);
    expect(e.state.phase).toBe("answer");
    e.answers(all(ids(2), "wrong"));
    expect(e.state.phase).toBe("reveal");
    expect(e.state.lastReveal?.audiencePct?.[e.state.hidden.correct as number]).toBe(25);
    expect(e.state.lastReveal?.audienceTotal).toBe(100);
    // Stale or foreign poll results change nothing.
    const s = e.state;
    e.audience({ pollId: "nope", kind: "quiz", total: 3, tallies: {} });
    expect(e.state).toBe(s);
    e.audience({ pollId: s.polls.quiz, kind: "quiz", total: 3, tallies: {} });
    expect(e.state).toBe(s);
    expect(percentages({ "0": 1, "1": 3 }, 4)).toEqual([25, 75, 0, 0]);
    expect(percentages({}, 4)).toEqual([0, 0, 0, 0]);
  });

  it("stale timers are ignored and reconnects are tracked", () => {
    const d = table({ players: 3 });
    const s = d.state;
    expect(triviaNight.onTimer?.(s, "nope#99", ctxAt(0)).state).toBe(s);
    const armed = { ...s, timers: ["mystery#1"] };
    expect(triviaNight.onTimer?.(armed, "mystery#1", ctxAt(0)).state).toBe(armed);
    expect(triviaNight.onPlayerLeave?.(s, "zz", ctxAt(0)).state).toBe(s);
    expect(triviaNight.onPlayerRejoin?.(s, "p1", ctxAt(0)).state).toBe(s);
    d.runner.playerLeave("p2", d.now);
    expect(d.state.players[1]?.connected).toBe(false);
    d.runner.playerRejoin("p2", d.now);
    expect(d.state.players[1]?.connected).toBe(true);
    // A showdown player leaving after the other one locked ends the showdown.
    const k = kettleTable();
    k.step().toDeadline();
    k.act("p4", { type: "answer", choice: k.choiceFor("right") });
    k.runner.playerLeave("p3", k.now);
    expect(k.state.phase).toBe("showdown-verdict");
    expect(k.state.showdown?.verdict).toEqual(["p3"]);
  });

  it("serialize round-trips and setup is deterministic per seed", () => {
    const a = table({ players: 5, seed: 42 }).skipIntro().toAnswer();
    expect(triviaNight.deserialize(triviaNight.serialize(a.state))).toEqual(a.state);
    const b = table({ players: 5, seed: 42 }).skipIntro().toAnswer();
    expect(b.state).toEqual(a.state);
    const direct = triviaNight.setup(setupCtx({}));
    expect(direct.state.phase).toBe("intro");
    expect(effectsOf(direct.effects, "timer.set")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Views and bot
// ---------------------------------------------------------------------------------------------

describe("views and bot", () => {
  it("a player sees their own lock and choice; others see only who has locked", () => {
    const d = table({ players: 3 }).skipIntro().toAnswer();
    d.act("p1", { type: "answer", choice: 3 });
    const mine = d.runner.view({ role: "player", id: "p1" });
    expect(mine.you).toMatchObject({
      locked: true,
      choice: 3,
      canAnswer: false,
      inShowdown: false,
    });
    const other = d.runner.view({ role: "player", id: "p2" });
    expect(other.you).toMatchObject({ locked: false, choice: null, canAnswer: true });
    expect(other.answered).toEqual(["p1"]);
    const stage = d.runner.view({ role: "stage" });
    expect(stage.answered).toEqual(["p1"]);
    expect(stage.inputMs).toBe(23_000);
    expect(stage.lastReveal).toBeNull();
    expect(JSON.stringify(stage)).not.toContain('"choice":3');
    expect(d.runner.view({ role: "player", id: "zz" }).you).toBeNull();
    d.answers({ p2: "right", p3: "right" }).quiz(40, 50);
    expect(d.runner.view({ role: "player", id: "p1" }).you?.last?.choice).toBe(3);
    expect(d.runner.view({ role: "stage" }).inputMs).toBeNull();
  });

  it("involves marks reveals, breaks and the Showdown pair (G14 player idle)", () => {
    const d = kettleTable();
    expect(involves(d.state, "p1")).toBe(true);
    d.step();
    expect(involves(d.state, "p4")).toBe(true);
    expect(involves(d.state, "p1")).toBe(false);
    d.toDeadline().toDeadline();
    expect(d.state.phase).toBe("showdown-verdict");
    expect(involves(d.state, "p3")).toBe(true);
    d.step();
    expect(involves(d.state, "p1")).toBe(false);
  });

  it("the bot answers only when it may, right more often on easy questions", () => {
    const d = table({ players: 2 }).skipIntro();
    expect(botAction(d.state, "p1", createRng(1))).toBeNull();
    d.toAnswer();
    const correct = d.state.hidden.correct as number;
    let right = 0;
    for (let s = 0; s < 400; s++) {
      const a = botAction(d.state, "p1", createRng(s));
      expect(a?.type).toBe("answer");
      if (a?.choice === correct) right += 1;
    }
    const acc = BOT_ACCURACY[d.state.current?.difficulty ?? 1];
    expect(right / 400).toBeGreaterThan(acc - 0.1);
    expect(right / 400).toBeLessThan(acc + 0.1);
    expect(botChoice(1, 1, [0, 2, 3], createRng(1))).toBe(1);
    expect(botChoice(1, 0, [0, 2, 3], createRng(1))).toBe(1);
    expect(botChoice(1, 0, [], createRng(1))).not.toBe(1);
    // In the Showdown only the two players have an answer to give.
    const k = kettleTable();
    k.step().toDeadline();
    expect(botAction(k.state, "p1", createRng(1))).toBeNull();
    expect(botAction(k.state, "p4", createRng(1))?.type).toBe("answer");
  });
});

// ---------------------------------------------------------------------------------------------
// T9, T12, scenarios
// ---------------------------------------------------------------------------------------------

describe("T9 secrecy", () => {
  it("T9: correct answers never appear in any view before the reveal (fuzz over bot games)", () => {
    const presets: [number | ReturnType<typeof scenarioSeats>, Partial<TnOptions>][] = [
      [1, {}],
      [3, {}],
      [5, { speedScoring: false }],
      [10, { questions: 8 }],
      [scenarioSeats(6, ["tomato", "sky"]), {}],
    ];
    let states = 0;
    for (const [players, options] of presets) {
      for (let seed = 1; seed <= 8; seed++) {
        const r = simulateGame(triviaNight, {
          seed,
          players,
          options,
          content: testContent,
          onStep: ({ state }) => {
            states += 1;
            const problems = secrecyProblems(state);
            if (problems.length > 0) throw new Error(problems.join("; "));
          },
        });
        expect(r.ended, r.failure).toBe(true);
      }
    }
    expect(states).toBeGreaterThan(3_000);
  }, 120_000);

  it("T9: a view's JSON never carries the current correct index before the reveal", () => {
    const d = table({ players: 3 }).skipIntro();
    for (const phase of ["category", "read", "answer"] as const) {
      if (d.state.phase !== phase) d.toDeadline();
      for (const viewer of [
        { role: "stage" },
        { role: "host" },
        { role: "audience" },
        { role: "player", id: "p1" },
      ] as const) {
        const json = JSON.stringify(triviaNight.view(d.state, viewer));
        expect(json).not.toContain('"correct"');
      }
    }
  });
});

describe("T12 bots finish every mode", () => {
  it("T12: bots finish Classic games with 1–10 players (Bluff and Mixed arrive with M4-01b)", () => {
    for (let players = 1; players <= 10; players++) {
      for (const options of [{}, { questions: 6 }, { questions: 20 }] as Partial<TnOptions>[]) {
        const r = simulateGame(triviaNight, {
          seed: players * 7,
          players,
          options,
          content: testContent,
        });
        expect(r.ended, `${players}p ${r.failure ?? ""}`).toBe(true);
        expect(r.illegalActions, r.illegalSamples.join("; ")).toBe(0);
        expect(r.steps).toBeLessThanOrEqual(1_500);
        expect(r.result?.ranking).toHaveLength(players);
      }
    }
  }, 120_000);
});

describe("scenarios", () => {
  const byId = (id: string, seed = 1, role: "stage" | "player" | "audience" = "stage") =>
    resolveScenario(triviaNight, scenarios, { state: id, seed, role });

  it("every spec scenario builds a real state with the spec's hero animation", () => {
    for (const seed of [1, 2, 3]) {
      const category = byId("category", seed);
      expect(category.state.phase).toBe("category");
      expect(category.view.category).toBe("Geography");
      expect(category.view.index).toBe(5);
      expect(category.view.total).toBe(12);
      const answering = byId("answering", seed, "player");
      expect(answering.state.phase).toBe("answer");
      expect(answering.view.answered).toHaveLength(3);
      expect(answering.view.deadline).not.toBeNull();
      expect(answering.view.you?.canAnswer).toBe(true);
      expect(Object.keys(answering.state.steamed)).toHaveLength(1);
      const reveal = byId("reveal", seed);
      expect(reveal.view.lastReveal?.correct).toBe(2);
      expect(reveal.view.lastReveal?.audiencePct?.[2]).toBe(64);
      expect(byId("scoreboard", seed).state.phase).toBe("scoreboard");
      const showdown = byId("showdown", seed, "audience");
      expect(showdown.state.phase).toBe("showdown");
      expect(showdown.fx[0]?.name).toBe("tally");
      const verdict = byId("showdown-verdict", seed);
      expect(verdict.view.showdown?.verdict).toHaveLength(1);
      expect(Object.keys(verdict.state.steamed)).toHaveLength(1);
      const final = byId("final", seed);
      expect(final.state.phase).toBe("final");
      expect(final.view.winners).toHaveLength(1);
    }
    expect(scenarios["category"]?.anim).toEqual({ name: "flip", durationMs: 600 });
    expect(scenarios["reveal"]?.anim).toEqual({ name: "reveal", durationMs: 1200 });
    expect(scenarios["scoreboard"]?.anim).toEqual({ name: "scores", durationMs: 1000 });
    expect(scenarios["showdown-verdict"]?.anim).toEqual({ name: "steam", durationMs: 1500 });
    expect(scenarios["final"]?.anim).toEqual({ name: "win", durationMs: 2000 });
  });

  it("every registered scenario builds for every role with no secret in the stage view", () => {
    for (const id of Object.keys(scenarios)) {
      for (const role of ["stage", "host", "player", "audience"] as const) {
        const r = resolveScenario(triviaNight, scenarios, { state: id, seed: 4, role });
        expect(r.view.phase).toBe(r.state.phase);
        expect(secrecyProblems(r.state), id).toEqual([]);
      }
    }
    const lifeline = byId("answering-lifeline", 1, "player");
    expect(lifeline.view.you?.removed).toHaveLength(2);
    const noTimer = byId("answering-no-timer");
    expect(noTimer.view.deadline).toBeNull();
    expect(noTimer.view.speedBonus).toBe(false);
    expect(byId("team-reveal").view.lastReveal?.teamAnswers).toBeDefined();
  });
});
